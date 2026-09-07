import "server-only";
import { createHmac } from "node:crypto";
import { createClient } from "@/utils/supabase/server";

export async function authenticatedClient() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { client, user: data.user };
}
export function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}
export function consentIpHash(request: Request) {
  const salt = process.env.CONSENT_IP_SALT || process.env.SUPABASE_SECRET_KEY;
  if (!salt) throw new Error("A server-side consent hash secret is required.");
  // Only a hash is persisted. Configure trusted forwarding headers at deployment.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHmac("sha256", salt).update("hms-consent-ip:" + ip).digest("hex");
}
