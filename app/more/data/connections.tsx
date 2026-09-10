"use client";
import { useState } from "react";
import type { IntegrationStatus } from "@/src/lib/integrations/model";

type Card = {key:string;name:string;devices:string;detail:string;mode:"oauth"|"import"|"partner";freshness:string;cadence:string};
const cards: Card[] = [
  { key:"google_health", name:"Google Health ecosystem", devices:"Fitbit Air, Fitbit, Pixel Watch and devices exposed through Google Health", detail:"Read-only account connection for activity, measurements and sleep. HMS starts processing immediately after new data reaches Google.", mode:"oauth",freshness:"Near real-time target: within 1 minute after Google makes data available",cadence:"Heart rate and activity can be intraday; HRV, SpO₂, resting heart rate and sleep temperature are daily or sleep-derived." },
  { key:"whoop", name:"WHOOP", devices:"WHOOP 4.0, 5.0 and MG", detail:"Read-only recovery, cycle, sleep, workout and body-measurement data.", mode:"oauth",freshness:"Near real-time for completed cloud events; not continuous heart-rate API data",cadence:"Workout, sleep and recovery updates arrive after WHOOP processes them." },
  { key:"apple", name:"Apple Health ecosystem", devices:"Apple Watch, Oura, Ultrahuman, RingConn, Garmin, Polar, Suunto, COROS, Withings and apps that write HealthKit", detail:"HealthKit cannot be read by a website. The existing private ZIP importer covers historical data; continuous delivery requires a future native iPhone companion.", mode:"import",freshness:"Manual today; native background delivery later",cadence:"Live heart rate is workout-session based. Other samples arrive according to HealthKit background delivery and the originating device." },
  { key:"android", name:"Android Health Connect ecosystem", devices:"Samsung Galaxy, Xiaomi, Amazfit/Zepp, Huawei, OnePlus, Mobvoi, Fossil and compatible apps", detail:"Health Connect is an on-device Android interface, not browser OAuth. Google Health/Takeout covers supported cloud data; continuous device access requires a native Android companion.", mode:"import",freshness:"Manual or hub-dependent today; native background sync later",cadence:"Each source app controls when it writes readings to Health Connect." },
  { key:"scales", name:"Smart scales & body composition", devices:"Withings Body, Garmin Index, Fitbit Aria, RENPHO, Eufy, Wyze, QardioBase, Omron, Tanita, InBody and Xiaomi", detail:"Weight and body-fat readings can enter through Apple Health, Google Health, Garmin/Withings partner feeds, or canonical CSV. Scale apps decide how quickly readings reach their hub.", mode:"import",freshness:"Event-based after each weigh-in; usually seconds to minutes after cloud sync",cadence:"A scale is not a continuous monitor: one update is produced per completed measurement." },
  { key:"garmin", name:"Garmin Health", devices:"Garmin watches, bands, Edge devices and Index scales", detail:"The Health API supports push delivery after Garmin Connect sync. Direct and real-time SDK access requires Garmin approval and commercial licensing.", mode:"partner",freshness:"Cloud push after sync; live streams through a licensed native SDK",cadence:"Live SDK metrics and all-day Garmin Connect summaries are separate feeds." },
  { key:"oura", name:"Oura", devices:"Oura Ring generations with Oura Cloud", detail:"Oura offers near-real-time cloud webhooks after the ring syncs, but a production app and webhook credentials must be approved and configured.", mode:"partner",freshness:"About 30 seconds after app sync",cadence:"Daily activity may sync in the background; sleep and readiness can wait for an app sync." },
  { key:"withings", name:"Withings", devices:"Watches, Body scales, BPM monitors, Sleep Analyzer and Thermo", detail:"Withings notifications can call HMS when a new cloud measurement arrives. Production OAuth and notification subscriptions require provider setup.", mode:"partner",freshness:"Webhook after cloud receipt",cadence:"Event-based measurements rather than a single continuous multi-metric stream." },
  { key:"clinical", name:"Clinical sensors", devices:"Dexcom, FreeStyle Libre, Omron, Qardio, iHealth and supported remote-monitoring platforms", detail:"These feeds require regulated partner programmes, patient consent and vendor-specific agreements. The HMS ingestion boundary already accepts glucose, blood pressure, temperature and heart metrics in canonical units.", mode:"partner",freshness:"Vendor and regulatory programme dependent",cadence:"CGMs may produce minute-level samples; cuffs and thermometers produce readings only when used." },
  { key:"fitness", name:"Fitness & training platforms", devices:"Strava, TrainingPeaks, Peloton, Zwift, Wahoo, Concept2, Polar Flow, Suunto and COROS", detail:"Use the device's Apple/Google health bridge or export today. Direct links need individual provider applications and must not be presented as active before approval.", mode:"import",freshness:"Usually after an activity or hub sync",cadence:"Designed for completed activities, not continuous safety monitoring." },
];

