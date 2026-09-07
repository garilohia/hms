import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { sourceInput } from "@/src/lib/ingestion/model";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = sourceInput.safeParse(await boundedJson(request, 4096).catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the data source details." }, { status: 400 });
  const { data, error } = await session.client.rpc("hms_connect_source", { p_subject: parsed.data.userId, p_provider: parsed.data.provider, p_key: parsed.data.key });
  if (error) return Response.json({ error: error.code === "42501" ? "An owned profile and ingestion consent are required." : "The data source could not be connected. Try again.", code: error.code }, { status: error.code === "42501" ? 403 : error.code === "22023" ? 400 : 503 });
  return Response.json({ id: data });
}
