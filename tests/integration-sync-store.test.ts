import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fairSyncCheckpoint } from "@/src/lib/integrations/checkpoint";
import { ProviderRateLimitError } from "@/src/lib/integrations/rate-limit";
import { ProviderBudgetDeferredError } from "@/src/lib/integrations/request-budget";

const mocks = vi.hoisted(() => ({ unsafe: vi.fn(), bindActor: vi.fn(), lockOwnedSubject: vi.fn(), end: vi.fn(), refresh: vi.fn(), begin: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/data-rights/server", () => ({
  rightsDatabase: () => ({ begin: mocks.begin, end: mocks.end }),
  bindActor: mocks.bindActor, lockOwnedSubject: mocks.lockOwnedSubject,
}));
vi.mock("@/src/lib/integrations/providers", () => ({ providerConfig: vi.fn(), refreshAccessToken: mocks.refresh }));
vi.mock("@/src/lib/integrations/crypto", () => ({ seal: () => "rotated-version", unseal: () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", tokenType: "Bearer" }) }));
import { assertIntegrationReady, CommittedIntegrationBudgetError, CommittedIntegrationCooldownError, markIntegrationSynced, refreshIntegrationTokens, saveIntegrationCooldown } from "@/src/lib/integrations/store";

const now = Date.parse("2026-09-19T12:00:00Z");
const initial = fairSyncCheckpoint({ version: 1, provider: "google_health", window: { start: "2026-09-11T12:00:00.000Z", end: "2026-09-18T12:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["heart-rate", "sleep"], collectionIndex: 0, nextToken: "page-2" });

describe("provider sync storage guards", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
    mocks.unsafe.mockResolvedValue([{ source_id: "source" }]);
    mocks.lockOwnedSubject.mockResolvedValue(undefined);
    mocks.begin.mockImplementation((work: (tx: { unsafe: typeof mocks.unsafe }) => unknown) => work({ unsafe: mocks.unsafe }));
  });
  afterEach(() => vi.useRealTimers());

  it("rejects v2 completion while any collection still has pending historical pages", async () => {
    await expect(markIntegrationSynced("actor", "subject", "google_health", "version", { ...initial, probeIndex: 1, nextLane: "reconciliation" })).rejects.toThrow("Finish all wearable pages");
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  it("completes v2 against the exact checkpoint and keeps an existing cooldown", async () => {
    const complete = { ...initial, cursors: initial.cursors.map(() => ({ complete: true, nextToken: "" })) };
    await markIntegrationSynced("actor", "subject", "google_health", "version", complete);
    const finish = mocks.unsafe.mock.calls.find(([sql]) => sql.startsWith("update hms_private.integration_connections c"));
    expect(finish?.[0]).toContain("c.sync_checkpoint is not distinct from $3::text::jsonb");
    expect(finish?.[0]).toContain("greatest(next_sync_at,now()+interval '1 minute')");
    expect(finish?.[0]).toContain("when last_error in ('ProviderRateLimited','ProviderBudgetQueued') and next_sync_at>now() then last_error");
    expect(finish?.[1].slice(0, 2)).toEqual(["subject", "google_health"]);
    expect(JSON.parse(String(finish?.[1][2]))).toEqual(complete);
    expect(mocks.unsafe).toHaveBeenCalledWith("update public.data_sources set last_sync_at=$1 where id=$2 and user_id=$3", [initial.window.end, "source", "subject"]);
    expect(mocks.lockOwnedSubject).toHaveBeenCalledWith(expect.anything(), "subject", true);
  });

  it("checks the connected grant before storing a cooldown and never clears its cursor or lease", async () => {
    const retryAt = new Date(now + 900_000);
    await saveIntegrationCooldown("actor", "subject", "google_health", "version", retryAt);
    const guard = mocks.unsafe.mock.calls[0];
    expect(guard[0]).toContain("c.encrypted_tokens=$2");
    expect(guard[0]).toContain("s.status='connected'");
    expect(guard[0]).toContain("for update of c");
    const update = mocks.unsafe.mock.calls[1];
    expect(update[0]).toContain("greatest(next_sync_at,$1)");
    expect(update[0]).not.toContain("sync_checkpoint");
    expect(update[0]).not.toContain("sync_locked_until");
    expect(update[1]).toEqual([retryAt, "subject", "google_health", "ProviderRateLimited"]);
  });

  it("cannot apply a late 429 to a stopped or replaced connection", async () => {
    mocks.unsafe.mockResolvedValue([]);
    await expect(saveIntegrationCooldown("actor", "subject", "google_health", "old-version", new Date(now + 900_000))).rejects.toThrow("connection changed");
    expect(mocks.unsafe).toHaveBeenCalledOnce();
  });

  it("checks current ownership and ingestion consent before touching cooldown state", async () => {
    mocks.lockOwnedSubject.mockRejectedValueOnce(new Error("consent revoked"));
    await expect(assertIntegrationReady("actor", "subject", "google_health", "version")).rejects.toThrow("consent revoked");
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  it("prevents token refresh and further pages during a live cooldown", async () => {
    mocks.unsafe.mockResolvedValue([{ last_error: "ProviderRateLimited", next_sync_at: new Date(now + 900_000).toISOString() }]);
    await expect(assertIntegrationReady("actor", "subject", "google_health", "version")).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(refreshIntegrationTokens("actor", "subject", "google_health", "version")).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("allows a page after cooldown expiry without mistaking ordinary schedule delay for throttling", async () => {
    mocks.unsafe.mockResolvedValueOnce([{ last_error: "ProviderRateLimited", next_sync_at: new Date(now - 1000).toISOString() }]);
    await expect(assertIntegrationReady("actor", "subject", "google_health", "version")).resolves.toBeUndefined();
    mocks.unsafe.mockResolvedValueOnce([{ last_error: null, next_sync_at: new Date(now + 60_000).toISOString() }]);
    await expect(assertIntegrationReady("actor", "subject", "google_health", "version")).resolves.toBeUndefined();
  });

  it("commits refresh throttling before a waiting refresh can rotate the grant", async () => {
    let serial: Promise<unknown> = Promise.resolve();
    const events: string[] = [];
    let state: Record<string, unknown> = { last_error: null, next_sync_at: new Date(now).toISOString() };
    mocks.begin.mockImplementation((work: (tx: { unsafe: typeof mocks.unsafe }) => Promise<unknown>) => {
      const transaction = serial.then(async () => {
        events.push("begin");
        const result = await work({ unsafe: mocks.unsafe });
        events.push("commit");
        return result;
      });
      serial = transaction.then(() => undefined, () => undefined);
      return transaction;
    });
    mocks.unsafe.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("select c.last_error")) return [state];
      if (sql.includes("last_error=$4")) {
        state = { last_error: values[3], next_sync_at: (values[0] as Date).toISOString() };
        events.push("persist cooldown");
      }
      return [];
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    let rejectRefresh!: (error: Error) => void;
    mocks.refresh.mockImplementationOnce(() => {
      signalEntered();
      return new Promise((_resolve, reject) => { rejectRefresh = reject; });
    });
    const first = refreshIntegrationTokens("actor", "subject", "google_health", "version");
    const second = refreshIntegrationTokens("actor", "subject", "google_health", "version");
    const settled = Promise.allSettled([first, second]);
    await entered;
    expect(mocks.refresh).toHaveBeenCalledOnce();
    rejectRefresh(new ProviderRateLimitError(new Date(now + 900_000)));
    const results = await settled;
    expect(results[0]).toMatchObject({ status: "rejected", reason: expect.any(CommittedIntegrationCooldownError) });
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(ProviderRateLimitError) });
    expect(events).toEqual(["begin", "persist cooldown", "commit", "begin"]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.unsafe.mock.calls.some(([sql]) => sql.includes("set encrypted_tokens="))).toBe(false);
  });

  it("preserves local-budget meaning when refresh commits a deferral under its grant lock", async () => {
    const error = new ProviderBudgetDeferredError(new Date(now + 10_000));
    mocks.refresh.mockRejectedValueOnce(error);
    await expect(refreshIntegrationTokens("actor", "subject", "whoop", "version")).rejects.toBeInstanceOf(CommittedIntegrationBudgetError);
    const update = mocks.unsafe.mock.calls.find(([sql]) => sql.includes("last_error=$4"));
    expect(update?.[1]).toEqual([error.retryAt, "subject", "whoop", "ProviderBudgetQueued"]);
  });

  it("surfaces a stored local budget delay with its distinct queued message", async () => {
    mocks.unsafe.mockResolvedValueOnce([{ last_error: "ProviderBudgetQueued", next_sync_at: new Date(now + 10_000).toISOString() }]);
    await expect(assertIntegrationReady("actor", "subject", "whoop", "version")).rejects.toBeInstanceOf(ProviderBudgetDeferredError);
  });
});
