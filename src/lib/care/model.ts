import {z} from "zod";
import {patientPost} from "../patient/model";
const scopes=z.array(z.enum(["summary_only","full_history","alerts"]));
const number=z.union([z.number(),z.string()]).transform(Number).refine(Number.isFinite);
export const doctorSchema=z.object({id:z.uuid(),name:z.string().optional(),registration_number:z.string(),registering_council:z.string(),specialities:z.array(z.string()),
  languages:z.array(z.string()),bio:z.string(),consult_fee_inr:number,consult_fee_usd:number,available:z.boolean(),verified_at:z.string().nullable(),is_sample:z.boolean()});
export type Doctor=z.infer<typeof doctorSchema>;
export const doctorAccountSchema=z.object({profile_id:z.uuid(),role:z.enum(["patient","doctor","admin"]),account_code:z.uuid(),doctor:doctorSchema.nullable()});
export const linkSchema=z.object({id:z.uuid(),name:z.string(),patient_id:z.uuid(),doctor_id:z.uuid().optional(),caregiver_id:z.uuid().optional(),role:z.enum(["caregiver","guardian"]).optional(),
  status:z.string(),granted_scopes:scopes,is_sample:z.boolean().optional(),verified_at:z.string().nullable().optional(),can_read_summary:z.boolean().optional(),can_read_history:z.boolean().optional(),can_read_alerts:z.boolean().optional()});
export const patientLinkSchema=z.object({id:z.uuid(),name:z.string(),dob:z.string(),kind:z.string(),granted_scopes:scopes});
export const transferSchema=z.object({id:z.uuid(),user_id:z.uuid(),guardian_account_id:z.uuid(),recipient_account_id:z.uuid(),expires_at:z.string(),name:z.string(),dob:z.string()});
export const consultRowSchema=z.object({id:z.uuid(),patient_id:z.uuid(),doctor_id:z.uuid().nullable(),type:z.string(),status:z.string(),requested_at:z.string(),scheduled_for:z.string().nullable(),completed_at:z.string().nullable(),
  doctor_note:z.string().nullable(),patient_name:z.string(),doctor_name:z.string(),is_sample:z.boolean()});
export const consultSchema=z.object({id:z.uuid(),patient_id:z.uuid(),doctor_id:z.uuid().nullable(),type:z.string(),status:z.string(),requested_at:z.string(),scheduled_for:z.string().nullable(),completed_at:z.string().nullable(),
  patient_note:z.string().nullable(),doctor_note:z.string().nullable(),attached_summary_id:z.uuid().nullable(),call_url:z.string().nullable()});
export const consultViewSchema=z.object({consult:consultSchema,messages:z.array(z.object({id:z.uuid(),sender_id:z.uuid().nullable(),body:z.string(),sent_at:z.string(),read_at:z.string().nullable()})),
  next_cursor:z.record(z.string(),z.string()).nullable(),is_doctor:z.boolean(),can_manage:z.boolean(),patient_name:z.string(),doctor_name:z.string(),is_sample:z.boolean()});
export const listSchema=<T extends z.ZodType>(row:T)=>z.object({rows:z.array(row),next_cursor:z.union([z.uuid(),z.record(z.string(),z.string())]).nullable()});
export async function carePost(input:unknown) {return z.object({result:z.unknown()}).parse(await patientPost("/api/care",input)).result;}
