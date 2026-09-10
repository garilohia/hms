import { z } from "zod";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";

const input = z.object({
  userId: z.uuid(),
  action: z.enum(["read", "upsert", "remove"]),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = input.safeParse(await boundedJson(request, 8192).catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the monitoring rule." }, { status: 400 });
  const { userId, action, payload } = parsed.data;
  const { data, error } = await session.client.rpc("hms_monitor_rules", { p_subject: userId, p_action: action, p_payload: payload });
  if (error) {
    const forbidden = error.code === "42501";
    return Response.json({ error: forbidden ? "Active alert-sharing access is required." : "Check the monitoring rule and retry." }, { status: forbidden ? 403 : 400 });
  }
  if (action === "read") {
    const status = await session.client.rpc("hms_monitor_delivery_status", { p_subject: userId });
    if (status.error) return Response.json({ error: "Could not load notification status." }, { status: 403 });
    return Response.json({ ...data, ...status.data });
  }
  return Response.json(data);
}
