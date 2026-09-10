import "server-only";
import { z } from "zod";
import { addDays, localDay } from "../analytics/time";
import { normalisedMetric, type NormalisedMetric } from "../ingestion/model";
import type { IntegrationProvider, StoredTokens } from "./model";
import { refreshAccessToken } from "./providers";
import { loadIntegration, persistIntegrationMetrics, updateIntegrationTokens } from "./store";
import { normaliseGoogle } from "./normalise";

function metric(input: Omit<NormalisedMetric,"duration_s"|"quality"|"external_id"> & Partial<Pick<NormalisedMetric,"duration_s"|"quality"|"external_id">>) {
  return normalisedMetric.safeParse({ duration_s:null, quality:"raw", external_id:null, ...input });
}
function validTokens(tokens:StoredTokens) { return !tokens.expiresAt || Date.parse(tokens.expiresAt)>Date.now()+60_000; }

async function googlePoints(accessToken:string,type:string,start:string) {
  const points:unknown[]=[]; let pageToken="";
  for(let page=0;page<5;page++){
    const url=new URL(`https://health.googleapis.com/v4/users/me/dataTypes/${type}/dataPoints`);
    url.searchParams.set("pageSize",type==="sleep"?"25":type.startsWith("daily-")?"10":"10000");
    const field=type==="sleep"?"sleep.interval.end_time":type.startsWith("daily-")?"":`${type.replaceAll("-","_")}.${type==="weight"?"sample_time.physical_time":"interval.start_time"}`;
    if(field)url.searchParams.set("filter",`${field} >= \"${start}\"`);
    if(pageToken)url.searchParams.set("pageToken",pageToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`},cache:"no-store",signal:AbortSignal.timeout(20_000)});
    const body=z.object({dataPoints:z.array(z.unknown()).default([]),nextPageToken:z.string().optional()}).safeParse(await response.json().catch(()=>null));
    if(!response.ok||!body.success)throw new Error(`Google Health ${type} sync failed.`);
    points.push(...body.data.dataPoints);pageToken=body.data.nextPageToken||"";if(!pageToken)break;
  }
  return points;
}

async function syncGoogle(tokens:StoredTokens,timezone:string,scopes:string[]){
  const start=new Date(Date.now()-7*86400000).toISOString();const types:string[]=[];
  if(scopes.some(scope=>scope.endsWith("activity_and_fitness.readonly")))types.push("steps","active-energy-burned");
  if(scopes.some(scope=>scope.endsWith("health_metrics_and_measurements.readonly")))types.push("daily-resting-heart-rate","daily-heart-rate-variability","daily-oxygen-saturation","daily-respiratory-rate","daily-sleep-temperature-derivations","daily-vo2-max","weight");
  if(scopes.some(scope=>scope.endsWith("sleep.readonly")))types.push("sleep");
  const groups=await Promise.all(types.map(async type=>(await googlePoints(tokens.accessToken,type,start)).flatMap(point=>normaliseGoogle(point,type,timezone))));
  const cutoff=addDays(localDay(Date.now(),timezone),-7);return groups.flat().filter(item=>localDay(item.recorded_at,timezone)>=cutoff);
}

async function whoopCollection(tokens:StoredTokens,path:string,start:string){
  const records:unknown[]=[];let nextToken="";
  for(let page=0;page<5;page++){
    const url=new URL(`https://api.prod.whoop.com/developer/v2/${path}`);url.searchParams.set("limit","25");url.searchParams.set("start",start);if(nextToken)url.searchParams.set("nextToken",nextToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${tokens.accessToken}`},cache:"no-store",signal:AbortSignal.timeout(20_000)});
    const body=z.object({records:z.array(z.unknown()).default([]),next_token:z.string().optional()}).safeParse(await response.json().catch(()=>null));if(!response.ok||!body.success)throw new Error(`WHOOP ${path} sync failed.`);
    records.push(...body.data.records);nextToken=body.data.next_token||"";if(!nextToken)break;
  }
  return records;
}
async function syncWhoop(tokens:StoredTokens,scopes:string[]):Promise<NormalisedMetric[]>{
  const start=new Date(Date.now()-7*86400000).toISOString();const [recoveries,cycles,sleeps]=await Promise.all([
    scopes.includes("read:recovery")?whoopCollection(tokens,"recovery",start):[],
    scopes.includes("read:cycles")?whoopCollection(tokens,"cycle",start):[],
    scopes.includes("read:sleep")?whoopCollection(tokens,"activity/sleep",start):[],
  ]);const output:NormalisedMetric[]=[];
  for(const raw of recoveries){const row=z.object({cycle_id:z.number(),created_at:z.string(),score_state:z.string(),score:z.object({resting_heart_rate:z.number(),hrv_rmssd_milli:z.number(),spo2_percentage:z.number().optional(),skin_temp_celsius:z.number().optional()}).optional()}).safeParse(raw);if(!row.success||row.data.score_state!=="SCORED"||!row.data.score)continue;for(const [kind,value,unit] of [["resting_heart_rate",row.data.score.resting_heart_rate,"bpm"],["hrv_rmssd",row.data.score.hrv_rmssd_milli,"ms"],["spo2",row.data.score.spo2_percentage,"%"],["skin_temperature",row.data.score.skin_temp_celsius,"°C"]] as const){if(value===undefined)continue;const parsed=metric({metric_type:kind,value,unit,recorded_at:row.data.created_at,at_rest:kind==="resting_heart_rate"?true:undefined,quality:"derived",external_id:`whoop:recovery:${row.data.cycle_id}:${kind}`});if(parsed.success)output.push(parsed.data);}}
  for(const raw of cycles){const row=z.object({id:z.number(),start:z.string(),end:z.string().optional(),score:z.object({kilojoule:z.number()}).optional()}).safeParse(raw);if(!row.success||!row.data.score)continue;const parsed=metric({metric_type:"active_calories",value:row.data.score.kilojoule/4.184,unit:"kcal",recorded_at:row.data.start,duration_s:row.data.end?Math.max(0,Math.round((Date.parse(row.data.end)-Date.parse(row.data.start))/1000)):null,quality:"derived",external_id:`whoop:cycle:${row.data.id}:energy`});if(parsed.success)output.push(parsed.data);}
  for(const raw of sleeps){const row=z.object({id:z.string(),start:z.string(),end:z.string(),nap:z.boolean(),score:z.object({respiratory_rate:z.number().optional(),stage_summary:z.object({total_light_sleep_time_milli:z.number(),total_slow_wave_sleep_time_milli:z.number(),total_rem_sleep_time_milli:z.number()})}).optional()}).safeParse(raw);if(!row.success||!row.data.score||row.data.nap)continue;const total=(row.data.score.stage_summary.total_light_sleep_time_milli+row.data.score.stage_summary.total_slow_wave_sleep_time_milli+row.data.score.stage_summary.total_rem_sleep_time_milli)/60000;for(const [kind,value,unit] of [["sleep_duration",total,"min"],["respiratory_rate",row.data.score.respiratory_rate,"breaths/min"]] as const){if(value===undefined)continue;const parsed=metric({metric_type:kind,value,unit,recorded_at:row.data.start,duration_s:kind==="sleep_duration"?Math.round(total*60):null,quality:"derived",external_id:`whoop:sleep:${row.data.id}:${kind}`});if(parsed.success)output.push(parsed.data);}}
  return output;
}

export async function syncIntegration(actor:string,subject:string,provider:IntegrationProvider){
  const connection=await loadIntegration(actor,subject,provider);let tokens=connection.tokens;
  if(!validTokens(tokens)){tokens=await refreshAccessToken(provider,tokens);await updateIntegrationTokens(actor,subject,provider,tokens);}
  const metrics=provider==="google_health"?await syncGoogle(tokens,connection.timezone,connection.scopes):await syncWhoop(tokens,connection.scopes);
  if(!metrics.length)return{inserted:0,skipped:0};return persistIntegrationMetrics(actor,subject,connection.sourceId,metrics);
}
