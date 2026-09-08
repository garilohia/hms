import {z} from "zod";
import {ownedProfiles} from "@/src/lib/patient/server";
import {careRead} from "@/src/lib/care/server";
import {doctorAccountSchema,listSchema,patientLinkSchema,consultRowSchema} from "@/src/lib/care/model";
import {AppFrame} from "../ui/frame";
import {DoctorRegistration} from "./registration";
export default async function DoctorPage({searchParams}:{searchParams:Promise<{patients?:string;consults?:string}>}) {
  const {profiles}=await ownedProfiles(),params=await searchParams;
  const account=doctorAccountSchema.parse(await careRead({kind:"doctor",action:"read"}));
  const patientCursor=params.patients?z.uuid().parse(params.patients):undefined;
  const consultCursor=params.consults?z.record(z.string(),z.string()).parse(JSON.parse(params.consults)):undefined;
  const patients=account.doctor?.verified_at?listSchema(patientLinkSchema).parse(await careRead({kind:"list",section:"patients",cursor:patientCursor})):null;
  const consults=account.doctor?.verified_at?listSchema(consultRowSchema).parse(await careRead({kind:"consult_list",cursor:consultCursor})):null;
  return <AppFrame profile={profiles.find(p=>p.kind==="self")} profiles={profiles}><h1 className="page-title">Doctor portal</h1><div className="stack">
    {patients&&<section className="card stack"><h2>Your patients</h2>{patients.rows.length?patients.rows.map(p=><div key={p.id} className="stack"><h3>{p.name}</h3><p className="muted">DOB {p.dob} · {p.granted_scopes.join(", ")}</p>
      <a className="button secondary" href={"/summary?profile="+p.id}>Clinical summary</a>
      {p.granted_scopes.includes("full_history")&&<a href={"/history?profile="+p.id}>Read-only History</a>}
      {p.granted_scopes.includes("alerts")&&<a href={"/doctor/alerts?profile="+p.id}>Unusual readings</a>}
    </div>):<p className="muted">No patients currently share data with you.</p>}{patients.next_cursor&&<a href={"/doctor?patients="+patients.next_cursor}>Next patients</a>}</section>}
    {consults&&<section className="card stack"><h2>Consult queue</h2>{consults.rows.length?consults.rows.map(c=><a className="list-row" key={c.id} href={"/consults/"+c.id}>{c.patient_name} · {c.type.replaceAll("_"," ")} · {c.status}</a>):<p className="muted">No consult requests.</p>}
      {consults.next_cursor&&<a href={"/doctor?consults="+encodeURIComponent(JSON.stringify(consults.next_cursor))}>Earlier consults</a>}</section>}
    <DoctorRegistration initial={account.doctor}/>
  </div></AppFrame>;
}
