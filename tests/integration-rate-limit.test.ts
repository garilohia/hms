import { describe, expect, it } from "vitest";
import { ProviderRateLimitError, providerResponseError, providerRetryAfterSeconds } from "@/src/lib/integrations/rate-limit";

const now = new Date("2026-09-19T12:00:00.000Z");
const throttled = (headers: Record<string, string> = {}) => new Response(null, { status: 429, headers });

describe("provider throttle timing", () => {
  it("honours numeric Retry-After and rounds response headers up", () => {
    const error = providerResponseError(throttled({ "Retry-After": " 61 " }), "google_health", now)!;
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error.retryAt.toISOString()).toBe("2026-09-19T12:01:01.000Z");
    expect(providerRetryAfterSeconds(error, new Date(now.getTime() + 500))).toBe("61");
  });

  it.each([
    "Sat, 19 Sep 2026 12:02:00 GMT",
    "Saturday, 19-Sep-26 12:02:00 GMT",
    "Sat Sep 19 12:02:00 2026",
  ])("accepts an HTTP date: %s", value => {
    expect(providerResponseError(throttled({ "retry-after": value }), "whoop", now)?.retryAt.toISOString()).toBe("2026-09-19T12:02:00.000Z");
  });

  it("interprets obsolete two-digit years relative to the current century", () => {
    expect(providerResponseError(throttled({ "retry-after": "Saturday, 19-Sep-70 12:02:00 GMT" }), "whoop", now)?.retryAt.getUTCFullYear()).toBe(2070);
  });

  it("does not shorten a valid long provider cooldown", () => {
    expect(providerResponseError(throttled({ "retry-after": "172800" }), "whoop", now)?.retryAt.getTime()).toBe(now.getTime() + 2 * 86400000);
  });

  it("uses WHOOP reset seconds only when Retry-After is unavailable or invalid", () => {
    expect(providerResponseError(throttled({ "x-ratelimit-reset": "30" }), "whoop", now)?.retryAt.getTime()).toBe(now.getTime() + 30_000);
    expect(providerResponseError(throttled({ "retry-after": "invalid", "x-ratelimit-reset": "40" }), "whoop", now)?.retryAt.getTime()).toBe(now.getTime() + 40_000);
    expect(providerResponseError(throttled({ "retry-after": "70", "x-ratelimit-reset": "40" }), "whoop", now)?.retryAt.getTime()).toBe(now.getTime() + 70_000);
    expect(providerResponseError(throttled({ "x-ratelimit-reset": "30" }), "google_health", now)?.retryAt.getTime()).toBe(now.getTime() + 300_000);
  });

  it.each(["-1", "1.5", "tomorrow", "Infinity", "9".repeat(129), "1e3"])("falls back for malformed timing %s", value => {
    expect(providerResponseError(throttled({ "retry-after": value, "x-ratelimit-reset": value }), "whoop", now)?.retryAt.getTime()).toBe(now.getTime() + 300_000);
  });

  it.each(["0", "Sat, 19 Sep 2026 11:59:00 GMT"])("avoids a hot loop for an expired cooldown %s", value => {
    const error = providerResponseError(throttled({ "retry-after": value }), "whoop", now)!;
    expect(error.retryAt.getTime()).toBe(now.getTime() + 1000);
    expect(providerRetryAfterSeconds(error, new Date(now.getTime() + 5000))).toBe("1");
  });

  it("ignores timing headers on successful or unrelated error responses", () => {
    for (const status of [200, 401, 403, 500, 503]) expect(providerResponseError(new Response(null, { status, headers: { "retry-after": "60" } }), "whoop", now)).toBeNull();
  });

  it("does not retain a mutable Date supplied by the caller", () => {
    const date = new Date(now);
    const error = new ProviderRateLimitError(date);
    date.setTime(0);
    expect(error.retryAt.getTime()).toBe(now.getTime());
    expect(error.message).not.toContain("Bearer");
    expect(() => new ProviderRateLimitError(new Date(NaN))).toThrow("Invalid provider retry time");
  });
});
