import { z } from "zod";
import { authenticatedClient,sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
const schema=z.object({userId:z.uuid(),action:z.enum(["identity","complete","cycle","period","display","timezone"]),payload:z.record(z.string(),z.unknown())});
export async function POST(request:Request) {
  if(!sameOrigin(request)) return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();
  if(!session) return Response.json({error:"Sign in to continue."},{status:401});
  const input=schema.safeParse(await boundedJson(request,8192).catch(()=>null));
  if(!input.success) return Response.json({error:"Check your details."},{status:400});
  const {userId,action,payload}=input.data;
  const {error}=await session.client.rpc("hms_profile_settings",{p_subject:userId,p_action:action,p_payload:payload});
  if(error) return Response.json({error:error.code==="42501"?"Owner permission and consent are required.":"Check your details. Adults must be 18 or older."},{status:error.code==="42501"?403:400});
  return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}});
}
