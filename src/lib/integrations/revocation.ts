import "server-only";
import { z } from "zod";
import type { IntegrationProvider, StoredTokens } from "./model";
import { providerConfig } from "./providers";

export type RevocationResult = { revoked: boolean; tokens: StoredTokens };

/** One deadline covers revocation, a possible WHOOP refresh, and the retry. */
export async function revokeProviderAccess(provider: IntegrationProvider, current: StoredTokens): Promise<RevocationResult> {
  const signal = AbortSignal.timeout(12_000);
  let tokens = current;
  try {
    if (provider === "google_health") {
      // A refresh token revokes the grant even when its access token has expired.
      // Google revokes this application's grant across its OAuth clients.
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken || tokens.accessToken }),
        cache: "no-store", redirect: "error", signal,
      });
      return { revoked: response.status === 200, tokens };
    }

    const revoke = () => fetch("https://api.prod.whoop.com/developer/v2/user/access", {
      method: "DELETE", headers: { Authorization: `Bearer ${tokens.accessToken}` },
      cache: "no-store", redirect: "error", signal,
    });
    let response = await revoke();
    if (response.status === 401 && tokens.refreshToken) {
      const config = providerConfig(provider);
      if (!config.clientId || !config.clientSecret) return { revoked: false, tokens };
      const refreshed = await fetch(config.tokenEndpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: config.clientId, client_secret: config.clientSecret, scope: "offline" }),
        cache: "no-store", redirect: "error", signal,
      });
      const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), token_type: z.string().default(tokens.tokenType), expires_in: z.number().positive().optional() }).safeParse(await refreshed.json().catch(() => null));
      if (!refreshed.ok || !parsed.success) return { revoked: false, tokens };
      tokens = { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token || tokens.refreshToken, tokenType: parsed.data.token_type, expiresAt: parsed.data.expires_in ? new Date(Date.now() + parsed.data.expires_in * 1000).toISOString() : undefined };
      response = await revoke();
    }
    // A 401 alone is not proof of revoked permission: the access token may only
    // have expired. Keep the latest rotated credentials for an explicit retry.
    return { revoked: response.status === 204, tokens };
  } catch {
    return { revoked: false, tokens };
  }
}
