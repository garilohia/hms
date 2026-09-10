import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sameOrigin } from "@/src/lib/auth/server";
import { localTestLoginAllowed } from "@/src/lib/auth/test-login";
import { createClient } from "@/utils/supabase/server";

export async function POST(request:Request) {
  if(!localTestLoginAllowed(process.env.NODE_ENV,request.url))return Response.json({error:"Not found."},{status:404});
  if(!sameOrigin(request))return Response.json({error:"Request origin rejected."},{status:403});
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;
  if(!url||!key)return Response.json({error:"Local test login is not configured."},{status:503});
  const admin=createAdminClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const link=await admin.auth.admin.generateLink({type:"magiclink",email:"hms-local-testing@example.com",options:{data:{name:"Local Test User",dob:"1990-01-01"}}});
  if(link.error)return Response.json({error:"Could not prepare the test account."},{status:503});
  const profile=await admin.from("profiles").update({sex_at_birth:"prefer_not_to_say",onboarding_completed_at:new Date().toISOString()}).eq("auth_user_id",link.data.user.id).select("id").single();
  if(profile.error)return Response.json({error:"Could not prepare the test profile."},{status:503});
  const browserClient=await createClient();
  const verified=await browserClient.auth.verifyOtp({token_hash:link.data.properties.hashed_token,type:"email"});
  if(verified.error)return Response.json({error:"Could not start the test session."},{status:503});
  return NextResponse.json({next:"/today"},{headers:{"Cache-Control":"private, no-store"}});
}
