import {z} from "zod";
import {addDays} from "../analytics/time";

const numeric=z.union([z.string(),z.number()]).transform(Number).refine(Number.isFinite).nullable();
export const clinicalDaySchema=z.object({day:z.iso.date(),rhr:numeric,hrv_avg:numeric,spo2_avg:numeric,spo2_min:numeric,
  sleep_duration_min:numeric,weight_kg:numeric,bp_systolic:numeric,bp_diastolic:numeric,contains_sample:z.boolean()});
export const clinicalBodySchema=z.object({version:z.literal(1),generated_at:z.string(),from:z.iso.date(),to:z.iso.date(),days:z.union([z.literal(30),z.literal(90)]),
  profile:z.object({id:z.uuid(),name:z.string(),dob:z.iso.date(),sex_at_birth:z.string().nullable(),timezone:z.string(),country:z.string()}),
  consent_given_by_guardian:z.boolean(),contains_sample:z.boolean(),medications:z.array(z.string()).max(12),series:z.array(clinicalDaySchema).max(90),
  alert_counts:z.array(z.object({severity:z.enum(["info","attention","urgent"]),count:z.number().int().nonnegative()})).max(3),
  documents:z.array(z.object({id:z.uuid(),type:z.string(),title:z.string(),uploaded_at:z.string()})).max(8),document_count:z.number().int().nonnegative(),
  disclaimer:z.literal("Generated from consumer wearable data; not a medical device.")});
export const clinicalSnapshotSchema=z.object({id:z.uuid().nullable(),body:clinicalBodySchema});
export type ClinicalBody=z.infer<typeof clinicalBodySchema>;
export type ClinicalDay=z.infer<typeof clinicalDaySchema>;
export const clinicalMetrics=[
  {key:"rhr",label:"Resting heart rate",unit:"bpm"}, {key:"hrv_avg",label:"HRV (RMSSD)",unit:"ms"},
  {key:"spo2_avg",label:"Average SpO2",unit:"%"}, {key:"sleep_duration_min",label:"Sleep duration",unit:"min"},
  {key:"weight_kg",label:"Weight",unit:"kg"}, {key:"bp_systolic",label:"Blood pressure",unit:"mmHg"},
] as const;
type Field=typeof clinicalMetrics[number]["key"]|"bp_diastolic";
/** Daily aggregates only. Gaps are breaks, never zeroes or interpolated observations. */
export function clinicalTrend(body:ClinicalBody,field:Field) {
  const rows=[...body.series].sort((a,b)=>a.day.localeCompare(b.day));
  const values=rows.flatMap(row=>row[field]===null?[]:[row[field]]);
  const min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):1;
  const pad=Math.max(.1,(max-min)*.1),low=min-pad,high=max+pad;
  const points=rows.map(row=>({day:row.day,value:row[field],x:4+(Date.parse(row.day)-Date.parse(body.from))/(86400000*(body.days-1))*220,
    y:row[field]===null?null:38-(row[field]-low)/(high-low)*32}));
  const segments:string[]=[];let segment="",previous:string|null=null;
  for(const p of points) {
    if(p.y===null){if(segment)segments.push(segment);segment="";previous=null;continue;}
    if(previous&&p.day!==addDays(previous,1)){if(segment)segments.push(segment);segment="";}
    segment+=(segment?" L":"M")+p.x.toFixed(2)+","+p.y.toFixed(2);previous=p.day;
  }
  if(segment)segments.push(segment);
  return {segments,points,n:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,first:values.at(0)??null,last:values.at(-1)??null};
}
export const clinicalNumber=(value:number|null)=>value===null?"Not recorded":value.toLocaleString("en-GB",{maximumFractionDigits:1});
