import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { sameOrigin } from "@/src/lib/auth/server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const client = await createClient();
  const { error } = await client.auth.signOut();
  if (error) return Response.json({ error: "Sign-out failed. Please retry." }, { status: 503 });
  return NextResponse.redirect(new URL("/sign-in", request.url), 303);
}
