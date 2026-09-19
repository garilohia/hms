import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";

vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/integrations/sync", () => ({ syncIntegration: vi.fn() }));
import { syncIntegration } from "@/src/lib/integrations/sync";
import { syncDueIntegrations } from "@/src/lib/integrations/scheduled";
import { ProviderBudgetDeferredError } from "@/src/lib/integrations/request-budget";

const start = Date.parse("2026-09-19T12:00:00Z");

function database(subjects: string[]) {
  const pending = [...subjects];
  const unsafe = vi.fn(async (sql: string) => {
    if (!sql.startsWith("select c.user_id")) return [];
    const userId = pending.shift();
    return userId ? [{ user_id: userId, owner_account_id: `owner-${userId}`, provider: "whoop" }] : [];
  });
  const db = { unsafe, begin: (work: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => work({ unsafe }) } as unknown as postgres.Sql;
  return { db, unsafe };
}

describe("scheduled provider work sharing", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it("shares the tick across three connections even when each uses its whole slice", async () => {
    const { db, unsafe } = database(["a", "b", "c", "d"]);
    vi.mocked(syncIntegration).mockImplementation(async (_actor, _subject, _provider, options) => {
      expect(options?.maxPages).toBe(3);
      expect(options?.deadline).toBe(start + 25_000);
      expect(options?.startDeadline).toBe(Date.now() + 8_000);
      vi.setSystemTime(options!.startDeadline!);
      options?.onPageComplete?.();
      return { inserted: 1, skipped: 0, complete: false, syncedThrough: null };
    });
    expect(await syncDueIntegrations(db, { limit: 3 })).toEqual({ inserted: 3, synced: 0, queued: 3, failed: 0 });
    expect(vi.mocked(syncIntegration).mock.calls.map(call => call[1])).toEqual(["a", "b", "c"]);
    expect(Date.now()).toBe(start + 24_000);
    const releases = unsafe.mock.calls.filter(([sql]) => sql.includes("sync_locked_until=null"));
    expect(releases).toHaveLength(3);
    for (const [sql] of releases) {
      expect(sql).toContain("c.sync_locked_until=$5");
      expect(sql).toContain("s.status='connected'");
      expect(sql).toContain("ProviderRateLimited");
      expect(sql).toContain("greatest(c.next_sync_at,$1)");
    }
  });

  it("puts a no-progress tail connection ahead of serviced users on the next tick", async () => {
    const rows = ["a", "b", "c"].map(userId => ({ userId, due: start, locked: false }));
    const unsafe = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("select c.user_id")) {
        const row = rows.filter(row => !row.locked && row.due <= (values[0] as Date).getTime()).sort((a, b) => a.due - b.due || a.userId.localeCompare(b.userId))[0];
        return row ? [{ user_id: row.userId, owner_account_id: `owner-${row.userId}`, provider: "whoop" }] : [];
      }
      if (sql.includes("set sync_locked_until=$1")) rows.find(row => row.userId === values[1])!.locked = true;
      if (sql.includes("set sync_locked_until=null")) {
        const row = rows.find(row => row.userId === values[2])!;
        row.locked = false; row.due = Math.max(row.due, (values[0] as Date).getTime());
      }
      return [];
    });
    const db = { unsafe, begin: (work: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => work({ unsafe }) } as unknown as postgres.Sql;
    vi.mocked(syncIntegration).mockImplementation(async (_actor, subject, _provider, options) => {
      if (subject === "c") vi.setSystemTime(start + 25_000);
      else { vi.setSystemTime(Date.now() + 8_000); options?.onPageComplete?.(); }
      return { inserted: 0, skipped: 0, complete: false, syncedThrough: null };
    });
    await syncDueIntegrations(db, { limit: 3 });
    expect(vi.mocked(syncIntegration).mock.calls.map(call => call[1])).toEqual(["a", "b", "c"]);
    expect(rows.find(row => row.userId === "c")?.due).toBe(start + 16_000);
    vi.setSystemTime(start + 60_000);
    vi.mocked(syncIntegration).mockResolvedValue({ inserted: 0, skipped: 0, complete: false, syncedThrough: null });
    await syncDueIntegrations(db, { limit: 1 });
    expect(vi.mocked(syncIntegration).mock.calls[3][1]).toBe("c");
    expect(syncIntegration).toHaveBeenCalledTimes(4);
  });

  it("does not claim another connection after in-flight work exhausts the shared budget", async () => {
    const { db } = database(["a", "b"]);
    vi.mocked(syncIntegration).mockImplementation(async () => {
      vi.setSystemTime(start + 25_000);
      return { inserted: 0, skipped: 0, complete: false, syncedThrough: null };
    });
    expect(await syncDueIntegrations(db, { limit: 3 })).toMatchObject({ queued: 1 });
    expect(syncIntegration).toHaveBeenCalledOnce();
  });

  it("preserves an active persisted vendor cooldown instead of replacing it with five minutes", async () => {
    const { db, unsafe } = database(["a"]);
    vi.mocked(syncIntegration).mockRejectedValueOnce(new Error("provider throttled"));
    expect(await syncDueIntegrations(db)).toMatchObject({ failed: 1 });
    const failure = unsafe.mock.calls.find(([sql]) => sql.includes("else $6 end"))?.[0];
    expect(failure).toContain("when c.last_error in ('ProviderRateLimited','ProviderBudgetQueued') and c.next_sync_at>$2 then c.next_sync_at");
    expect(failure).toContain("c.sync_locked_until=$5");
    expect(failure).toContain("s.status='connected'");
  });

  it("queues local allowance denial at its retry time rather than counting a provider failure", async () => {
    const { db, unsafe } = database(["a"]);
    const retryAt = new Date(start + 10_000);
    vi.mocked(syncIntegration).mockRejectedValueOnce(new ProviderBudgetDeferredError(retryAt));
    expect(await syncDueIntegrations(db)).toEqual({ inserted: 0, queued: 1, synced: 0, failed: 0 });
    const release = unsafe.mock.calls.find(([sql]) => sql.includes("else $6 end"));
    // The scheduler and DB driver pass these parameters even though this mock
    // only needs SQL text to answer claims.
    const args = release as unknown as [string, unknown[]];
    expect(args[1][0]).toEqual(retryAt);
    expect(args[1][5]).toBe("ProviderBudgetQueued");
  });

  it.each([1000, 900_000])("preserves a %s ms allowance delay and leaves earlier slots for unserved users", async delay => {
    const { db, unsafe } = database(["a"]);
    vi.mocked(syncIntegration).mockImplementationOnce(async (_actor, _subject, _provider, options) => {
      options?.onPageComplete?.();
      throw new ProviderBudgetDeferredError(new Date(start + delay));
    });
    expect(await syncDueIntegrations(db)).toMatchObject({ queued: 1, failed: 0 });
    const release = unsafe.mock.calls.find(([sql]) => sql.includes("else $6 end")) as unknown as [string, unknown[]];
    expect(release[1][0]).toEqual(new Date(start + Math.max(60_000, delay)));
    expect(release[1][6]).toBe(true);
    expect(release[0]).toContain("when $7::boolean then greatest(c.next_sync_at,$1)");
  });

  it("lets an unserved account lead the next tick after shared allowance exhaustion", async () => {
    const rows = ["a", "b", "c"].map(userId => ({ userId, due: start, locked: false }));
    const unsafe = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("select c.user_id")) {
        const row = rows.filter(row => !row.locked && row.due <= (values[0] as Date).getTime()).sort((a, b) => a.due - b.due || a.userId.localeCompare(b.userId))[0];
        return row ? [{ user_id: row.userId, owner_account_id: `owner-${row.userId}`, provider: "google_health" }] : [];
      }
      if (sql.includes("set sync_locked_until=$1")) rows.find(row => row.userId === values[1])!.locked = true;
      if (sql.includes("set sync_locked_until=null")) {
        const row = rows.find(row => row.userId === values[2])!;
        row.locked = false; row.due = Math.max(row.due, (values[0] as Date).getTime());
      }
      return [];
    });
    const db = { unsafe, begin: (work: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => work({ unsafe }) } as unknown as postgres.Sql;
    vi.mocked(syncIntegration).mockImplementation(async (_actor, userId, _provider, options) => {
      if (userId === "a") options?.onPageComplete?.();
      throw new ProviderBudgetDeferredError(new Date(start + 1000));
    });
    expect(await syncDueIntegrations(db, { limit: 3 })).toEqual({ queued: 3, synced: 0, failed: 0, inserted: 0 });
    expect(vi.mocked(syncIntegration).mock.calls.map(call => call[1])).toEqual(["a", "b", "c"]);
    expect(rows.map(row => row.due - start)).toEqual([60_000, 1000, 1000]);
    vi.setSystemTime(start + 60_000);
    vi.mocked(syncIntegration).mockResolvedValue({ inserted: 0, skipped: 0, complete: false, syncedThrough: null });
    await syncDueIntegrations(db, { limit: 1 });
    expect(vi.mocked(syncIntegration).mock.calls[3][1]).toBe("b");
    expect(syncIntegration).toHaveBeenCalledTimes(4);
  });
});
