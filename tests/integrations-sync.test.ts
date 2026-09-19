import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens } from "@/src/lib/integrations/model";
import type { SyncCheckpoint } from "@/src/lib/integrations/checkpoint";

vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/integrations/store", () => ({
  loadIntegration: vi.fn(),
  markIntegrationSynced: vi.fn(),
  persistIntegrationMetrics: vi.fn(),
  refreshIntegrationTokens: vi.fn(),
}));
vi.mock("@/src/lib/integrations/checkpoint-store", () => ({ saveIntegrationCheckpoint: vi.fn() }));

import { syncIntegration } from "@/src/lib/integrations/sync";
import { loadIntegration, markIntegrationSynced, persistIntegrationMetrics } from "@/src/lib/integrations/store";
import { saveIntegrationCheckpoint } from "@/src/lib/integrations/checkpoint-store";

const now = "2026-09-19T12:00:00.000Z";
const tokens: StoredTokens = { accessToken: "test-access", tokenType: "Bearer", expiresAt: "2026-09-20T12:00:00.000Z" };
const googleScope = "https://www.googleapis.com/auth/googlehealth.";
let savedCheckpoint: SyncCheckpoint | null = null;

function connection(scopes: string[]) {
  vi.mocked(loadIntegration).mockImplementation(async () => ({
    sourceId: "source", timezone: "UTC", scopes, tokens,
    lastSyncAt: "2026-09-19T11:59:00.000Z", connectionVersion: "version", syncCheckpoint: savedCheckpoint,
  }));
}

describe("provider sync completeness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    vi.clearAllMocks();
    savedCheckpoint = null;
    vi.mocked(saveIntegrationCheckpoint).mockImplementation(async (_actor, _subject, _provider, _version, _expected, next) => { savedCheckpoint = next; });
    vi.mocked(persistIntegrationMetrics).mockImplementation(async (_actor, _subject, _source, metrics) => ({ inserted: metrics.length, skipped: 0 }));
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
      const nextToken = pages.length < 14 ? `page-${pages.length + 1}` : "";
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
    expect(pages[12]).toBe("page-13");
    expect(savedCheckpoint?.window).toEqual(frozenWindow);
    expect(markIntegrationSynced).toHaveBeenCalledOnce();
  });

  it("retains the current page when persistence fails and retries it", async () => {
    connection([`${googleScope}sleep.readonly`]);
    const fetcher = vi.fn(async () => Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] }));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(persistIntegrationMetrics).mockRejectedValueOnce(new Error("Connection changed"));
    await expect(syncIntegration("actor", "subject", "google_health")).rejects.toThrow("Connection changed");
    expect(savedCheckpoint?.collectionIndex).toBe(0);
    expect(savedCheckpoint?.nextToken).toBe("");
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
    expect(savedCheckpoint?.nextToken).toBe("next");
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
    expect(savedCheckpoint?.nextToken).toBe("");
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });

  it("replays a committed page if persistence leaves no time to save its checkpoint", async () => {
    connection([`${googleScope}sleep.readonly`]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-09-18T22:00:00Z", endTime: "2026-09-19T06:00:00Z" }, summary: { minutesAsleep: "420" } } }] })));
    vi.mocked(persistIntegrationMetrics).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-09-19T12:00:25.000Z"));
      return { inserted: 1, skipped: 0 };
    });
    await expect(syncIntegration("actor", "subject", "google_health", { deadline: Date.parse(now) + 25_000 })).resolves.toMatchObject({ inserted: 1, complete: false });
    expect(savedCheckpoint?.collectionIndex).toBe(0);
    expect(markIntegrationSynced).not.toHaveBeenCalled();
    vi.mocked(persistIntegrationMetrics).mockResolvedValueOnce({ inserted: 0, skipped: 1 });
    await expect(syncIntegration("actor", "subject", "google_health")).resolves.toMatchObject({ inserted: 0, skipped: 1, complete: true });
  });

  it("does not advance the checkpoint when a provider rejects a request", async () => {
    connection(["read:sleep"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "rate limited" }, { status: 429 })));
    await expect(syncIntegration("actor", "subject", "whoop")).rejects.toThrow("sync failed");
    expect(persistIntegrationMetrics).not.toHaveBeenCalled();
    expect(markIntegrationSynced).not.toHaveBeenCalled();
  });
});
