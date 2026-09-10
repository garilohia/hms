import { authenticatedClient, hasBearerToken } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { mobileSourceInput } from "@/src/lib/mobile/protocol";

export async function POST(request: Request) {
  if (!hasBearerToken(request)) return Response.json({ error: "A mobile bearer session is required." }, { status: 401 });
  const session = await authenticatedClient(request);
  if (!session) return Response.json({ error: "The mobile session is invalid or expired." }, { status: 401 });
  const input = mobileSourceInput.safeParse(await boundedJson(request, 16_384).catch(() => null));
  if (!input.success) return Response.json({ error: "Check the native source details." }, { status: 400 });
  const value = input.data;
  const { data, error } = await session.client.rpc("hms_connect_native_source", {
    p_subject: value.userId, p_platform: value.platform, p_installation: value.installationId,
    p_label: value.label, p_metrics: value.metrics, p_cadence: value.expectedCadenceSeconds,
  });
  if (error) return Response.json({ error: error.code === "42501" ? "Owner permission and ingestion consent are required." : "The native source could not be registered.", code: error.code }, { status: error.code === "42501" ? 403 : error.code === "22023" ? 400 : 503 });
  return Response.json({ id: data }, { headers: { "Cache-Control": "private, no-store" } });
}
