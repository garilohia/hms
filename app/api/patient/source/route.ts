import {z} from "zod";
import {authenticatedClient,sameOrigin} from "@/src/lib/auth/server";
import {boundedJson} from "@/src/lib/ingestion/http";
export async function POST(request:Request) {
  if(!sameOrigin(request))return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();if(!session)return Response.json({error:"Sign in to continue."},{status:401});
  const input=z.object({userId:z.uuid(),sourceId:z.uuid()}).safeParse(await boundedJson(request,1024).catch(()=>null));
  if(!input.success)return Response.json({error:"Choose a source."},{status:400});
  const {data,error}=await session.client.rpc("hms_patient_source",{p_subject:input.data.userId,p_source:input.data.sourceId});
  if(error)return Response.json({error:"Source details are unavailable or no longer shared."},{status:403});
  return Response.json(data,{headers:{"Cache-Control":"private, no-store"}});
}
