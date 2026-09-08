import {describe,expect,it} from "vitest";
import {RetryIds} from "../src/lib/care/retry";
import {doctorQuerySchema} from "../src/lib/care/cursors";
import {careCommand} from "../src/lib/care/commands";
const id="9e974fc7-e753-41dc-adcd-5f2804eecdf4",time="2026-09-08T04:12:13.123456+00:00";
describe("uncertain clinical writes",()=>{
  it("reuses an ID for unchanged retries until a confirmed response",()=>{
    const attempts=new RetryIds(),first=attempts.id("consult","message");
    expect(attempts.id("consult","message")).toBe(first);
    attempts.confirmed("consult");expect(attempts.id("consult","message")).not.toBe(first);
  });
  it("separates changed content and independent consults",()=>{
    const attempts=new RetryIds(),first=attempts.id("a","one");
    expect(attempts.id("b","one")).not.toBe(first);
    expect(attempts.id("a","two")).not.toBe(first);
  });
});
describe("care cursors",()=>{
  it("accepts complete database cursors without losing microseconds",()=>{
    expect(doctorQuerySchema.parse({patients:id,consults:JSON.stringify({id,requested_at:time})}).consults?.requested_at).toBe(time);
    expect(careCommand.safeParse({kind:"consult_read",id,cursor:{id,sent_at:time}}).success).toBe(true);
  });
  it("rejects malformed, repeated, incomplete and incorrectly typed query values without throwing",()=>{
    for(const consults of ["{","{}","null","[]",JSON.stringify({id,requested_at:"yesterday"}),JSON.stringify({id,requested_at:time,extra:"x"}),["{}","{}"]])
      expect(doctorQuerySchema.safeParse({consults}).success).toBe(false);
    expect(doctorQuerySchema.safeParse({patients:"not-a-uuid"}).success).toBe(false);
    expect(doctorQuerySchema.safeParse({patients:[id,id]}).success).toBe(false);
  });
  it("rejects incomplete and wrong-kind API cursors before SQL",()=>{
    for(const cursor of [{},{id},{id,requested_at:time},{id,sent_at:"yesterday"}])
      expect(careCommand.safeParse({kind:"consult_read",id,cursor}).success).toBe(false);
    expect(careCommand.safeParse({kind:"consult_list",cursor:{id,sent_at:time}}).success).toBe(false);
  });
});
