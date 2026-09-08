import {z} from "zod";
import {authenticatedClient,consentIpHash,sameOrigin} from "@/src/lib/auth/server";
import {boundedJson} from "@/src/lib/ingestion/http";
export async function POST(request:Request) {
  if(!sameOrigin(request))return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();if(!session)return Response.json({error:"Sign in to continue."},{status:401});
  const input=z.object({userId:z.uuid(),action:z.enum(["offer","accept","cancel"]),data:z.record(z.string(),z.unknown())}).safeParse(await boundedJson(request,8192).catch(()=>null));
  if(!input.success)return Response.json({error:"Check the transfer request."},{status:400});
  const {data,error}=await session.client.rpc("hms_transfer_change",{p_subject:input.data.userId,p_action:input.data.action,p_data:input.data.data,p_policy:"2026-09-08",p_ip_hash:consentIpHash(request)});
  if(error)return Response.json({error:error.code==="42501"?"Transfer unavailable. The dependent must be 18, the recipient account confirmed with the same DOB, and the offer current.":
    "All confirmations are required. The recipient must have an empty signup profile with no health data, consent records, sharing, doctor registration or dependents. Nothing has been replaced."},{status:error.code==="42501"?403:400});
  return Response.json({id:data},{headers:{"Cache-Control":"private, no-store"}});
}
