import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { Records } from "../records";
export default async function AdvancedPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("advanced",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Advanced</h1><div className="stack">
    {view.can_manage&&<a className="button secondary" href={"/more/alerts?profile="+view.profile.id}>Alert rules and notifications</a>}
    <a className="button secondary" href={"/more/advanced/latency?profile="+view.profile.id}>Data freshness and latency</a>
    <section className="card stack"><h2 className="font-semibold">How readiness works</h2><p>A personal trend index, not a medical assessment. Readiness and recovery use the same score.</p><p>Compare today’s resting heart rate, HRV and sleep against the median of the previous 28 calendar days. Each needs at least seven prior observations.</p><p>Resting HR: 100 − 500 × (reading / baseline − 1). HRV: 100 + 250 × (reading / baseline − 1). Sleep: 100 × reading / baseline. Clamp each to 0–100, average the three, then round.</p><p className="muted">Missing values remain missing. We do not replace them with zero. Baseline variability uses median absolute deviation (MAD). Gaps and daylight-saving changes do not create extra readings.</p></section>
    <section className="card stack"><h2 className="font-semibold">Your baselines</h2>{view.contains_sample&&<span className="badge">Sample data</span>}{view.baselines?.length?view.baselines.map(b=><div className="list-row" key={b.metric_type}><span>{b.metric_type.replaceAll("_"," ")}<span className="block muted">{b.sample_count} days, through {b.window_end??"—"}</span></span><span>{b.median?.toFixed(1)}<span className="block muted">MAD {b.mad?.toFixed(1)}</span></span></div>):<p>No baselines yet.</p>}</section>
    <Records userId={view.profile.id} section="raw" />
  </div></AppFrame>;
}
