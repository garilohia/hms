import postgres from "postgres";
import { z } from "zod";
import { authenticatedClient,sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { createSummaryStore } from "@/src/lib/jobs/summary-store";
import { runSummaryJobs } from "@/src/lib/jobs/summary-runner";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:Request) {
  if(!sameOrigin(request)) return Response.json({error:"Request origin rejected."},{status:403});
  const session=await authenticatedClient();
  if(!session) return Response.json({error:"Sign in to continue."},{status:401});
  const input=z.object({userId:z.uuid()}).safeParse(await boundedJson(request,1024).catch(()=>null));
  if(!input.success) return Response.json({error:"Choose a profile."},{status:400});
  const {data,error}=await session.client.rpc("hms_list_profiles");
  if(error || !z.array(z.object({id:z.uuid()})).parse(data).some(p=>p.id===input.data.userId)) return Response.json({error:"Owner permission required."},{status:403});
  if(!process.env.DATABASE_URL) return Response.json({error:"Summary processing is not configured."},{status:503});
  const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:5,onnotice(){}});
  try {
    const result=await runSummaryJobs(createSummaryStore(db,{subject:input.data.userId,actor:session.user.id}),{limit:3,timeBudgetMs:15000});
    return Response.json(result,{status:result.failed?503:200,headers:{"Cache-Control":"no-store"}});
  } catch {return Response.json({error:"Readings are saved. Summary processing will retry. Try refreshing later."},{status:503});}
  finally {await db.end({timeout:5});}
}
