import {z} from "zod";
import {authenticatedClient} from "@/src/lib/auth/server";
import {clinicalSnapshotSchema} from "@/src/lib/care/clinical-model";
import {renderClinicalPdf,UnsupportedPdfText} from "@/src/lib/care/clinical-pdf";
export const runtime="nodejs";
export const maxDuration=60;
export async function GET(request:Request) {
  const session=await authenticatedClient();if(!session)return Response.json({error:"Sign in to download a summary."},{status:401});
  const params=new URL(request.url).searchParams;
  const input=z.object({userId:z.uuid(),days:z.enum(["30","90"]),snapshotId:z.uuid().nullable()}).safeParse({userId:params.get("profile"),days:params.get("days")||"30",snapshotId:params.get("snapshot")});
  if(!input.success)return Response.json({error:"Choose a profile and summary period."},{status:400});
  const {data,error}=await session.client.rpc("hms_clinical_summary",{p_subject:input.data.userId,p_days:Number(input.data.days),p_snapshot:input.data.snapshotId,p_create:false});
  if(error)return Response.json({error:"Summary unavailable or no longer shared."},{status:error.code==="42501"?403:503});
  const snapshot=clinicalSnapshotSchema.safeParse(data);
  if(!snapshot.success)return Response.json({error:"This summary format is unavailable."},{status:503});
  try {
    const bytes=await renderClinicalPdf(snapshot.data.body);
    return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="hms-summary-'+snapshot.data.body.to+'.pdf"',
      "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  }catch(error){return Response.json({error:error instanceof UnsupportedPdfText?"This PDF font cannot display some characters. Nothing was changed. Use the complete summary in the app.":"The PDF could not be rendered. The summary remains available in the app."},{status:error instanceof UnsupportedPdfText?422:503});}
}
