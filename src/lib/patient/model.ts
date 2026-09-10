import { z } from "zod";
import { metricTypes } from "../ingestion/model";
import { isValidBirthDate } from "../auth/validation";

const num = z.union([z.number(),z.string()]).transform(Number).refine(Number.isFinite).nullable();
export const profileSchema = z.object({ id:z.uuid(),name:z.string(),dob:z.string(),kind:z.enum(["self","dependent"]),timezone:z.string(),
  sex_at_birth:z.string().nullable(),country_of_residence:z.string(),onboarding_completed_at:z.string().nullable(),cycle_tracking_enabled:z.boolean() });
export type PatientProfile = z.infer<typeof profileSchema>;
export const summarySchema = z.object({ day:z.string(),rhr:num,hrv_avg:num,spo2_avg:num,spo2_min:num,sleep_duration_min:num,skin_temp_deviation:num,weight_kg:num,steps:num,
  bp_systolic:num,bp_diastolic:num,readiness_score:num,computed_at:z.string().optional(),contains_sample:z.boolean(),source_ids:z.record(z.string(),z.string()),recovery_evidence:z.record(z.string(),z.unknown()) });
export type Summary = z.infer<typeof summarySchema>;
export const alertSchema = z.object({ id:z.uuid(),severity:z.enum(["info","attention","urgent"]),metric_snapshot:z.object({body:z.string()}).passthrough(),fired_at:z.string(),
  event_start:z.string().nullable(),acknowledged_at:z.string().nullable(),escalation_due_at:z.string().nullable(),is_sample:z.boolean(),is_historical:z.boolean() });
export type PatientAlert = z.infer<typeof alertSchema>;
export const viewSchema = z.object({ profile:profileSchema,can_manage:z.boolean(),can_read_alerts:z.boolean(),can_read_history:z.boolean(),consent_given_by_guardian:z.boolean(),
  contains_sample:z.boolean().optional(),pending_jobs:z.number().optional(),ingestion_consent:z.boolean().optional(),active_alert_count:z.number().optional(),
  summaries:z.array(summarySchema).optional(),alerts:z.array(alertSchema).optional(),
  insights:z.array(z.object({id:z.uuid(),category:z.string(),title:z.string(),body:z.string(),confidence:z.string(),evidence:z.record(z.string(),z.unknown())})).optional(),
  cycles:z.array(z.object({day:z.string(),phase:z.string(),confidence:z.string(),is_inferred:z.boolean()})).optional(),
  markers:z.array(z.object({day:z.string(),count:z.number(),acknowledged:z.boolean()})).optional(),
  sources:z.array(z.object({id:z.uuid(),provider:z.string(),status:z.string(),last_sync_at:z.string().nullable(),metadata:z.record(z.string(),z.unknown())})).optional(),
  metrics:z.array(z.object({id:z.uuid(),metric_type:z.enum(metricTypes),value:num,unit:z.string(),recorded_at:z.string(),source_id:z.uuid(),provider:z.string(),metadata:z.record(z.string(),z.unknown())})).optional(),
  documents:z.array(z.object({id:z.uuid(),type:z.string(),title:z.string(),uploaded_at:z.string(),tags:z.array(z.string())})).optional(),
  baselines:z.array(z.object({metric_type:z.enum(metricTypes),median:num,mad:num,sample_count:z.number(),window_end:z.string().nullable()})).optional(),
  next_cursor:z.record(z.string(),z.string()).nullable().optional() });
export type PatientView = z.infer<typeof viewSchema>;
export type ViewSection = "today" | "history" | "raw" | "alerts" | "sources" | "advanced" | "documents";
export const viewInput = z.object({ userId:z.uuid(),section:z.enum(["today","history","raw","alerts","sources","advanced","documents"]),
  from:z.string().refine(isValidBirthDate).nullable().optional(),to:z.string().refine(isValidBirthDate).nullable().optional(),cursor:z.record(z.string(),z.string().max(80)).nullable().optional() });
export async function patientPost(path:string,body:unknown,signal?:AbortSignal):Promise<unknown> {
  const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",signal});
  const result:unknown=await response.json();
  if(!response.ok) { const error=z.object({error:z.string()}).safeParse(result); throw new Error(error.success?error.data.error:"Please try again."); }
  return result;
}
export async function readView(userId:string,section:ViewSection,options:{from?:string|null;to?:string|null;cursor?:Record<string,string>|null;signal?:AbortSignal}={}) {
  const {signal,...input}=options;
  return viewSchema.parse(await patientPost("/api/patient/view",{userId,section,...input},signal));
}
