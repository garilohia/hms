import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { Records } from "../records";
import { DataManagement } from "./management";
import { integrationStatuses } from "@/src/lib/integrations/store";

export default async function DataPage({searchParams}:{searchParams:Promise<{profile?:string;integration?:string}>}) {
  const query=await searchParams;
  const {view,profiles,session}=await patientPage("sources",query.profile);
  const connections=view.can_manage?await integrationStatuses(session.user.id,view.profile.id):[];
  const notice=query.integration==="connected"?"Wearable account connected. The first sync is queued. You can also use Sync latest 7 days below.":query.integration==="synced"?"Wearable account connected and the latest seven days were synced.":query.integration==="connected_sync_failed"?"Wearable account connected, but the first sync could not finish. Use Sync latest 7 days below to retry.":query.integration==="setup"?"This connector needs its provider credentials, token-encryption key and shared request allowance configuration before it can be linked.":query.integration==="failed"?"The wearable connection was not completed. Permission may already have been granted at the provider. To remove it, open the provider's app-permission settings and remove HMS before trying again.":query.integration==="denied"?"This profile cannot be linked without ownership and processing consent.":"";
  return <AppFrame profile={view.profile} profiles={profiles}><div className="stack">
    <h1 className="page-title">Devices &amp; data</h1>
    <p>Import an Apple Health ZIP, one CSV, or a Google Fit or Google Health Takeout CSV folder. Files are parsed on this device; only normalised readings are sent to HMS.</p>
    {notice&&<p className="card" role="status">{notice}</p>}
    {view.can_manage?<DataManagement profile={view.profile} connections={connections}/>:<Records userId={view.profile.id} section="sources" />}
    {view.can_manage&&<a className="button secondary" href={"/today?profile="+view.profile.id}>View and refresh Today</a>}
    {view.can_manage&&<section className="card stack"><h2 className="font-semibold">Your data rights</h2>
      <p>Export includes all profiles you own, including dependents. It does not include patients linked to you as a doctor or caregiver. Keep the download open until it finishes.</p>
      <a className="button secondary" href="/api/account/export">Export all owned profiles</a>
      <a className="underline" href="/account/delete">Delete account and owned profiles</a>
    </section>}
  </div></AppFrame>;
}
