import "server-only";
import { z } from "zod";
import { addDays, localDay } from "../analytics/time";
import { normalisedMetric, type NormalisedMetric } from "../ingestion/model";
import type { IntegrationProvider, StoredTokens } from "./model";
import { loadIntegration, markIntegrationSynced, persistIntegrationMetrics, refreshIntegrationTokens } from "./store";
import { normaliseGoogle } from "./normalise";
import { syncCheckpoint, type SyncCheckpoint, type SyncCollection } from "./checkpoint";
import { saveIntegrationCheckpoint } from "./checkpoint-store";

function metric(input: Omit<NormalisedMetric,"duration_s"|"quality"|"external_id"> & Partial<Pick<NormalisedMetric,"duration_s"|"quality"|"external_id">>) {
  return normalisedMetric.safeParse({ duration_s:null, quality:"raw", external_id:null, ...input });
}
function validTokens(tokens:StoredTokens) { return !tokens.expiresAt || Date.parse(tokens.expiresAt)>Date.now()+60_000; }

const maximumPages = 12;
const pagePersistenceReserveMs = 5_000;
// Providers filter on measurement/session time, not when a phone finally uploads
// it. Re-read the supported seven-day window, even after a successful sync.
function syncWindow(timezone: string) {
  const end = new Date().toISOString();
  return { start: new Date(Date.parse(end) - 7 * 86400000).toISOString(), end,
    firstDay: addDays(localDay(end, timezone), -7), nextDay: addDays(localDay(end, timezone), 1) };
}
type SyncWindow = ReturnType<typeof syncWindow>;

