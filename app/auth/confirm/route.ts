import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { safeNextPath } from "@/src/lib/auth/validation";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  if (tokenHash) {
    const client = await createClient();
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    if (!error) return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get("next")), url.origin));
  }
  return NextResponse.redirect(new URL("/sign-in?error=link", url.origin));
}
