import {z} from "zod";
export const consultCursorSchema=z.strictObject({requested_at:z.iso.datetime({offset:true}),id:z.uuid()});
export const messageCursorSchema=z.strictObject({sent_at:z.iso.datetime({offset:true}),id:z.uuid()});
const jsonCursor=z.string().max(1024).transform((value,ctx):unknown=>{
  try{return JSON.parse(value) as unknown;}
  catch{ctx.addIssue({code:"custom",message:"Invalid cursor JSON"});return z.NEVER;}
}).pipe(consultCursorSchema);
export const doctorQuerySchema=z.object({patients:z.uuid().optional(),consults:jsonCursor.optional()});
