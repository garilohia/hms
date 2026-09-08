import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
export default async function MorePage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  const suffix="?profile="+view.profile.id;
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">More</h1><div className="stack">
    <section className="card">{[["Devices & data","/more/data"],["Cycle tracking","/more/cycle"],["Advanced","/more/advanced"]].map(([name,href])=><a className="list-row" key={href} href={href+suffix}><span>{name}</span><span aria-hidden>↗</span></a>)}<a className="list-row" href="/account">Your account <span aria-hidden>↗</span></a><a className="list-row" href="/legal/disclaimer">Health disclaimer <span aria-hidden>↗</span></a></section>
    <section className="card stack"><h2 className="font-semibold">Install HMS</h2><p className="muted">In Chrome, use the address-bar install option or menu → Install app. On iPhone, use Safari → Share → Add to Home Screen. A connection is required; health data is not saved for offline use.</p></section>
    <form method="post" action="/api/auth/sign-out"><button className="button secondary">Sign out</button></form>
  </div></AppFrame>;
}
