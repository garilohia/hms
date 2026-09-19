import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unsafe: vi.fn(), bindActor: vi.fn(), lockOwnedSubject: vi.fn(), revoke: vi.fn(), end: vi.fn(),
  transactionActive: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/data-rights/server", () => ({
  rightsDatabase: () => ({
    begin: async (work: (tx: { unsafe: typeof mocks.unsafe }) => unknown) => {
      mocks.transactionActive = true;
      try { return await work({ unsafe: mocks.unsafe }); }
      finally { mocks.transactionActive = false; }
    },
    end: mocks.end,
  }),
  bindActor: mocks.bindActor, lockOwnedSubject: mocks.lockOwnedSubject,
}));
vi.mock("@/src/lib/integrations/revocation", () => ({ revokeProviderAccess: mocks.revoke }));

import { seal, unseal } from "@/src/lib/integrations/crypto";
import { loadIntegration, markIntegrationSynced, persistIntegrationMetrics, removeIntegration, saveIntegration } from "@/src/lib/integrations/store";

const actor = "1ed82137-7e91-4c6e-8c64-2d81dbabc195", subject = "1ed82137-7e91-4c6e-8c64-2d81dbabc196";
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", tokenType: "Bearer" };
let version = "";

describe("wearable disconnect boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTEGRATION_TOKEN_KEY", Buffer.alloc(32, 1).toString("base64"));
    version = seal(tokens);
    mocks.unsafe.mockImplementation(async (sql: string) => {
      if (sql.startsWith("select c.source_id,c.encrypted_tokens,c.last_error")) return [{ source_id: "source", encrypted_tokens: version, status: "connected", busy: false }];
      if (sql.startsWith("select 1 from hms_private.integration_connections c join public.data_sources s") && sql.includes("ProviderRevoking")) return [{ "?column?": 1 }];
      return [];
    });
    mocks.lockOwnedSubject.mockResolvedValue(undefined);
    mocks.revoke.mockResolvedValue({ revoked: true, tokens });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("commits a local stop before calling the provider and does not require ingestion consent", async () => {
    mocks.revoke.mockImplementation(async () => {
      expect(mocks.transactionActive).toBe(false);
      expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).includes("status='disconnected'"))).toBe(true);
      return { revoked: true, tokens };
    });
    expect(await removeIntegration(actor, subject, "google_health")).toEqual({ revocationPending: false });
    expect(mocks.lockOwnedSubject).toHaveBeenCalledWith(expect.anything(), subject);
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).startsWith("delete from hms_private.integration_connections"))).toBe(true);
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).includes("delete from public.metrics"))).toBe(false);
  });

  it("makes no provider call when current ownership is denied", async () => {
    mocks.lockOwnedSubject.mockRejectedValue(new Error("ownership denied"));
    await expect(removeIntegration(actor, subject, "whoop")).rejects.toThrow("ownership denied");
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  it("preserves rotated encrypted tokens and keeps sync stopped after a remote failure", async () => {
    const rotated = { ...tokens, accessToken: "rotated-access", refreshToken: "rotated-refresh" };
    mocks.revoke.mockResolvedValue({ revoked: false, tokens: rotated });
    expect(await removeIntegration(actor, subject, "whoop")).toEqual({ revocationPending: true });
    const saved = mocks.unsafe.mock.calls.find(([sql]) => String(sql).includes("last_error='ProviderRevokePending'"));
    expect(unseal(String(saved?.[1][0]))).toEqual(rotated);
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).startsWith("delete from"))).toBe(false);
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).includes("next_sync_at='infinity'"))).toBe(true);
  });

  it("does not revoke twice or manually forget credentials during an active revocation lease", async () => {
    mocks.unsafe.mockResolvedValue([{ source_id: "source", encrypted_tokens: version, status: "disconnected", last_error: "ProviderRevoking", busy: true }]);
    expect(await removeIntegration(actor, subject, "whoop", true)).toEqual({ revocationPending: true });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.unsafe).toHaveBeenCalledTimes(1);
  });

  it("does not delete a replacement connection when the final generation check fails", async () => {
    const priorImplementation = mocks.unsafe.getMockImplementation();
    mocks.unsafe.mockImplementation(async (sql: string, parameters: unknown[]) => sql.includes("ProviderRevoking") && sql.startsWith("select 1") ? [] : priorImplementation?.(sql, parameters));
    expect(await removeIntegration(actor, subject, "whoop")).toEqual({ revocationPending: true, connectionChanged: true });
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).startsWith("delete from"))).toBe(false);
  });

  it("blocks code exchange while provider revocation is pending", async () => {
    mocks.unsafe.mockResolvedValue([{ "?column?": 1 }]);
    const exchange = vi.fn();
    await expect(saveIntegration(actor, subject, "whoop", exchange)).rejects.toThrow("Finish removing provider access");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects stale in-flight metrics before ingestion after a connection is stopped or replaced", async () => {
    mocks.unsafe.mockResolvedValue([]);
    await expect(persistIntegrationMetrics(actor, subject, "source", [{ metric_type: "steps", recorded_at: "2026-09-18T00:00:00Z", value: 1, unit: "count", duration_s: null, quality: "raw", external_id: null }], version)).rejects.toThrow("connection changed");
    expect(mocks.unsafe.mock.calls.some(([sql]) => String(sql).includes("hms_ingest_batch"))).toBe(false);
    await expect(loadIntegration(actor, subject, "whoop")).rejects.toThrow("Connect this wearable first");
  });

  it("requires a completed checkpoint and stamps the covered window rather than completion time", async () => {
    const checkpoint = { version: 1, provider: "whoop", window: { start: "2026-09-11T10:00:00.000Z", end: "2026-09-18T10:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["sleep"], collectionIndex: 0, nextToken: "" };
    await expect(markIntegrationSynced(actor, subject, "whoop", version, checkpoint)).rejects.toThrow("Finish all wearable pages");
    expect(mocks.unsafe).not.toHaveBeenCalled();
    mocks.unsafe.mockResolvedValue([{ source_id: "source" }]);
    await markIntegrationSynced(actor, subject, "whoop", version, { ...checkpoint, collectionIndex: 1 });
    expect(mocks.unsafe).toHaveBeenCalledWith("update public.data_sources set last_sync_at=$1 where id=$2 and user_id=$3", [checkpoint.window.end, "source", subject]);
  });
});