async function googlePage(accessToken:string,type:string,window:SyncWindow,pageToken:string,deadline:number) {
    const url=new URL(`https://health.googleapis.com/v4/users/me/dataTypes/${type}/dataPoints`);
    url.searchParams.set("pageSize",type==="sleep"?"25":type.startsWith("daily-")?"10":"1000");
    const daily = type.startsWith("daily-");
    const field=type==="sleep"?"sleep.interval.end_time":`${type.replaceAll("-","_")}.${daily?"date":["weight","heart-rate"].includes(type)?"sample_time.physical_time":"interval.start_time"}`;
    url.searchParams.set("filter",`${field} >= \"${daily?window.firstDay:window.start}\" AND ${field} < \"${daily?window.nextDay:window.end}\"`);
    if(pageToken)url.searchParams.set("pageToken",pageToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`},cache:"no-store",signal:AbortSignal.timeout(Math.max(1,Math.min(20_000,deadline-Date.now())))});
    const body=z.object({dataPoints:z.array(z.unknown()).default([]),nextPageToken:z.string().optional()}).safeParse(await response.json().catch(()=>null));
    if(!response.ok||!body.success)throw new Error(`Google Health ${type} sync failed.`);
    return { records: body.data.dataPoints, nextToken: body.data.nextPageToken || "" };
}

function collectionsFor(provider: IntegrationProvider, scopes:string[]):SyncCollection[]{
  if (provider === "whoop") return [
    ...(scopes.includes("read:recovery") ? ["recovery" as const] : []),
    ...(scopes.includes("read:cycles") ? ["cycle" as const] : []),
    ...(scopes.includes("read:sleep") ? ["activity/sleep" as const] : []),
  ];
  const types:SyncCollection[]=[];
  if(scopes.some(scope=>scope.endsWith("activity_and_fitness.readonly")))types.push("steps","active-energy-burned","daily-vo2-max");
  if(scopes.some(scope=>scope.endsWith("health_metrics_and_measurements.readonly")))types.push("heart-rate","daily-resting-heart-rate","daily-heart-rate-variability","daily-oxygen-saturation","daily-respiratory-rate","daily-sleep-temperature-derivations","weight");
  if(scopes.some(scope=>scope.endsWith("sleep.readonly")))types.push("sleep");
  return types;
}

async function whoopPage(tokens:StoredTokens,path:string,window:SyncWindow,nextToken:string,deadline:number){
    const url=new URL(`https://api.prod.whoop.com/developer/v2/${path}`);url.searchParams.set("limit","25");url.searchParams.set("start",window.start);url.searchParams.set("end",window.end);if(nextToken)url.searchParams.set("nextToken",nextToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${tokens.accessToken}`},cache:"no-store",signal:AbortSignal.timeout(Math.max(1,Math.min(20_000,deadline-Date.now())))});
    const body=z.object({records:z.array(z.unknown()).default([]),next_token:z.string().optional()}).safeParse(await response.json().catch(()=>null));if(!response.ok||!body.success)throw new Error(`WHOOP ${path} sync failed.`);
    return { records: body.data.records, nextToken: body.data.next_token || "" };
}
function normaliseWhoop(records:unknown[],collection:SyncCollection):NormalisedMetric[]{
  const recoveries=collection==="recovery"?records:[],cycles=collection==="cycle"?records:[],sleeps=collection==="activity/sleep"?records:[];
  const output:NormalisedMetric[]=[];
  for(const raw of recoveries){const row=z.object({cycle_id:z.number(),created_at:z.string(),score_state:z.string(),score:z.object({resting_heart_rate:z.number(),hrv_rmssd_milli:z.number(),spo2_percentage:z.number().optional(),skin_temp_celsius:z.number().optional()}).optional()}).safeParse(raw);if(!row.success||row.data.score_state!=="SCORED"||!row.data.score)continue;for(const [kind,value,unit] of [["resting_heart_rate",row.data.score.resting_heart_rate,"bpm"],["hrv_rmssd",row.data.score.hrv_rmssd_milli,"ms"],["spo2",row.data.score.spo2_percentage,"%"],["skin_temperature",row.data.score.skin_temp_celsius,"°C"]] as const){if(value===undefined)continue;const parsed=metric({metric_type:kind,value,unit,recorded_at:row.data.created_at,at_rest:kind==="resting_heart_rate"?true:undefined,quality:"derived",external_id:`whoop:recovery:${row.data.cycle_id}:${kind}`});if(parsed.success)output.push(parsed.data);}}
  for(const raw of cycles){const row=z.object({id:z.number(),start:z.string(),end:z.string().optional(),score:z.object({kilojoule:z.number()}).optional()}).safeParse(raw);if(!row.success||!row.data.score)continue;const parsed=metric({metric_type:"active_calories",value:row.data.score.kilojoule/4.184,unit:"kcal",recorded_at:row.data.start,duration_s:row.data.end?Math.max(0,Math.round((Date.parse(row.data.end)-Date.parse(row.data.start))/1000)):null,quality:"derived",external_id:`whoop:cycle:${row.data.id}:energy`});if(parsed.success)output.push(parsed.data);}
  for(const raw of sleeps){const row=z.object({id:z.string(),start:z.string(),end:z.string(),nap:z.boolean(),score:z.object({respiratory_rate:z.number().optional(),stage_summary:z.object({total_light_sleep_time_milli:z.number(),total_slow_wave_sleep_time_milli:z.number(),total_rem_sleep_time_milli:z.number()})}).optional()}).safeParse(raw);if(!row.success||!row.data.score||row.data.nap)continue;const total=(row.data.score.stage_summary.total_light_sleep_time_milli+row.data.score.stage_summary.total_slow_wave_sleep_time_milli+row.data.score.stage_summary.total_rem_sleep_time_milli)/60000;for(const [kind,value,unit] of [["sleep_duration",total,"min"],["respiratory_rate",row.data.score.respiratory_rate,"breaths/min"]] as const){if(value===undefined)continue;const parsed=metric({metric_type:kind,value,unit,recorded_at:row.data.start,duration_s:kind==="sleep_duration"?Math.round(total*60):null,quality:"derived",external_id:`whoop:sleep:${row.data.id}:${kind}`});if(parsed.success)output.push(parsed.data);}}
  return output;
}

export async function syncIntegration(actor:string,subject:string,provider:IntegrationProvider,options:{deadline?:number}={}){
  const deadline=options.deadline??Date.now()+30_000;
  const result:{inserted:number;skipped:number;complete:boolean;syncedThrough:string|null}={inserted:0,skipped:0,complete:false,syncedThrough:null};
  const connection=await loadIntegration(actor,subject,provider);
  if(Date.now()>=deadline)return result;
  let tokens=connection.tokens,connectionVersion=connection.connectionVersion;
  if(!validTokens(tokens))({tokens,connectionVersion}=await refreshIntegrationTokens(actor,subject,provider,connectionVersion,deadline));
  if(Date.now()>=deadline)return result;
  const collections=collectionsFor(provider,connection.scopes);
  let checkpoint:SyncCheckpoint;
  if(connection.syncCheckpoint){
    checkpoint=syncCheckpoint.parse(connection.syncCheckpoint);
    if(checkpoint.provider!==provider||checkpoint.collections.some(type=>!collections.includes(type)))throw new Error("The wearable scopes changed. Reconnect the account.");
  }else{
    checkpoint={version:1,provider,window:syncWindow(connection.timezone),collections,collectionIndex:0,nextToken:""};
    await saveIntegrationCheckpoint(actor,subject,provider,connectionVersion,null,checkpoint);
  }
  // Leave time for the bounded page write. A database transaction already in
  // flight may finish later; never start another phase after the work deadline.
  for(let page=0;page<maximumPages&&checkpoint.collectionIndex<checkpoint.collections.length&&Date.now()+pagePersistenceReserveMs<deadline;page++){
    const type=checkpoint.collections[checkpoint.collectionIndex];
    const fetchDeadline=deadline-pagePersistenceReserveMs;
    const batch=provider==="google_health"?await googlePage(tokens.accessToken,type,checkpoint.window,checkpoint.nextToken,fetchDeadline):await whoopPage(tokens,type,checkpoint.window,checkpoint.nextToken,fetchDeadline);
    if(Date.now()>=deadline)return result;
    const metrics=provider==="google_health"?batch.records.flatMap(point=>normaliseGoogle(point,type,connection.timezone)).filter(item=>localDay(item.recorded_at,connection.timezone)>=checkpoint.window.firstDay):normaliseWhoop(batch.records,type);
    if(metrics.length){
      const persisted=await persistIntegrationMetrics(actor,subject,connection.sourceId,metrics,connectionVersion);
      result.inserted+=persisted.inserted;result.skipped+=persisted.skipped;
    }
    // If the data write took the remaining budget, replay this page next time.
    // Its checkpoint remains unchanged and hms_ingest_batch deduplicates it.
    if(Date.now()>=deadline)return result;
    const next={...checkpoint,collectionIndex:checkpoint.collectionIndex+(batch.nextToken?0:1),nextToken:batch.nextToken};
    await saveIntegrationCheckpoint(actor,subject,provider,connectionVersion,checkpoint,next);
    checkpoint=next;
  }
  if(checkpoint.collectionIndex===checkpoint.collections.length&&Date.now()<deadline){
    await markIntegrationSynced(actor,subject,provider,connectionVersion,checkpoint);
    result.complete=true;
    result.syncedThrough=checkpoint.window.end;
  }
  return result;
}
