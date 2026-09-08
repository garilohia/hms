import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { batchInput } from "@/src/lib/ingestion/model";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  let body: unknown;
  try { body = await boundedJson(request); }
  catch { return Response.json({ error: "Send a JSON batch of at most 1 MiB." }, { status: 413 }); }
  const parsed = batchInput.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Send at most 1000 valid metrics in canonical units." }, { status: 400 });
  const { userId, sourceId, metrics } = parsed.data;
  const { data, error } = await session.client.rpc("hms_ingest_batch", { p_subject: userId, p_source: sourceId, p_metrics: metrics });
  if (error) {
    const invalid = ["22023", "22P02", "22007", "22008", "23514", "23502"].includes(error.code);
    return Response.json({ error: error.code === "42501" ? "Access or ingestion consent was withdrawn. Import stopped." : invalid ? "Check this batch's units and timestamps. Readings and their measurement intervals must be complete, not in the future. Correct the device clock or retry later." : "The data service is temporarily unavailable. Re-import to resume safely.", code: error.code }, { status: error.code === "42501" ? 403 : invalid ? 400 : 503 });
  }
  return Response.json(data);
}
