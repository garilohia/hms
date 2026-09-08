import { z } from "zod";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
const input = z.object({ userId: z.uuid(), action: z.enum(["read", "acknowledge", "rule", "reset_rule", "contact"]), payload: z.record(z.string(), z.unknown()).default({}) }).strict();
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = input.safeParse(await boundedJson(request, 8192).catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the settings." }, { status: 400 });
  const { userId, action, payload } = parsed.data;
  const { data, error } = await session.client.rpc("hms_alert_settings", { p_subject: userId, p_action: action, p_payload: payload });
  if (error) return Response.json({ error: error.code === "42501" ? "Only the profile owner can change alerts." : "Check the settings and retry." }, { status: error.code === "42501" ? 403 : 400 });
  if (action === "read") {
    const alerts = await session.client.rpc("hms_read_patient", { p_subject: userId, p_scope: "alerts" });
    if (alerts.error) return Response.json({ error: "Could not read alerts." }, { status: 403 });
    return Response.json({ ...data, alerts: alerts.data.alerts });
  }
  return Response.json(data);
}
