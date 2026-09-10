import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { integrationProvider } from "@/src/lib/integrations/model";
import { removeIntegration } from "@/src/lib/integrations/store";
import { z } from "zod";

export async function DELETE(request: Request, context: {params: Promise<{provider: string}>}) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const provider = integrationProvider.safeParse((await context.params).provider);
  const body = z.object({ userId: z.uuid() }).strict().safeParse(await boundedJson(request, 1024).catch(() => null));
  if (!provider.success || !body.success) return Response.json({ error: "Check the connection details." }, { status: 400 });
  try { await removeIntegration(session.user.id, body.data.userId, provider.data); }
  catch { return Response.json({ error: "The wearable connection could not be removed." }, { status: 403 }); }
  return Response.json({ ok: true });
}
