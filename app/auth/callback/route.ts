import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { safeNextPath } from "@/src/lib/auth/validation";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const client = await createClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get("next"), "/today"), url.origin));
  }
  return NextResponse.redirect(new URL("/sign-in?error=link", url.origin));
}
