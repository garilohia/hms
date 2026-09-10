import { z } from "zod";
import { authenticatedClient, hasBearerToken } from "@/src/lib/auth/server";
import { profileSchema } from "@/src/lib/patient/model";
import { MOBILE_PROTOCOL_VERSION, nativePlatforms } from "@/src/lib/mobile/protocol";
import { BATCH_SIZE, MAX_BODY_BYTES, metricTypes, units } from "@/src/lib/ingestion/model";

export async function GET(request: Request) {
  if (!hasBearerToken(request)) return Response.json({ error: "A mobile bearer session is required." }, { status: 401 });
  const session = await authenticatedClient(request);
  if (!session) return Response.json({ error: "The mobile session is invalid or expired." }, { status: 401 });
  const { data, error } = await session.client.rpc("hms_list_profiles");
  if (error) return Response.json({ error: "Profiles are temporarily unavailable." }, { status: 503 });
  return Response.json({
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    platforms: nativePlatforms,
    profiles: z.array(profileSchema).parse(data),
    ingestion: { sourceEndpoint: "/api/mobile/sources", batchEndpoint: "/api/mobile/ingest", maxRecords: BATCH_SIZE, maxBytes: MAX_BODY_BYTES, metricTypes, units },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