export function WearableConnections({profileId,initial}:{profileId:string;initial:IntegrationStatus[]}) {
  const [statuses,setStatuses]=useState(initial),[busy,setBusy]=useState(""),[message,setMessage]=useState("");
  async function disconnect(provider:"google_health"|"whoop") {
    setBusy(provider); setMessage("");
    try {
      const response=await fetch(`/api/integrations/${provider}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:profileId})});
      if(!response.ok)throw new Error();
      setStatuses(current=>current.map(status=>status.provider===provider?{...status,connected:false,lastSyncAt:null}:status));
      setMessage("HMS connection removed. Previously imported readings remain in your history; you can also revoke HMS in the provider's account settings.");
    } catch { setMessage("Could not remove the connection. Please retry."); }
    finally { setBusy(""); }
  }
  async function sync(provider:"google_health"|"whoop") {
    setBusy(provider);setMessage("");
    try{const response=await fetch(`/api/integrations/${provider}/sync`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:profileId})});const result=await response.json() as {inserted?:number;skipped?:number};if(!response.ok)throw new Error();setStatuses(current=>current.map(status=>status.provider===provider?{...status,lastSyncAt:new Date().toISOString()}:status));setMessage(`${result.inserted??0} readings added; ${result.skipped??0} already present.`);}catch{setMessage("Wearable sync could not finish. Reconnect the account if the problem continues.");}finally{setBusy("");}
  }
  return <section className="card stack"><div><h2 className="type-section">Link a wearable</h2><p className="muted">HMS connects to the account or health platform, so one link can cover several watches, bands or rings.</p></div>
    <div className="connection-grid">{cards.map(card=>{const status=statuses.find(item=>item.provider===card.key);return <article className="connection-card" key={card.key}>
      <div><h3>{card.name}</h3><p className="muted">{card.devices}</p></div><p>{card.detail}</p><p className="muted"><strong>Delivery:</strong> {card.freshness}</p><p className="muted"><strong>Metric cadence:</strong> {card.cadence}</p>
      {card.mode==="oauth"&&status?.connected&&<><span className="badge">Connected</span>{status.lastSyncAt&&<p className="muted">Last sync {new Date(status.lastSyncAt).toLocaleString()}</p>}<button className="button" disabled={busy===card.key} onClick={()=>void sync(card.key as "google_health"|"whoop")}>Sync latest 7 days</button><button className="button secondary" disabled={busy===card.key} onClick={()=>void disconnect(card.key as "google_health"|"whoop")}>Disconnect</button></>}
      {card.mode==="oauth"&&!status?.connected&&status?.configured&&<a className="button" href={`/api/integrations/${card.key}/connect?profile=${profileId}`}>Connect {card.name}</a>}
      {card.mode==="oauth"&&!status?.connected&&!status?.configured&&<span className="badge">Setup required</span>}
      {card.mode==="import"&&<a className="button secondary" href="#health-import">Import health data</a>}
      {card.mode==="partner"&&<span className="badge">Partner access required</span>}
    </article>})}</div>{message&&<p role="status">{message}</p>}
    <p className="muted">Connections request read-only health scopes. HMS never asks for permission to write back to a wearable account. The delivery target begins when a provider makes a reading available; the device-to-phone-to-cloud leg is measured separately. “Supported” means there is an honest ingestion path; partner-gated APIs do not become active until the vendor approves HMS.</p>
  </section>;
}
