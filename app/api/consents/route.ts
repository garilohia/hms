import { z } from "zod";
import { authenticatedClient, consentIpHash, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";

const input = z.object({ userId: z.uuid(), type: z.enum(["data_ingestion", "doctor_sharing", "marketing", "alert_email", "emergency_contact"]), grant: z.boolean() }).strict();
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = input.safeParse(await boundedJson(request, 4096).catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the consent details." }, { status: 400 });
  const { error } = await session.client.rpc("hms_record_consent", { p_subject: parsed.data.userId, p_type: parsed.data.type, p_grant: parsed.data.grant, p_policy: "2026-09-08", p_ip_hash: consentIpHash(request) });
  if (error) return Response.json({ error: "Only the profile owner can change consent." }, { status: 403 });
  return Response.json({ ok: true });
}
