import {authenticatedClient,sameOrigin} from "@/src/lib/auth/server";
import {boundedJson} from "@/src/lib/ingestion/http";
import {careCommand,careRpc} from "@/src/lib/care/commands";
export async function POST(request:Request) {
  if(!sameOrigin(request))return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();if(!session)return Response.json({error:"Sign in to continue."},{status:401});
  const input=careCommand.safeParse(await boundedJson(request,32768).catch(()=>null));
  if(!input.success)return Response.json({error:"Check the care-team request."},{status:400});
  const rpc=careRpc(input.data),{data,error}=await session.client.rpc(rpc.name,rpc.args);
  if(error)return Response.json({error:error.code==="42501"?"This action is unavailable. Check current access, consent and verification.":
    error.code==="23505"?"These registration details are already in use.":"Check the details and current consult status, then try again."},
    {status:error.code==="42501"?403:error.code==="23505"?409:400});
  return Response.json({result:data},{headers:{"Cache-Control":"private, no-store"}});
}
