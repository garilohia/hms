import { authenticatedClient,sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { viewInput } from "@/src/lib/patient/model";
export async function POST(request:Request) {
  if(!sameOrigin(request)) return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();
  if(!session) return Response.json({error:"Sign in to continue."},{status:401});
  const input=viewInput.safeParse(await boundedJson(request,4096).catch(()=>null));
  if(!input.success) return Response.json({error:"Check the requested profile and dates."},{status:400});
  const p=input.data;
  const {data,error}=await session.client.rpc("hms_patient_view",{p_subject:p.userId,p_section:p.section,p_from:p.from??null,p_to:p.to??null,p_cursor:p.cursor??null});
  if(error) return Response.json({error:error.code==="42501"?"You do not have access to this view.":"We could not load this view. Try again."},{status:error.code==="42501"?403:400});
  return Response.json(data,{headers:{"Cache-Control":"private, no-store"}});
}
