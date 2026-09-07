import { createClient } from "@/utils/supabase/server";
import { signInInput } from "@/src/lib/auth/validation";
import { sameOrigin } from "@/src/lib/auth/server";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const parsed = signInInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Check your details." }, { status: 400 });
  const input = parsed.data;
  const client = await createClient();
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const { error } = await client.auth.signInWithOtp({
    email: input.email,
    options: {
      shouldCreateUser: input.mode === "signup",
      emailRedirectTo: new URL("/auth/callback", origin).toString(),
      ...(input.mode === "signup" ? { data: { name: input.name, dob: input.dob } } : {}),
    },
  });
  if (error) return Response.json({ error: "We could not send a sign-in link. Check your details and try again shortly." }, { status: 400 });
  return Response.json({ message: "Check your email for your sign-in link." });
}
