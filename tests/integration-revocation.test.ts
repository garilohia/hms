import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { revokeProviderAccess } from "@/src/lib/integrations/revocation";
import { exchangeCode, providerConfig, refreshAccessToken } from "@/src/lib/integrations/providers";
import { ProviderRateLimitError } from "@/src/lib/integrations/rate-limit";

const tokens = { accessToken: "test-access", refreshToken: "test-refresh", tokenType: "Bearer" };

describe("provider access revocation", () => {
  beforeEach(() => {
    vi.stubEnv("WHOOP_CLIENT_ID", "test-client");
    vi.stubEnv("WHOOP_CLIENT_SECRET", "test-secret");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("posts Google's refresh token in the body and confirms only HTTP 200", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    expect(await revokeProviderAccess("google_health", tokens)).toEqual({ revoked: true, tokens });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(options.method).toBe("POST");
    expect(options.body.toString()).toBe("token=test-refresh");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("can revoke a Google grant without a refresh token", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    await revokeProviderAccess("google_health", { accessToken: "only-access", tokenType: "Bearer" });
    expect(request.mock.calls[0][1].body.toString()).toBe("token=only-access");
  });

  it.each([400, 401, 429, 500])("retains credentials when Google returns %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    expect(await revokeProviderAccess("google_health", tokens)).toEqual({ revoked: false, tokens });
  });

  it("uses WHOOP's DELETE endpoint without unnecessarily rotating tokens", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);
    expect((await revokeProviderAccess("whoop", tokens)).revoked).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("https://api.prod.whoop.com/developer/v2/user/access", expect.objectContaining({ method: "DELETE", headers: { Authorization: "Bearer test-access" } }));
  });

  it("refreshes once after a WHOOP 401, retains rotated tokens after a failed retry, and uses one deadline", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", request);
    const result = await revokeProviderAccess("whoop", tokens);
    expect(result.revoked).toBe(false);
    expect(result.tokens).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(request.mock.calls[1][1].body.get("scope")).toBe("offline");
    expect(request.mock.calls[2][1].headers.Authorization).toBe("Bearer new-access");
    expect(new Set(request.mock.calls.map(call => call[1].signal)).size).toBe(1);
  });

  it("does not mistake an expired WHOOP access token for revoked provider consent", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", request);
    const withoutRefresh = { accessToken: "expired-access", tokenType: "Bearer" };
    expect(await revokeProviderAccess("whoop", withoutRefresh)).toEqual({ revoked: false, tokens: withoutRefresh });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials on network failure without exposing the provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private provider response")));
    expect(await revokeProviderAccess("whoop", tokens)).toEqual({ revoked: false, tokens });
  });

  it("requests only the provider permissions that current ingestion uses", () => {
    expect(providerConfig("whoop").scopes).toEqual(["offline", "read:profile", "read:cycles", "read:recovery", "read:sleep"]);
    expect(providerConfig("google_health").scopes.some(scope => scope.endsWith("settings.readonly"))).toBe(false);
  });

  it("shares the code-exchange deadline across WHOOP tokens and identity requests", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh" })).mockResolvedValueOnce(Response.json({ user_id: 123 }));
    vi.stubGlobal("fetch", request);
    const result = await exchangeCode("whoop", "test-code", "https://hms.example/callback");
    expect(result.externalId).toBe("123");
    expect(request.mock.calls[0][1].signal).toBe(request.mock.calls[1][1].signal);
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });

  it("preserves offline access when refreshing a WHOOP sync token", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ access_token: "new-access", refresh_token: "new-refresh" }));
    vi.stubGlobal("fetch", request);
    expect((await refreshAccessToken("whoop", tokens)).refreshToken).toBe("new-refresh");
    expect(request.mock.calls[0][1].body.get("scope")).toBe("offline");
  });

  it("does not start token refresh after the invocation deadline", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(refreshAccessToken("whoop", tokens, Date.now() - 1)).rejects.toThrow("queued for the next sync");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["google_health", "whoop"] as const)("preserves %s refresh Retry-After without parsing the response body", async provider => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    vi.stubEnv("GOOGLE_HEALTH_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_HEALTH_CLIENT_SECRET", "test-secret");
    const response = new Response("Provider error body must not be read", { status: 429, headers: { "Retry-After": "900" } });
    const parseBody = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(refreshAccessToken(provider, tokens)).rejects.toMatchObject({ name: "ProviderRateLimitError", retryAt: new Date("2026-09-19T12:15:00Z") });
    expect(parseBody).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses WHOOP reset headers when refresh throttling omits Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    const response = new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "60" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const result = refreshAccessToken("whoop", tokens);
    await expect(result).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(result).rejects.toMatchObject({ retryAt: new Date("2026-09-19T12:01:00Z") });
    expect(response.bodyUsed).toBe(false);
  });
});
