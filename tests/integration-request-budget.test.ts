import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRateLimitError } from "@/src/lib/integrations/rate-limit";

const mocks = vi.hoisted(() => ({ database: vi.fn(), unsafe: vi.fn(), end: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/data-rights/server", () => ({ rightsDatabase: mocks.database }));
import {
  ProviderBudgetConfigurationError,
  ProviderBudgetDeferredError,
  ProviderBudgetUnavailableError,
  providerQuotaConfigured,
  providerQuotaScope,
  providerRequest,
} from "@/src/lib/integrations/request-budget";

const now = Date.parse("2026-09-19T12:00:00.000Z");
const endpoint = "https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints";
const deadline = now + 20_000;
const scopeHash = (provider: string, scope: string) => createHash("sha256").update(`${provider}:${scope}`).digest("hex");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetAllMocks();
  vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", "hms-test-project");
  vi.stubEnv("WHOOP_CLIENT_ID", "synthetic-whoop-client");
  mocks.database.mockImplementation(() => ({ unsafe: mocks.unsafe, end: mocks.end }));
  mocks.unsafe.mockResolvedValue([{ retry_at: null }]);
  mocks.end.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider quota scope configuration", () => {
  it("uses a stable, lowercase SHA256 scope without patient data or environment suffixes", () => {
    const google = providerQuotaScope("google_health");
    const whoop = providerQuotaScope("whoop");
    expect(google).toBe(scopeHash("google_health", "hms-test-project"));
    expect(whoop).toBe(scopeHash("whoop", "synthetic-whoop-client"));
    expect(google).toMatch(/^[0-9a-f]{64}$/);
    expect(whoop).toMatch(/^[0-9a-f]{64}$/);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(providerQuotaScope("google_health")).toBe(google);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(providerQuotaScope("google_health")).toBe(google);
    expect(providerQuotaConfigured("google_health")).toBe(true);
    expect(providerQuotaConfigured("whoop")).toBe(true);
    expect(mocks.database).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "short", "HMS-PROJECT", "1hms-project", "hms-project-", "https://hms-project", "a".repeat(31)])(
    "rejects a missing or non-canonical Google project scope: %s",
    value => {
      vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", value);
      expect(providerQuotaConfigured("google_health")).toBe(false);
      expect(() => providerQuotaScope("google_health")).toThrow(ProviderBudgetConfigurationError);
    },
  );

  it.each([
    { label: "missing", value: undefined }, { label: "empty", value: "" },
    { label: "whitespace", value: " " }, { label: "overlong", value: "a".repeat(257) },
  ])("rejects an invalid WHOOP client scope: $label", ({ value }) => {
    vi.stubEnv("WHOOP_CLIENT_ID", value);
    expect(providerQuotaConfigured("whoop")).toBe(false);
    expect(() => providerQuotaScope("whoop")).toThrow(ProviderBudgetConfigurationError);
  });

  it("changes buckets only when the configured provider quota identity changes", () => {
    const initial = providerQuotaScope("google_health");
    vi.stubEnv("GOOGLE_HEALTH_CLIENT_ID", "different-oauth-client-in-the-same-project");
    expect(providerQuotaScope("google_health")).toBe(initial);
    vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", "another-hms-project");
    expect(providerQuotaScope("google_health")).not.toBe(initial);
  });
});

describe("provider request budget admission", () => {
  it("commits and closes the independent reservation before HTTP, forcing no cache and no redirects", async () => {
    const events: string[] = [];
    mocks.unsafe.mockImplementation(async () => { events.push("reserve"); return [{ retry_at: null }]; });
    mocks.end.mockImplementation(async () => { events.push("closed"); });
    const response = new Response("untouched payload", { status: 200 });
    mocks.fetch.mockImplementation(async () => { events.push("fetch"); return response; });
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "synthetic-refresh" });
    const result = await providerRequest("google_health", new URL(endpoint), {
      method: "POST", headers: { Authorization: "Bearer synthetic-access" }, body,
      cache: "force-cache", redirect: "follow",
    }, deadline);
    expect(events).toEqual(["reserve", "closed", "fetch"]);
    expect(result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(mocks.unsafe).toHaveBeenCalledWith(expect.stringContaining("hms_private.reserve_provider_request"), ["google_health", scopeHash("google_health", "hms-test-project")]);
    expect(mocks.fetch).toHaveBeenCalledWith(new URL(endpoint), expect.objectContaining({
      method: "POST", headers: { Authorization: "Bearer synthetic-access" }, body,
      cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    }));
  });

  it("does not open the database or send HTTP when scope configuration is missing", async () => {
    vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", undefined);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps the validated destination if the caller mutates its URL during admission", async () => {
    const input = new URL(endpoint);
    mocks.unsafe.mockImplementation(async () => {
      input.hostname = "untrusted.example";
      return [{ retry_at: null }];
    });
    await providerRequest("google_health", input, {}, deadline);
    expect(mocks.fetch).toHaveBeenCalledWith(new URL(endpoint), expect.anything());
    expect(mocks.fetch).not.toHaveBeenCalledWith(input, expect.anything());
  });

  it.each(["http://health.googleapis.com/data", "https://unexpected.example/data", "https://user:secret@health.googleapis.com/data"])(
    "rejects destinations outside the trusted provider endpoint: %s",
    async url => {
      await expect(providerRequest("google_health", url, {}, deadline)).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
      expect(mocks.database).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("sanitises unavailable database configuration before any HTTP", async () => {
    mocks.database.mockImplementation(() => { throw new Error("postgres://private-password@private-host/database"); });
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({
      name: "ProviderBudgetUnavailableError", message: expect.not.stringContaining("private-password"),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed and closes the database when the migration is absent", async () => {
    mocks.unsafe.mockRejectedValueOnce(new Error("function hms_private.reserve_provider_request does not exist: synthetic-private-detail"));
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({
      name: "ProviderBudgetUnavailableError", message: expect.not.stringContaining("synthetic-private-detail"),
    });
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no rows", rows: [] },
    { label: "missing result", rows: [{}] },
    { label: "undefined result", rows: [{ retry_at: undefined }] },
    { label: "invalid timestamp", rows: [{ retry_at: "not-a-date" }] },
    { label: "numeric result", rows: [{ retry_at: 17 }] },
    { label: "multiple rows", rows: [{ retry_at: null }, { retry_at: null }] },
  ])("fails closed for a malformed budget result: $label", async ({ rows }) => {
    mocks.unsafe.mockResolvedValueOnce(rows);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toBeInstanceOf(ProviderBudgetUnavailableError);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not send HTTP if closing the reservation connection fails", async () => {
    mocks.end.mockRejectedValueOnce(new Error("private connection failure"));
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toBeInstanceOf(ProviderBudgetUnavailableError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns a distinct local deferral with its retry time and closes the database", async () => {
    const retryAt = new Date(now + 60_000);
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: retryAt.toISOString() }]);
    const operation = providerRequest("google_health", endpoint, {}, deadline);
    await expect(operation).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(operation).rejects.toBeInstanceOf(ProviderBudgetDeferredError);
    await expect(operation).rejects.toMatchObject({ name: "ProviderBudgetDeferredError", retryAt });
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("takes a new permit for each outbound attempt, including after a network failure", async () => {
    const networkFailure = new Error("synthetic network failure");
    mocks.fetch.mockRejectedValueOnce(networkFailure);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toBe(networkFailure);
    await providerRequest("google_health", "https://oauth2.googleapis.com/token", { method: "POST" }, deadline);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);
    expect(mocks.unsafe.mock.calls.every(([sql]) => sql.includes("reserve_provider_request"))).toBe(true);
    expect(mocks.unsafe.mock.calls[0][1]).toEqual(mocks.unsafe.mock.calls[1][1]);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it("rechecks consent after the quota transaction closes and never refunds a denied check", async () => {
    const events: string[] = [];
    const revoked = new Error("consent revoked");
    mocks.end.mockImplementationOnce(async () => { events.push("closed"); });
    const beforeRequest = vi.fn(async () => { events.push("recheck"); throw revoked; });
    await expect(providerRequest("google_health", endpoint, {}, deadline, beforeRequest)).rejects.toBe(revoked);
    expect(events).toEqual(["closed", "recheck"]);
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(mocks.unsafe).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("provider request budget deadlines and cancellation", () => {
  it("does not reserve a permit after the caller deadline has expired", async () => {
    await expect(providerRequest("google_health", endpoint, {}, now)).rejects.toThrow();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not start HTTP if the deadline expires during reservation", async () => {
    mocks.unsafe.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline);
      return [{ retry_at: null }];
    });
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toThrow();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.unsafe).toHaveBeenCalledOnce();
  });

  it("does not reserve a permit for an already-cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(providerRequest("google_health", endpoint, { signal: controller.signal }, deadline)).rejects.toThrow();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not start HTTP when the caller cancels during reservation", async () => {
    const controller = new AbortController();
    mocks.unsafe.mockImplementationOnce(async () => {
      controller.abort();
      return [{ retry_at: null }];
    });
    await expect(providerRequest("google_health", endpoint, { signal: controller.signal }, deadline)).rejects.toThrow();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not start HTTP when the final consent check consumes the remaining deadline", async () => {
    const beforeRequest = vi.fn(async () => { vi.setSystemTime(deadline); });
    await expect(providerRequest("google_health", endpoint, {}, deadline, beforeRequest)).rejects.toThrow();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.unsafe).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not start HTTP when the caller cancels during the final consent check", async () => {
    const controller = new AbortController();
    const beforeRequest = vi.fn(async () => { controller.abort(); });
    await expect(providerRequest("google_health", endpoint, { signal: controller.signal }, deadline, beforeRequest)).rejects.toThrow();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps the caller cancellation signal connected during HTTP", async () => {
    const controller = new AbortController();
    await providerRequest("google_health", endpoint, { signal: controller.signal }, deadline);
    const options = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(options.signal?.aborted).toBe(false);
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
  });
});

describe("provider-wide cooldown persistence", () => {
  it("cancels a 429 body without parsing it, persists cooldown and honours a later shared retry time", async () => {
    const response = new Response("private error payload", { status: 429, headers: { "Retry-After": "60" } });
    const cancel = vi.spyOn(response.body!, "cancel");
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    mocks.fetch.mockResolvedValueOnce(response);
    const sharedRetryAt = new Date(now + 120_000);
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: null }]).mockResolvedValueOnce([{ retry_at: sharedRetryAt.toISOString() }]);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({ name: "ProviderRateLimitError", retryAt: sharedRetryAt });
    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);
    const [sql, params] = mocks.unsafe.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("hms_private.defer_provider_requests");
    expect(params.slice(0, 2)).toEqual(["google_health", scopeHash("google_health", "hms-test-project")]);
    expect(new Date(params[2] as string | Date).getTime()).toBe(now + 60_000);
    expect(mocks.database).toHaveBeenCalledTimes(2);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it("persists WHOOP reset-header fallback in the shared client bucket", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "90" } }));
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: null }]).mockResolvedValueOnce([{ retry_at: new Date(now + 90_000).toISOString() }]);
    await expect(providerRequest("whoop", "https://api.prod.whoop.com/developer/v2/recovery", {}, deadline)).rejects.toBeInstanceOf(ProviderRateLimitError);
    const params = mocks.unsafe.mock.calls[1][1] as unknown[];
    expect(params.slice(0, 2)).toEqual(["whoop", scopeHash("whoop", "synthetic-whoop-client")]);
    expect(new Date(params[2] as string | Date).getTime()).toBe(now + 90_000);
  });

  it("still persists vendor throttling when the HTTP response arrives after the request deadline", async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline);
      return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    });
    const retryAt = new Date(deadline + 60_000);
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: null }]).mockResolvedValueOnce([{ retry_at: retryAt.toISOString() }]);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({ name: "ProviderRateLimitError", retryAt });
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it("does not lose the shared cooldown when cancelling the error body fails", async () => {
    const response = new Response("private error payload", { status: 429, headers: { "Retry-After": "60" } });
    vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("synthetic body cancellation failure"));
    mocks.fetch.mockResolvedValueOnce(response);
    const retryAt = new Date(now + 60_000);
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: null }]).mockResolvedValueOnce([{ retry_at: retryAt.toISOString() }]);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({ name: "ProviderRateLimitError", retryAt });
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);
    expect(response.bodyUsed).toBe(false);
  });

  it("fails closed when the received vendor cooldown cannot be saved", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    mocks.unsafe.mockResolvedValueOnce([{ retry_at: null }]).mockRejectedValueOnce(new Error("synthetic-private-db-detail"));
    await expect(providerRequest("google_health", endpoint, {}, deadline)).rejects.toMatchObject({
      name: "ProviderBudgetUnavailableError", message: expect.not.stringContaining("synthetic-private-db-detail"),
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it("does not treat unrelated HTTP failures as vendor-wide cooldowns", async () => {
    const response = new Response(null, { status: 503, headers: { "Retry-After": "60" } });
    mocks.fetch.mockResolvedValueOnce(response);
    await expect(providerRequest("google_health", endpoint, {}, deadline)).resolves.toBe(response);
    expect(mocks.unsafe).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
