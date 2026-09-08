import {z} from "zod";
import {consultCursorSchema,messageCursorSchema} from "./cursors";
const user={userId:z.uuid()};
const data=z.record(z.string(),z.unknown());
export const careCommand=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("transfer_list"),cursor:z.uuid().nullable().optional()}),
  z.object({kind:z.literal("list"),section:z.enum(["directory","doctors","caregivers","incoming","patients"]),userId:z.uuid().optional(),cursor:z.uuid().nullable().optional()}),
  z.object({kind:z.literal("doctor"),action:z.enum(["read","register","verify"]),data:data.default({})}),
  z.object({kind:z.literal("sharing"),...user,action:z.enum(["link_doctor","invite_caregiver","accept_caregiver","revoke_doctor","revoke_caregiver"]),data}),
  z.object({kind:z.literal("summary"),...user,days:z.union([z.literal(30),z.literal(90)]).default(30),snapshotId:z.uuid().optional(),create:z.boolean().default(false)}),
  z.object({kind:z.literal("medications"),...user,items:z.array(z.string().trim().min(1).max(120)).max(12)}),
  z.object({kind:z.literal("consult"),...user,action:z.enum(["request","accept","schedule","message","close","cancel"]),data}),
  z.object({kind:z.literal("consult_read"),id:z.uuid(),cursor:messageCursorSchema.nullable().optional()}),
  z.object({kind:z.literal("consult_list"),userId:z.uuid().optional(),cursor:consultCursorSchema.nullable().optional(),history:z.boolean().default(false)}),
]);
export function careRpc(input:z.infer<typeof careCommand>) {
  switch(input.kind) {
    case "transfer_list":return {name:"hms_transfer_list",args:{p_cursor:input.cursor??null}};
    case "list":return {name:"hms_care_list",args:{p_section:input.section,p_subject:input.userId??null,p_cursor:input.cursor??null}};
    case "doctor":return {name:"hms_doctor_profile",args:{p_action:input.action,p_data:input.data}};
    case "sharing":return {name:"hms_care_change",args:{p_subject:input.userId,p_action:input.action,p_data:input.data}};
    case "summary":return {name:"hms_clinical_summary",args:{p_subject:input.userId,p_days:input.days,p_snapshot:input.snapshotId??null,p_create:input.create}};
    case "medications":return {name:"hms_medications",args:{p_subject:input.userId,p_items:input.items}};
    case "consult":return {name:"hms_consult_change",args:{p_subject:input.userId,p_action:input.action,p_data:input.data}};
    case "consult_read":return {name:"hms_consult_read",args:{p_id:input.id,p_before:input.cursor??null}};
    case "consult_list":return {name:"hms_consult_list",args:{p_subject:input.userId??null,p_cursor:input.cursor??null,p_history:input.history}};
  }
}
