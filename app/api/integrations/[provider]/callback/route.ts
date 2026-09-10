import { authenticatedClient } from "@/src/lib/auth/server";
import { unseal } from "@/src/lib/integrations/crypto";
import { integrationProvider } from "@/src/lib/integrations/model";
import { callbackUrl, exchangeCode } from "@/src/lib/integrations/providers";
import { saveIntegration } from "@/src/lib/integrations/store";
import { syncIntegration } from "@/src/lib/integrations/sync";
import { z } from "zod";
import { processFreshHealthData } from "@/src/lib/jobs/immediate";

const stateSchema = z.object({ actor: z.uuid(), subject: z.uuid(), provider: integrationProvider, expiresAt: z.number(), nonce: z.string().min(16), verifier:z.string().min(43).optional() });

export async function GET(request: Request, context: {params: Promise<{provider: string}>}) {
  const url = new URL(request.url);
  const session = await authenticatedClient();
  if (!session) return Response.redirect(new URL("/sign-in", request.url));
  const provider = integrationProvider.safeParse((await context.params).provider);
  const code = url.searchParams.get("code"), rawState = url.searchParams.get("state");
  try {
    if (!provider.success || !code || !rawState) throw new Error("The wearable connection was cancelled.");
    const state = stateSchema.parse(unseal(rawState));
    if (state.provider !== provider.data || state.actor !== session.user.id || state.expiresAt < Date.now()) throw new Error("The wearable connection expired.");
    const result = await exchangeCode(provider.data, code, callbackUrl(url.origin, provider.data),state.verifier,state.nonce);
    await saveIntegration(session.user.id, state.subject, provider.data, result.externalId, result.scopes, result.tokens);
    try {
      const sync=await syncIntegration(session.user.id, state.subject, provider.data);
      if(sync.inserted)try{await processFreshHealthData(session.user.id,state.subject);}catch{}
      return Response.redirect(new URL(`/more/data?profile=${state.subject}&integration=synced`, request.url));
    } catch {
      return Response.redirect(new URL(`/more/data?profile=${state.subject}&integration=connected_sync_failed`, request.url));
    }
  } catch {
    return Response.redirect(new URL("/more/data?integration=failed", request.url));
  }
}
