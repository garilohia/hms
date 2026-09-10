import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, test } from "@playwright/test";

test("real Supabase magic-link session, guardian consent, and sign-out", async ({ page, baseURL }) => {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret=process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret || !process.env.DATABASE_URL) throw new Error("Live Supabase verification requires the project's keys and DATABASE_URL.");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false});
  let actor: string | undefined;
  const subjectIds: string[]=[];
  try {
    // Generates a one-time link without emailing anyone.
    const {data: link,error}=await admin.auth.admin.generateLink({
      type:"magiclink", email:"hms-auth-" + randomUUID() + "@example.com",
      options:{data:{dob:"1990-01-01",name:"Sample guardian"}},
    });
    if (error) throw new Error("Supabase could not generate the test link: " + error.code);
    actor=link.user.id;
    await page.goto("/auth/confirm?next=/account&token_hash=" + encodeURIComponent(link.properties.hashed_token));
    await expect(page).toHaveURL(baseURL + "/account");
    await expect(page.getByText("Sample guardian", {exact:true})).toBeVisible();
    const response=await page.request.post("/api/profiles/dependents",{
      headers:{Origin:baseURL!},
      data:{name:"Sample dependent",dob:"2015-01-01",consent:true},
    });
    expect(response.status()).toBe(201);
    const result: {id:string}=await response.json();
    subjectIds.push(result.id);
    await page.reload();
    await expect(page.getByText("Sample dependent", {exact:false})).toBeVisible();
    const rows=await db.unsafe("select id from public.profiles where owner_account_id=$1",[actor]);
    subjectIds.push(...rows.map(row => row.id as string));
    const [consent]=await db.unsafe("select authority,granted_by from public.consents where user_id=$1",[result.id]);
    expect(consent.authority).toBe("guardian");
    expect(consent.granted_by).toBe(actor);
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await expect(page).toHaveURL(baseURL + "/sign-in");
    await page.goto("/account");
    await expect(page).toHaveURL(baseURL + "/sign-in");
  } finally {
    if (actor) {
      const {error}=await admin.auth.admin.deleteUser(actor);
      if(error) throw new Error("Test account cleanup failed: " + error.code);
      await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=any($2::uuid[])",[actor,subjectIds]);
    }
    await db.end();
  }
});

test("mobile bearer session registers a source and retries one immutable batch", async ({ page }) => {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishable=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret=process.env.SUPABASE_SECRET_KEY;
  if(!url||!publishable||!secret||!process.env.DATABASE_URL)throw new Error("Live mobile verification requires the project's Supabase configuration.");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const client=createClient(url,publishable,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false});
  let actor:string|undefined,subject:string|undefined;
  try {
    const {data:link,error}=await admin.auth.admin.generateLink({type:"magiclink",email:"hms-mobile-"+randomUUID()+"@example.com",options:{data:{dob:"1990-01-01",name:"Sample mobile user"}}});
    if(error)throw new Error("Supabase could not generate the mobile test link: "+error.code);
    actor=link.user.id;
    const session=await client.auth.verifyOtp({type:"email",token_hash:link.properties.hashed_token});
    const token=session.data.session?.access_token;
    if(session.error||!token)throw new Error("Supabase could not create the mobile test session: "+(session.error?.code||"NoSession"));
    const headers={Authorization:"Bearer "+token};
    expect((await page.request.get("/api/mobile/bootstrap",{headers:{Authorization:"Basic invalid-token-value-for-test"}})).status()).toBe(401);
    expect((await page.request.get("/api/mobile/bootstrap",{headers:{Authorization:"Bearer invalid-token-value-for-test"}})).status()).toBe(401);
    const bootstrap=await page.request.get("/api/mobile/bootstrap",{headers});
    const bootstrapText=await bootstrap.text();expect(bootstrap.status(),bootstrapText).toBe(200);
    const body=JSON.parse(bootstrapText) as {protocolVersion:number;profiles:{id:string}[]};
    expect(body.protocolVersion).toBe(1);subject=body.profiles[0].id;
    const consent=await client.rpc("hms_record_consent",{p_subject:subject,p_type:"data_ingestion",p_grant:true,p_policy:"test",p_ip_hash:"0".repeat(64)});
    if(consent.error)throw new Error("Mobile test consent failed: "+consent.error.code);
    const source=await page.request.post("/api/mobile/sources",{headers,data:{userId:subject,platform:"ios_healthkit",installationId:"ios:"+randomUUID(),label:"Sample iPhone",metrics:["heart_rate"],expectedCadenceSeconds:60}});
    const sourceText=await source.text();expect(source.status(),sourceText).toBe(200);const sourceId=(JSON.parse(sourceText) as {id:string}).id;
    const batchId=randomUUID(),metrics=[{metric_type:"heart_rate",value:72,unit:"bpm",recorded_at:new Date(Date.now()-86400000).toISOString(),duration_s:60,quality:"raw",external_id:"healthkit:sample-1"}];
    const upload=()=>page.request.post("/api/mobile/ingest",{headers,data:{protocolVersion:1,userId:subject,sourceId,batchId,metrics}});
    const first=await upload(),firstText=await first.text();expect(first.status(),firstText).toBe(200);expect(JSON.parse(firstText)).toMatchObject({inserted:1,replayed:false,batchId});
    const retry=await upload(),retryText=await retry.text();expect(retry.status(),retryText).toBe(200);expect(JSON.parse(retryText)).toMatchObject({inserted:1,replayed:true,batchId});
    const changed=await page.request.post("/api/mobile/ingest",{headers,data:{protocolVersion:1,userId:subject,sourceId,batchId,metrics:[{...metrics[0],value:73}]}});
    expect(changed.status()).toBe(400);
  }finally{
    if(actor){const cleanup=await admin.auth.admin.deleteUser(actor);if(cleanup.error)throw new Error("Mobile test cleanup failed: "+cleanup.error.code);await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=$2",[actor,subject||null]);}
    await db.end();
  }
});
