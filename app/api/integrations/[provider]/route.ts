import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { integrationProvider } from "@/src/lib/integrations/model";
import { removeIntegration } from "@/src/lib/integrations/store";
import { z } from "zod";
import { AccessError, privateHeaders } from "@/src/lib/data-rights/server";

export const maxDuration = 45;

export async function DELETE(request: Request, context: {params: Promise<{provider: string}>}) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const provider = integrationProvider.safeParse((await context.params).provider);
  const body = z.object({ userId: z.uuid(), providerAccessRemoved: z.literal(true).optional() }).strict().safeParse(await boundedJson(request, 1024).catch(() => null));
  if (!provider.success || !body.success) return Response.json({ error: "Check the connection details." }, { status: 400 });
  try {
    const result = await removeIntegration(session.user.id, body.data.userId, provider.data, body.data.providerAccessRemoved === true);
    return Response.json({ ok: true, ...result }, { status: result.revocationPending ? 202 : 200, headers: privateHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof AccessError ? "Only the profile owner can remove this connection." : "The wearable connection could not be removed. Please retry." }, { status: error instanceof AccessError ? 403 : 503, headers: privateHeaders });
  }
}
