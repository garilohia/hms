import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { integrationProvider } from "@/src/lib/integrations/model";
import { syncIntegration } from "@/src/lib/integrations/sync";
import { z } from "zod";
import { processFreshHealthData } from "@/src/lib/jobs/immediate";
import { ProviderRateLimitError, providerRetryAfterSeconds } from "@/src/lib/integrations/rate-limit";

export async function POST(request:Request,context:{params:Promise<{provider:string}>}){
  if(!sameOrigin(request))return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();if(!session)return Response.json({error:"Sign in first."},{status:401});
  const provider=integrationProvider.safeParse((await context.params).provider),body=z.object({userId:z.uuid()}).strict().safeParse(await boundedJson(request,1024).catch(()=>null));
  if(!provider.success||!body.success)return Response.json({error:"Check the sync details."},{status:400});
  try{const result=await syncIntegration(session.user.id,body.data.userId,provider.data);let pipeline:unknown={state:"queued"};if(result.inserted)try{pipeline=await processFreshHealthData(session.user.id,body.data.userId);}catch{}return Response.json({...result,pipeline});}
  catch(error){
    if(error instanceof ProviderRateLimitError)return Response.json({error:error.message},{status:429,headers:{"Retry-After":providerRetryAfterSeconds(error),"Cache-Control":"no-store"}});
    return Response.json({error:"Wearable sync could not finish. Reconnect the account if the problem continues."},{status:503});
  }
}
