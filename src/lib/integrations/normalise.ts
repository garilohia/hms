import { createHash } from "node:crypto";
import { z } from "zod";
import { dayBounds } from "../analytics/time";
import { normalisedMetric, type NormalisedMetric } from "../ingestion/model";

function stableId(prefix:string,value:unknown) { return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,32)}`; }
function dateValue(value:unknown) {
  const parsed=z.object({year:z.number().int(),month:z.number().int(),day:z.number().int()}).safeParse(value);
  return parsed.success?`${String(parsed.data.year).padStart(4,"0")}-${String(parsed.data.month).padStart(2,"0")}-${String(parsed.data.day).padStart(2,"0")}`:null;
}
function metric(input: Omit<NormalisedMetric,"duration_s"|"quality"|"external_id"> & Partial<Pick<NormalisedMetric,"duration_s"|"quality"|"external_id">>) {
  return normalisedMetric.safeParse({ duration_s:null, quality:"raw", external_id:null, ...input });
}

export function normaliseGoogle(raw:unknown,type:string,timezone:string):NormalisedMetric[]{
  const point=z.record(z.string(),z.unknown()).safeParse(raw);if(!point.success)return[];
  const value=point.data; const payload=z.record(z.string(),z.unknown()).safeParse(value[type.replace(/-([a-z])/g,(_,letter:string)=>letter.toUpperCase())]);if(!payload.success)return[];
  const data=payload.data; const day=dateValue(data.date); let recordedAt:string|undefined; let duration_s:number|null=null;
  const sample=z.object({physicalTime:z.string()}).safeParse(data.sampleTime),interval=z.object({startTime:z.string(),endTime:z.string()}).safeParse(data.interval);
  if(sample.success)recordedAt=sample.data.physicalTime;
  if(interval.success){recordedAt=interval.data.startTime;duration_s=Math.max(0,Math.round((Date.parse(interval.data.endTime)-Date.parse(interval.data.startTime))/1000));}
  if(day)recordedAt=new Date(dayBounds(day,timezone).start).toISOString();
  if(type==="sleep"){
    const sleep=z.object({interval:z.object({startTime:z.string(),endTime:z.string()}),summary:z.object({minutesAsleep:z.string()}).optional()}).safeParse(data);
    if(!sleep.success)return[];const minutes=Number(sleep.data.summary?.minutesAsleep)||((Date.parse(sleep.data.interval.endTime)-Date.parse(sleep.data.interval.startTime))/60000);
    const parsed=metric({metric_type:"sleep_duration",value:minutes,unit:"min",recorded_at:sleep.data.interval.startTime,duration_s:Math.max(0,Math.round(minutes*60)),external_id:stableId("google:sleep",value)});return parsed.success?[parsed.data]:[];
  }
  if(!recordedAt)return[];
  const mappings:Record<string,[NormalisedMetric["metric_type"],string,string,number?]>={
    "heart-rate":["heart_rate","beatsPerMinute","bpm"],
    "daily-resting-heart-rate":["resting_heart_rate","beatsPerMinute","bpm"],"daily-heart-rate-variability":["hrv_rmssd","averageHeartRateVariabilityMilliseconds","ms"],
    "daily-oxygen-saturation":["spo2","averagePercentage","%"],"daily-respiratory-rate":["respiratory_rate","breathsPerMinute","breaths/min"],
    "daily-sleep-temperature-derivations":["skin_temperature","nightlyTemperatureCelsius","°C"],"daily-vo2-max":["vo2max","vo2Max","mL/kg/min"],
    steps:["steps","count","count"],"active-energy-burned":["active_calories","kcal","kcal"],weight:["weight_kg","weightGrams","kg",0.001],
  };
  const mapping=mappings[type];if(!mapping)return[];const numeric=Number(data[mapping[1]])*(mapping[3]??1);if(!Number.isFinite(numeric))return[];
  const parsed=metric({metric_type:mapping[0],value:numeric,unit:mapping[2],recorded_at:recordedAt,duration_s,at_rest:type==="daily-resting-heart-rate"?true:undefined,quality:type.startsWith("daily-")?"derived":"raw",external_id:stableId(`google:${type}`,value)});
  return parsed.success?[parsed.data]:[];
}
