import "server-only";
import { z } from "zod";
import type { IntegrationProvider, StoredTokens } from "./model";

type ProviderConfig = {
  label: string;
  clientId?: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
};

export function providerConfig(provider: IntegrationProvider): ProviderConfig {
  if (provider === "google_health") return {
    label: "Google Health",
    clientId: process.env.GOOGLE_HEALTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_HEALTH_CLIENT_SECRET,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly", "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly", "https://www.googleapis.com/auth/googlehealth.sleep.readonly", "https://www.googleapis.com/auth/googlehealth.settings.readonly"],
  };
  return {
    label: "WHOOP",
    clientId: process.env.WHOOP_CLIENT_ID,
    clientSecret: process.env.WHOOP_CLIENT_SECRET,
    authorizationEndpoint: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenEndpoint: "https://api.prod.whoop.com/oauth/oauth2/token",
    scopes: ["offline", "read:profile", "read:body_measurement", "read:cycles", "read:recovery", "read:sleep", "read:workout"],
  };
}

export function callbackUrl(origin: string, provider: IntegrationProvider) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  return `${configured || origin}/api/integrations/${provider}/callback`;
}

export async function exchangeCode(provider: IntegrationProvider, code: string, redirectUri: string, verifier?:string, nonce?:string): Promise<{tokens: StoredTokens; externalId: string; scopes: string[]}> {
  const config = providerConfig(provider);
  if (!config.clientId || !config.clientSecret) throw new Error(`${config.label} credentials are not configured.`);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId, client_secret: config.clientSecret });
  if(verifier)body.set("code_verifier",verifier);
  const response = await fetch(config.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), token_type: z.string().default("Bearer"), expires_in: z.number().positive().optional(), scope: z.string().optional(), id_token: z.string().optional() }).safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new Error(`${config.label} did not return a usable access token.`);
  const expiresAt = parsed.data.expires_in ? new Date(Date.now() + parsed.data.expires_in * 1000).toISOString() : undefined;
  let externalId: string;
  if (provider === "google_health") {
    const segment = parsed.data.id_token?.split(".")[1];
    const identity = segment ? z.object({ sub: z.string().min(1), nonce:z.string().optional() }).safeParse(JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))) : null;
    if (!identity?.success || (nonce && identity.data.nonce !== nonce)) throw new Error("Google Health did not return a valid account identity.");
    externalId = identity.data.sub;
  } else {
    const profile = await fetch("https://api.prod.whoop.com/developer/v2/user/profile/basic", { headers: { Authorization: `Bearer ${parsed.data.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const identity = z.object({ user_id: z.union([z.string(), z.number()]).transform(String) }).safeParse(await profile.json().catch(() => null));
    if (!profile.ok || !identity.success) throw new Error("WHOOP did not return an account identity.");
    externalId = identity.data.user_id;
  }
  return { externalId, scopes: (parsed.data.scope || config.scopes.join(" ")).split(" ").filter(Boolean), tokens: { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, tokenType: parsed.data.token_type, expiresAt } };
}

export async function refreshAccessToken(provider: IntegrationProvider, current: StoredTokens): Promise<StoredTokens> {
  if (!current.refreshToken) throw new Error(`${providerConfig(provider).label} must be connected again.`);
  const config = providerConfig(provider);
  if (!config.clientId || !config.clientSecret) throw new Error(`${config.label} credentials are not configured.`);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: config.clientId, client_secret: config.clientSecret });
  const response = await fetch(config.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), token_type: z.string().default(current.tokenType), expires_in: z.number().positive().optional() }).safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new Error(`${config.label} access could not be refreshed.`);
  return { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token || current.refreshToken, tokenType: parsed.data.token_type,
    expiresAt: parsed.data.expires_in ? new Date(Date.now() + parsed.data.expires_in * 1000).toISOString() : undefined };
}
