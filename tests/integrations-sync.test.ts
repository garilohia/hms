import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens } from "@/src/lib/integrations/model";
import { fairSyncCheckpoint, type SyncCheckpoint } from "@/src/lib/integrations/checkpoint";

vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/integrations/store", async importOriginal => ({
  CommittedIntegrationCooldownError: (await importOriginal<typeof import("@/src/lib/integrations/store")>()).CommittedIntegrationCooldownError,
  loadIntegration: vi.fn(),
  markIntegrationSynced: vi.fn(),
  persistIntegrationMetrics: vi.fn(),
  refreshIntegrationTokens: vi.fn(),
  assertIntegrationReady: vi.fn(),
  saveIntegrationCooldown: vi.fn(),
}));
vi.mock("@/src/lib/integrations/checkpoint-store", () => ({ saveIntegrationCheckpoint: vi.fn() }));

import { syncIntegration } from "@/src/lib/integrations/sync";
import { assertIntegrationReady, CommittedIntegrationCooldownError, loadIntegration, markIntegrationSynced, persistIntegrationMetrics, refreshIntegrationTokens, saveIntegrationCooldown } from "@/src/lib/integrations/store";
import { saveIntegrationCheckpoint } from "@/src/lib/integrations/checkpoint-store";
import { ProviderRateLimitError } from "@/src/lib/integrations/rate-limit";

const now = "2026-09-19T12:00:00.000Z";
const tokens: StoredTokens = { accessToken: "test-access", tokenType: "Bearer", expiresAt: "2026-09-20T12:00:00.000Z" };
const googleScope = "https://www.googleapis.com/auth/googlehealth.";
let savedCheckpoint: SyncCheckpoint | null = null;
const checkpoint = () => savedCheckpoint ? fairSyncCheckpoint(savedCheckpoint) : null;

function connection(scopes: string[]) {
  vi.mocked(loadIntegration).mockImplementation(async () => ({
    sourceId: "source", timezone: "UTC", scopes, tokens,
    lastSyncAt: "2026-09-19T11:59:00.000Z", connectionVersion: "version", syncCheckpoint: savedCheckpoint, retryAt: null,
  }));
}

