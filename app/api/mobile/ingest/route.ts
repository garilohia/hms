import { z } from "zod";
import { authenticatedClient, hasBearerToken } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { mobileBatchInput } from "@/src/lib/mobile/protocol";
import { processFreshHealthData } from "@/src/lib/jobs/immediate";

export async function POST(request: Request) {
  if (!hasBearerToken(request)) return Response.json({ error: "A mobile bearer session is required." }, { status: 401 });
  const session = await authenticatedClient(request);
  if (!session) return Response.json({ error: "The mobile session is invalid or expired." }, { status: 401 });
  const input = mobileBatchInput.safeParse(await boundedJson(request).catch(() => null));
  if (!input.success) return Response.json({ error: "Send a valid protocol-v1 batch of at most 1,000 canonical readings." }, { status: 400 });
  const value = input.data;
  const { data, error } = await session.client.rpc("hms_ingest_native_batch", {
    p_subject: value.userId, p_source: value.sourceId, p_batch: value.batchId, p_metrics: value.metrics,
  });
  if (error) {
    const invalid = ["22023", "22P02", "22007", "22008", "23514", "23502"].includes(error.code);
    return Response.json({ error: error.code === "42501" ? "Access or ingestion consent was withdrawn." : invalid ? "The batch contains invalid units, timestamps, or source details." : "The data service is temporarily unavailable.", code: error.code }, { status: error.code === "42501" ? 403 : invalid ? 400 : 503 });
  }
  const result = zResult(data);
  if (result.replayed || result.inserted === 0 || !value.metrics.some(metric => Date.now() - Date.parse(metric.recorded_at) >= 0 && Date.now() - Date.parse(metric.recorded_at) <= 5 * 60_000)) return Response.json(result);
  try { return Response.json({ ...result, pipeline: await processFreshHealthData(session.user.id, value.userId) }); }
  catch { return Response.json({ ...result, pipeline: { state: "queued" } }); }
}

function zResult(value: unknown) {
  const row = z.object({
    inserted: z.coerce.number().int().nonnegative(),
    skipped: z.coerce.number().int().nonnegative(),
    replayed: z.boolean(),
    batch_id: z.uuid(),
  }).parse(value);
  return { inserted: row.inserted, skipped: row.skipped, replayed: row.replayed, batchId: row.batch_id };
}
