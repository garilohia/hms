import "server-only";
import { redirect,notFound } from "next/navigation";
import { z } from "zod";
import { authenticatedClient } from "../auth/server";
import { profileSchema,viewSchema,type ViewSection } from "./model";
import { localDay } from "../analytics/time";

export async function ownedProfiles() {
  const session=await authenticatedClient();
  if(!session) redirect("/sign-in");
  const deletion=await session.client.rpc("hms_account_deletion_status");
  if(!deletion.error&&z.object({pending:z.boolean()}).parse(deletion.data).pending)redirect("/account/delete");
  const {data,error}=await session.client.rpc("hms_list_profiles");
  if(error) throw new Error("We could not load your profiles.");
  return {session,profiles:z.array(profileSchema).parse(data)};
}
export async function patientPage(section:ViewSection,requested?:string) {
  const {session,profiles}=await ownedProfiles();
  const id=requested || profiles.find(p=>p.kind==="self")?.id;
  if(!id || !z.uuid().safeParse(id).success) notFound();
  const {data,error}=await session.client.rpc("hms_patient_view",{p_subject:id,p_section:section});
  if(error?.code==="42501") notFound();
  if(error) throw new Error("Patient view temporarily unavailable ("+error.code+").");
  const view=viewSchema.parse(data);
  if(section==="advanced") {
    const latest=await session.client.rpc("hms_patient_view",{p_subject:id,p_section:"today"});
    if(latest.error?.code==="42501") notFound();
    if(latest.error) throw new Error("Patient view temporarily unavailable ("+latest.error.code+").");
    view.contains_sample=viewSchema.parse(latest.data).contains_sample;
  }
  // Capture one request-time local date and serialise it with the private view.
  return {view,profiles,session,today:localDay(Date.now(),view.profile.timezone)};
}
