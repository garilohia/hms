import { createHash, randomBytes } from "node:crypto";
import { authenticatedClient } from "@/src/lib/auth/server";
import { integrationProvider } from "@/src/lib/integrations/model";
import { callbackUrl, providerConfig } from "@/src/lib/integrations/providers";
import { seal } from "@/src/lib/integrations/crypto";
import { lockOwnedSubject, bindActor, rightsDatabase } from "@/src/lib/data-rights/server";
import { z } from "zod";
import { providerQuotaConfigured } from "@/src/lib/integrations/request-budget";

export async function GET(request: Request, context: {params: Promise<{provider: string}>}) {
  const session = await authenticatedClient();
  if (!session) return Response.redirect(new URL("/sign-in", request.url));
  const provider = integrationProvider.safeParse((await context.params).provider);
  const subject = z.uuid().safeParse(new URL(request.url).searchParams.get("profile"));
  if (!provider.success || !subject.success) return Response.redirect(new URL("/more/data?integration=invalid", request.url));
  const config = providerConfig(provider.data);
  if (!config.clientId || !config.clientSecret || !process.env.INTEGRATION_TOKEN_KEY || !providerQuotaConfigured(provider.data)) return Response.redirect(new URL(`/more/data?profile=${subject.data}&integration=setup`, request.url));
  const db = rightsDatabase();
  try { await db.begin(async tx => { await bindActor(tx, session.user.id); await lockOwnedSubject(tx, subject.data, true); }); }
  catch { return Response.redirect(new URL(`/more/data?profile=${subject.data}&integration=denied`, request.url)); }
  finally { await db.end(); }
  const redirectUri = callbackUrl(new URL(request.url).origin, provider.data);
  const verifier=provider.data==="google_health"?randomBytes(32).toString("base64url"):undefined,nonce=randomBytes(16).toString("hex");
  const state = seal({ actor: session.user.id, subject: subject.data, provider: provider.data, expiresAt: Date.now() + 10 * 60_000, nonce, verifier });
  const target = new URL(config.authorizationEndpoint);
  target.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: config.scopes.join(" "), state, access_type: "offline", prompt: provider.data === "google_health" ? "consent" : "login" }).toString();
  if(verifier){target.searchParams.set("code_challenge",createHash("sha256").update(verifier).digest("base64url"));target.searchParams.set("code_challenge_method","S256");}
  if(provider.data==="google_health")target.searchParams.set("nonce",nonce);
  return Response.redirect(target);
}
