import { authenticatedClient, consentIpHash, sameOrigin } from "@/src/lib/auth/server";
import { dependentInput } from "@/src/lib/auth/validation";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = dependentInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the dependent's details and give guardian consent." }, { status: 400 });
  const { data, error } = await session.client.rpc("hms_create_dependent", {
    p_name: parsed.data.name, p_dob: parsed.data.dob, p_policy: "2026-09-08", p_ip_hash: consentIpHash(request),
  });
  if (error) return Response.json({ error: "We could not create this dependent profile." }, { status: 400 });
  return Response.json({ id: data }, { status: 201 });
}
