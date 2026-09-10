"use client";
import { useState } from "react";
import type { IntegrationStatus } from "@/src/lib/integrations/model";

type Card = {key:string;name:string;devices:string;detail:string;mode:"oauth"|"import"|"partner"};
const cards: Card[] = [
  { key:"google_health", name:"Google Health", devices:"Fitbit Air, Fitbit, Pixel Watch and supported Google Health devices", detail:"Links your Google account with read-only activity, measurements, sleep and paired-device access.", mode:"oauth" },
  { key:"whoop", name:"WHOOP", devices:"WHOOP 4.0, 5.0 and MG", detail:"Links read-only recovery, cycle, sleep, workout and body-measurement data.", mode:"oauth" },
  { key:"apple", name:"Apple Watch", devices:"Every Apple Watch that writes to Apple Health", detail:"Apple has no browser OAuth for HealthKit. Export from Apple Health and import the ZIP below; it stays on this device while being parsed.", mode:"import" },
  { key:"garmin", name:"Garmin", devices:"Garmin watches and trackers through Garmin Connect", detail:"Live Health API access requires Garmin developer approval and a commercial agreement. The adapter boundary is reserved; use an export until HMS is approved.", mode:"partner" },
  { key:"other", name:"Other wearables", devices:"Samsung, Oura, Ultrahuman, Amazfit, Withings and more", detail:"Use Apple Health, Google Health/Takeout or a supported CSV export below. Direct vendor links are added only when their user OAuth and agreements are available.", mode:"import" },
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
  return <section className="card stack"><div><h2 className="text-lg font-semibold">Link a wearable</h2><p className="muted">HMS connects to the account or health platform, so one link can cover several watches, bands or rings.</p></div>
    <div className="connection-grid">{cards.map(card=>{const status=statuses.find(item=>item.provider===card.key);return <article className="connection-card" key={card.key}>
      <div><h3>{card.name}</h3><p className="muted">{card.devices}</p></div><p>{card.detail}</p>
      {card.mode==="oauth"&&status?.connected&&<><span className="badge">Connected</span>{status.lastSyncAt&&<p className="muted">Last sync {new Date(status.lastSyncAt).toLocaleString()}</p>}<button className="button" disabled={busy===card.key} onClick={()=>void sync(card.key as "google_health"|"whoop")}>Sync latest 7 days</button><button className="button secondary" disabled={busy===card.key} onClick={()=>void disconnect(card.key as "google_health"|"whoop")}>Disconnect</button></>}
      {card.mode==="oauth"&&!status?.connected&&status?.configured&&<a className="button" href={`/api/integrations/${card.key}/connect?profile=${profileId}`}>Connect {card.name}</a>}
      {card.mode==="oauth"&&!status?.connected&&!status?.configured&&<span className="badge">Setup required</span>}
      {card.mode==="import"&&<a className="button secondary" href="#health-import">Import health data</a>}
      {card.mode==="partner"&&<span className="badge">Partner access required</span>}
    </article>})}</div>{message&&<p role="status">{message}</p>}
    <p className="muted">Connections request read-only health scopes. HMS never asks for permission to write back to a wearable account.</p>
  </section>;
}
