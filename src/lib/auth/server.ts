import "server-only";
import { createHmac } from "node:crypto";
import { createClient as createTokenClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "@/utils/supabase/server";
import { getPublicEnvironment } from "../config/public-env";

function bearerToken(request?: Request) {
  const header = request?.headers.get("authorization") || "";
  const match = /^Bearer ([^\s]{20,8192})$/.exec(header);
  return match?.[1] ?? null;
}

export function hasBearerToken(request: Request) {
  return bearerToken(request) !== null;
}

export async function authenticatedClient(request?: Request) {
  const token = bearerToken(request);
  const client = token
    ? (() => {
        const { url, publishableKey } = getPublicEnvironment();
        return createTokenClient(url, publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
      })()
    : await createCookieClient();
  const { data, error } = await client.auth.getUser(token ?? undefined);
  if (error || !data.user) return null;
  return { client, user: data.user };
}
export function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}
export function authenticatedMutationOrigin(request: Request) {
  return sameOrigin(request) || bearerToken(request) !== null;
}
export function consentIpHash(request: Request) {
  const salt = process.env.CONSENT_IP_SALT || process.env.SUPABASE_SECRET_KEY;
  if (!salt) throw new Error("A server-side consent hash secret is required.");
  // Only a hash is persisted. Configure trusted forwarding headers at deployment.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHmac("sha256", salt).update("hms-consent-ip:" + ip).digest("hex");
}