describe("provider sync completeness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    vi.clearAllMocks();
    savedCheckpoint = null;
    vi.mocked(saveIntegrationCheckpoint).mockImplementation(async (_actor, _subject, _provider, _version, expected, next) => {
      expect(expected).toEqual(savedCheckpoint);
      savedCheckpoint = next;
    });
    vi.mocked(persistIntegrationMetrics).mockImplementation(async (_actor, _subject, _source, metrics) => ({ inserted: metrics.length, skipped: 0 }));
    vi.mocked(assertIntegrationReady).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveIntegrationCooldown).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("imports Google readings uploaded hours late despite a recent successful sync", async () => {
    connection([`${googleScope}health_metrics_and_measurements.readonly`]);
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
      urls.push(input);
      const isHeartRate = input.pathname.includes("/heart-rate/");
      return Response.json({ dataPoints: isHeartRate ? [{ heartRate: { sampleTime: { physicalTime: "2026-09-18T08:00:00Z" }, beatsPerMinute: "72" } }] : [] });
    }));

    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toEqual({ inserted: 1, skipped: 0, complete: true, syncedThrough: now });
    const heartRate = urls.find(url => url.pathname.includes("/heart-rate/"));
    expect(heartRate?.searchParams.get("filter")).toBe('heart_rate.sample_time.physical_time >= "2026-09-12T12:00:00.000Z" AND heart_rate.sample_time.physical_time < "2026-09-19T12:00:00.000Z"');
    expect(urls.some(url => url.pathname.includes("/daily-vo2-max/"))).toBe(false);
    const daily = urls.find(url => url.pathname.includes("/daily-resting-heart-rate/"));
    expect(daily?.searchParams.get("filter")).toBe('daily_resting_heart_rate.date >= "2026-09-12" AND daily_resting_heart_rate.date < "2026-09-20"');
    expect(persistIntegrationMetrics).toHaveBeenCalledWith("actor", "subject", "source", [expect.objectContaining({ metric_type: "heart_rate", recorded_at: "2026-09-18T08:00:00Z" })], "version");
    expect(markIntegrationSynced).toHaveBeenCalledOnce();
  });

  it("requests Google VO2 max only with the activity scope", async () => {
    connection([`${googleScope}activity_and_fitness.readonly`]);
    const urls: URL[] = [];
    const fetcher = vi.fn(async (url: URL) => { urls.push(url); return Response.json({ dataPoints: [] }); });
    vi.stubGlobal("fetch", fetcher);
    await syncIntegration("actor", "subject", "google_health");
    expect(urls.some(url => url.pathname.includes("/daily-vo2-max/"))).toBe(true);
  });

  it("imports WHOOP sleep scored after the previous sync", async () => {
    connection(["read:sleep"]);
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
      urls.push(input);
      return Response.json({ records: [{ id: "sleep", start: "2026-09-18T22:00:00Z", end: "2026-09-19T06:00:00Z", nap: false,
        score: { respiratory_rate: 15, stage_summary: { total_light_sleep_time_milli: 14400000, total_slow_wave_sleep_time_milli: 3600000, total_rem_sleep_time_milli: 7200000 } } }] });
    }));
    await expect(syncIntegration("actor", "subject", "whoop")).resolves.toEqual({ inserted: 2, skipped: 0, complete: true, syncedThrough: now });
    expect(urls[0].searchParams.get("start")).toBe("2026-09-12T12:00:00.000Z");
    expect(urls[0].searchParams.get("end")).toBe(now);
    expect(persistIntegrationMetrics).toHaveBeenCalledWith("actor", "subject", "source", expect.arrayContaining([expect.objectContaining({ metric_type: "sleep_duration", value: 420 })]), "version");
  });

  it("follows the Google continuation token before declaring success", async () => {
    connection([`${googleScope}sleep.readonly`]);
    const pages: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      pages.push(url.searchParams.get("pageToken"));
      return Response.json(pages.length === 1 ? { dataPoints: [], nextPageToken: "page-2" } : { dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] });
    }));
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toEqual({ inserted: 1, skipped: 0, complete: true, syncedThrough: now });
    expect(pages).toEqual([null, "page-2"]);
    expect(markIntegrationSynced).toHaveBeenCalledOnce();
  });

  it.each(["google_health", "whoop"] as const)("resumes %s beyond the page budget without falsely reporting completion", async provider => {
    connection(provider === "google_health" ? [`${googleScope}sleep.readonly`] : ["read:sleep"]);
    const pages: Array<string | null> = [];
    const fetcher = vi.fn(async (url: URL) => {
      pages.push(url.searchParams.get(provider === "google_health" ? "pageToken" : "nextToken"));
      const current = Number((url.searchParams.get(provider === "google_health" ? "pageToken" : "nextToken") || "page-1").replace("page-", ""));
      const nextToken = current < 14 ? `page-${current + 1}` : "";
      return Response.json(provider === "google_health" ? { dataPoints: [], nextPageToken: nextToken } : { records: [], next_token: nextToken });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(syncIntegration("actor", "subject", provider)).resolves.toEqual({ inserted: 0, skipped: 0, complete: false, syncedThrough: null });
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(persistIntegrationMetrics).not.toHaveBeenCalled();
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    const frozenWindow = savedCheckpoint?.window;
    vi.setSystemTime(new Date("2026-09-19T12:01:00.000Z"));
    await expect(syncIntegration("actor", "subject", provider)).resolves.toEqual({ inserted: 0, skipped: 0, complete: true, syncedThrough: now });
    expect(pages.slice(12)).toContain("page-13");
    expect(savedCheckpoint?.window).toEqual(frozenWindow);
    expect(markIntegrationSynced).toHaveBeenCalledOnce();
  });

  it("retains the current page when persistence fails and retries it", async () => {
    connection([`${googleScope}sleep.readonly`]);
    const fetcher = vi.fn(async () => Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] }));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(persistIntegrationMetrics).mockRejectedValueOnce(new Error("Connection changed"));
    await expect(syncIntegration("actor", "subject", "google_health")).rejects.toThrow("Connection changed");
    expect(checkpoint()?.reconciliationIndex).toBe(0);
    expect(checkpoint()?.cursors[0].nextToken).toBe("");
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toMatchObject({ complete: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("yields between pages at the shared wall-clock deadline", async () => {
    connection(["read:sleep"]);
    const fetcher = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-09-19T12:00:20.000Z"));
      return Response.json({ records: [], next_token: "next" });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(syncIntegration("actor", "subject", "whoop", { deadline: Date.parse(now) + 25_000 })).resolves.toMatchObject({ complete: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(checkpoint()?.cursors[0].nextToken).toBe("next");
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("does not start persistence after the page fetch consumes its deadline", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(new Date("2026-09-19T12:00:25.000Z"));
      return Response.json({ records: [], next_token: "next" });
    }));
    await expect(syncIntegration("actor", "subject", "whoop", { deadline: Date.parse(now) + 25_000 })).resolves.toMatchObject({ complete: false });
    expect(persistIntegrationMetrics).not.toHaveBeenCalled();
    expect(checkpoint()?.cursors[0].nextToken).toBe("");
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("yields a timed-out scheduled fetch slice without imposing a provider failure delay", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(Date.parse(now) + 3_000);
      throw new DOMException("Scheduled fetch slice ended", "TimeoutError");
    }));
    await expect(syncIntegration("actor", "subject", "whoop", { deadline: Date.parse(now) + 8_000, maxPages: 3 })).resolves.toMatchObject({ complete: false });
    expect(checkpoint()?.cursors[0]).toEqual({ nextToken: "", complete: false });
    expect(saveIntegrationCooldown).not.toHaveBeenCalled();
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("advances healthy four-second pages but starts no page after its soft eight-second slice", async () => {
    connection(["read:sleep"]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let page = 0;
    const progressed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      vi.setSystemTime(Date.now() + 4_000);
      return Response.json({ records: [], next_token: `page-${++page + 1}` });
    }));
    await expect(syncIntegration("actor", "subject", "whoop", { deadline: Date.parse(now) + 25_000, startDeadline: Date.parse(now) + 8_000, maxPages: 3, onPageComplete: progressed })).resolves.toMatchObject({ complete: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls.map(call => call[0])).toEqual([20_000, 16_000]);
    expect(checkpoint()?.cursors[0].nextToken).toBe("page-3");
    expect(progressed).toHaveBeenCalledTimes(2);
    timeout.mockRestore();
  });

  it("replays a committed page if persistence leaves no time to save its checkpoint", async () => {
    connection([`${googleScope}sleep.readonly`]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] })));
    vi.mocked(persistIntegrationMetrics).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-09-19T12:00:25.000Z"));
      return { inserted: 1, skipped: 0 };
    });
    await expect(syncIntegration("actor", "subject", "google_health", { deadline: Date.parse(now) + 25_000 })).resolves.toMatchObject({ inserted: 1, complete: false });
    expect(checkpoint()?.reconciliationIndex).toBe(0);
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    vi.mocked(persistIntegrationMetrics).mockResolvedValueOnce({ inserted: 0, skipped: 1 });
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toMatchObject({ inserted: 0, skipped: 1, complete: true });
  });

  it("does not advance the checkpoint when a provider rejects a request", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "rate limited" }, { status: 429 })));
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(persistIntegrationMetrics).not.toHaveBeenCalled();
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("converts v1 without losing its exact frozen query and continuation", async () => {
    connection([`${googleScope}health_metrics_and_measurements.readonly`]);
    savedCheckpoint = { version: 1, provider: "google_health", window: { start: "2026-09-11T12:00:00.000Z", end: "2026-09-18T12:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["heart-rate", "daily-oxygen-saturation"], collectionIndex: 0, nextToken: "exact-page" };
    const original = savedCheckpoint;
    const fetcher = vi.fn(async (url: URL) => {
      expect(savedCheckpoint?.version).toBe(2);
      expect(url.searchParams.get("pageToken")).toBe("exact-page");
      expect(url.searchParams.get("filter")).toContain(original.window.end);
      return Response.json({ dataPoints: [], nextPageToken: "next-page" });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(syncIntegration("actor", "subject", "google_health", { maxPages: 1 })).resolves.toMatchObject({ complete: false });
    expect(saveIntegrationCheckpoint).toHaveBeenNthCalledWith(1, "actor", "subject", "google_health", "version", original, expect.objectContaining({ version: 2, window: original.window }));
    expect(checkpoint()?.cursors[0].nextToken).toBe("next-page");
  });

  it("visits SpO2, temperature and sleep while a dense heart-rate collection still has pages", async () => {
    connection([`${googleScope}health_metrics_and_measurements.readonly`, `${googleScope}sleep.readonly`]);
    const visited: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      const type = url.pathname.split("/").at(-2)!;
      visited.push(type);
      return Response.json({ dataPoints: [], nextPageToken: type === "heart-rate" ? "dense-next" : "" });
    }));
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toMatchObject({ complete: false });
    expect(visited.slice(0, 8)).toEqual(["heart-rate", "daily-resting-heart-rate", "daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "weight", "sleep"]);
    expect(checkpoint()?.cursors[0]).toEqual({ nextToken: "dense-next", complete: false });
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("persists a current Google head without advancing the historical token or watermark", async () => {
    connection([`${googleScope}health_metrics_and_measurements.readonly`]);
    savedCheckpoint = { ...fairSyncCheckpoint({ version: 1, provider: "google_health", window: { start: "2026-09-11T12:00:00.000Z", end: "2026-09-18T12:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["heart-rate", "daily-oxygen-saturation"], collectionIndex: 0, nextToken: "historical-page" }), nextLane: "head" };
    const original = checkpoint();
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      urls.push(url);
      return Response.json({ dataPoints: [{ heartRate: { sampleTime: { physicalTime: "2026-09-19T11:59:00Z" }, beatsPerMinute: "72" } }], nextPageToken: "ignored-probe-tail" });
    }));
    await expect(syncIntegration("actor", "subject", "google_health", { maxPages: 1 })).resolves.toMatchObject({ inserted: 1, complete: false, syncedThrough: null });
    expect(urls[0].searchParams.has("pageToken")).toBe(false);
    expect(urls[0].searchParams.get("filter")).toContain(now);
    expect(checkpoint()?.cursors).toEqual(original?.cursors);
    expect(checkpoint()?.window).toEqual(original?.window);
    expect(checkpoint()?.probeIndex).toBe(1);
    expect(checkpoint()?.nextLane).toBe("reconciliation");
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    await syncIntegration("actor", "subject", "google_health", { maxPages: 1 });
    expect(urls[1].searchParams.get("pageToken")).toBe("historical-page");
  });

  it("replays the same page when the post-ingestion checkpoint CAS fails", async () => {
    connection([`${googleScope}sleep.readonly`]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] })));
    const save = vi.mocked(saveIntegrationCheckpoint).getMockImplementation()!;
    vi.mocked(saveIntegrationCheckpoint).mockImplementationOnce(save).mockRejectedValueOnce(new Error("checkpoint changed"));
    const progressed = vi.fn();
    await expect(syncIntegration("actor", "subject", "google_health", { onPageComplete: progressed })).rejects.toThrow("checkpoint changed");
    expect(progressed).not.toHaveBeenCalled();
    expect(checkpoint()?.cursors[0].complete).toBe(false);
    vi.mocked(persistIntegrationMetrics).mockResolvedValueOnce({ inserted: 0, skipped: 1 });
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toMatchObject({ inserted: 0, skipped: 1, complete: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("persists Retry-After against the current grant without advancing its page", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 429, headers: { "Retry-After": "900" } })));
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(saveIntegrationCooldown).toHaveBeenCalledWith("actor", "subject", "whoop", "version", new Date(Date.parse(now) + 900_000));
    expect(checkpoint()?.cursors[0]).toEqual({ nextToken: "", complete: false });
  });

  it("blocks a manual retry before refresh or fetch while the stored cooldown is active", async () => {
    vi.mocked(loadIntegration).mockResolvedValue({ sourceId: "source", timezone: "UTC", scopes: ["read:sleep"], tokens: { ...tokens, expiresAt: "2026-09-18T00:00:00Z" }, lastSyncAt: null, connectionVersion: "version", syncCheckpoint: null, retryAt: new Date(Date.parse(now) + 900_000) });
    vi.stubGlobal("fetch", vi.fn());
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(refreshIntegrationTokens).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stores a refresh endpoint cooldown against the unchanged grant before requesting any data page", async () => {
    savedCheckpoint = { version: 1, provider: "whoop", window: { start: "2026-09-11T12:00:00.000Z", end: "2026-09-18T12:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["activity/sleep"], collectionIndex: 0, nextToken: "frozen-page" };
    const original = savedCheckpoint;
    vi.mocked(loadIntegration).mockResolvedValue({ sourceId: "source", timezone: "UTC", scopes: ["read:sleep"], tokens: { ...tokens, refreshToken: "test-refresh", expiresAt: "2026-09-18T00:00:00Z" }, lastSyncAt: null, connectionVersion: "current-version", syncCheckpoint: savedCheckpoint, retryAt: null });
    const throttled = new ProviderRateLimitError(new Date(Date.parse(now) + 900_000));
    vi.mocked(refreshIntegrationTokens).mockRejectedValueOnce(throttled);
    vi.stubGlobal("fetch", vi.fn());
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBe(throttled);
    expect(saveIntegrationCooldown).toHaveBeenCalledExactlyOnceWith("actor", "subject", "whoop", "current-version", throttled.retryAt);
    expect(savedCheckpoint).toEqual(original);
    expect(saveIntegrationCheckpoint).not.toHaveBeenCalled();
    expect(persistIntegrationMetrics).not.toHaveBeenCalled();
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not write a second old-version cooldown after refresh committed one under its lock", async () => {
    vi.mocked(loadIntegration).mockResolvedValue({ sourceId: "source", timezone: "UTC", scopes: ["read:sleep"], tokens: { ...tokens, expiresAt: "2026-09-18T00:00:00Z" }, lastSyncAt: null, connectionVersion: "current-version", syncCheckpoint: null, retryAt: null });
    const throttled = new CommittedIntegrationCooldownError(new Date(Date.parse(now) + 900_000));
    vi.mocked(refreshIntegrationTokens).mockRejectedValueOnce(throttled);
    vi.stubGlobal("fetch", vi.fn());
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBe(throttled);
    expect(saveIntegrationCooldown).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks a concurrently established cooldown before the next page", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [], next_token: "next-page" })));
    vi.mocked(assertIntegrationReady).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ProviderRateLimitError(new Date(Date.parse(now) + 900_000)));
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(checkpoint()?.cursors[0].nextToken).toBe("next-page");
  });
});
