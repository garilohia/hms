import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {createClient} from "@supabase/supabase-js";
import postgres from "postgres";
import {expect,test,type Page,type BrowserContext,type Route} from "@playwright/test";
async function mobile(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);}
async function loseFirstSavedResponse(page:Page,action:string) {
  let lost=false;
  await page.route("**/api/care",async route=>{
    const input=route.request().postDataJSON();
    if(!lost&&input.kind==="consult"&&input.action===action){
      lost=true;const saved=await route.fetch();expect(saved.status()).toBe(200);
      await route.abort("failed"); // The server committed, but the caller cannot tell.
    }else await route.fallback();
  });
}
async function openSummaryBeforeHydration(page:Page) {
  const href=await page.getByRole("link",{name:"Your clinical summary",exact:true}).getAttribute("href");
  if(!href)throw new Error("Clinical summary link missing.");
  let releaseScripts:()=>void=()=>undefined;
  const scriptsReady=new Promise<void>(resolve=>{releaseScripts=resolve;});
  const pendingScripts:Promise<void>[]=[];
  const scriptPattern=/\/_next\/static\/.*\.js(?:\?.*)?$/;
  const holdScript=(route:Route)=>{
    const pending=scriptsReady.then(()=>route.continue());
    pendingScripts.push(pending);
    return pending;
  };
  await page.route(scriptPattern,holdScript);
  try {
    // A full private navigation must not expose actionable controls before their listeners exist.
    await page.goto(href,{waitUntil:"commit"});
    await expect.poll(()=>pendingScripts.length).toBeGreaterThan(0);
    await expect(page.getByRole("button",{name:"Save current summary snapshot",exact:true})).toBeDisabled();
    for(const days of [30,90])await expect(page.getByRole("button",{name:days+" days",exact:true})).toBeDisabled();
    await expect(page.getByRole("textbox",{name:"Your current list (one per line, up to 12)",exact:true})).toBeDisabled();
    await expect(page.getByRole("button",{name:"Save reported medications",exact:true})).toBeDisabled();
  }finally{
    releaseScripts();
    // Drain our continuations before removing interception; unroute can otherwise release them twice.
    try{await Promise.all(pendingScripts);}finally{await page.unroute(scriptPattern,holdScript);}
  }
}
for(const path of [3,4])test(path===3?"golden 3: summary-only doctor, real PDF and audited scope":"golden 4: request, acceptance, both messages and completed note in History",async({page,browser,baseURL},testInfo)=>{
  const {NEXT_PUBLIC_SUPABASE_URL:url,SUPABASE_SECRET_KEY:key,DATABASE_URL:database}=process.env;
  if(!url||!key||!database||!baseURL)throw new Error("Supabase test configuration required.");
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),db=postgres(database,{max:1,prepare:false});
  const actors:string[]=[],subjects:string[]=[],errors:string[]=[];let doctorContext:BrowserContext|undefined;
  const label="Sample care "+randomUUID().slice(0,8);
  async function signIn(target:Page,name:string){target.on("pageerror",e=>errors.push(e.message));
    const link=await admin.auth.admin.generateLink({type:"magiclink",email:"hms-care-"+randomUUID()+"@example.com",options:{data:{name,dob:"1990-01-01"}}});
    if(link.error)throw new Error("Synthetic sign-in failed: "+link.error.code);actors.push(link.data.user.id);
    const [p]=await db.unsafe("select id from public.profiles where auth_user_id=$1",[link.data.user.id]);subjects.push(p.id);
    await db.unsafe("update public.profiles set onboarding_completed_at=now(),sex_at_birth='other' where id=$1",[p.id]);
    await target.goto(baseURL+"/auth/confirm?next=/account&token_hash="+encodeURIComponent(link.data.properties.hashed_token));await expect(target.getByRole("heading",{name:"Your account"})).toBeVisible();
    return {actor:link.data.user.id,subject:String(p.id)};
  }
  try {
    const patient=await signIn(page,label+" patient");doctorContext=await browser.newContext({viewport:{width:390,height:844}});const doctorPage=await doctorContext.newPage();
    const doctor=await signIn(doctorPage,label+" doctor");
    await db.unsafe("update public.profiles set role='doctor' where id=$1",[doctor.subject]);
    await db.unsafe("insert into public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available,verified_at,is_sample) values($1,$2,'Synthetic test council',array['General medicine'],array['English'],'Sample test practitioner',0,0,true,now(),true)",[doctor.subject,randomUUID()]);
    await db.unsafe("insert into public.data_sources(user_id,provider,metadata) values($1,'simulator','{\"sample\":true}')",[patient.subject]);
    await db.unsafe("insert into public.daily_summaries(user_id,day,rhr,hrv_avg,spo2_avg,sleep_duration_min,weight_kg,bp_systolic,bp_diastolic,contains_sample) select $1,current_date-n,60,40,97,420,70,120,80,true from generate_series(1,10) n",[patient.subject]);
    await page.goto("/doctors");await page.getByLabel("I consent to sharing this profile",{exact:false}).check();
    await page.getByRole("button",{name:"Link "+label+" doctor",exact:true}).click();
    await expect(page.getByRole("status")).toHaveText("Doctor linked with your chosen scope.");await mobile(page);
    if(path===3){
      await openSummaryBeforeHydration(page);await page.getByRole("button",{name:"Save current summary snapshot",exact:true}).click();
      await expect(page.getByRole("status")).toContainText("Snapshot saved.");
      const download=await page.getByRole("link",{name:"Download clinical PDF",exact:true}).getAttribute("href");if(!download)throw new Error("PDF link missing.");expect(download).toContain("snapshot=");
      const patientPdf=await page.request.get(download!);expect(patientPdf.status()).toBe(200);expect(patientPdf.headers()["content-type"]).toBe("application/pdf");expect((await patientPdf.body()).subarray(0,4).toString()).toBe("%PDF");
      await doctorPage.goto(baseURL+"/doctor");await expect(doctorPage.getByRole("heading",{name:label+" patient",exact:true})).toBeVisible();
      await expect(doctorPage.getByRole("link",{name:"Read-only History",exact:true})).toHaveCount(0);
      await doctorPage.getByRole("link",{name:"Clinical summary",exact:true}).click();await expect(doctorPage.getByRole("heading",{name:"Clinical summary",exact:true})).toBeVisible();await mobile(doctorPage);
      const doctorPdf=await doctorPage.request.get(baseURL+download);expect(doctorPdf.status()).toBe(200);expect(doctorPdf.headers()["cache-control"]).toContain("no-store");
      await writeFile(testInfo.outputPath("summary-only.pdf"),await doctorPdf.body());await doctorPage.screenshot({path:testInfo.outputPath("summary-only-mobile.png"),fullPage:true});
      expect((await doctorPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL!},data:{userId:patient.subject,section:"raw"}})).status()).toBe(403);
      const response=await doctorPage.goto(baseURL+"/history?profile="+patient.subject);expect(response?.status()).toBe(404);
      for(const query of ["patients=bad","patients="+patient.subject+"&patients="+patient.subject,"consults=%7B","consults=%7B%7D"]){
        const invalid=await doctorPage.goto(baseURL+"/doctor?"+query);expect(invalid?.status()).toBe(404);
        await expect(doctorPage.getByText("Application error",{exact:false})).toHaveCount(0);
      }
      const invalidCursor=await doctorPage.request.post(baseURL+"/api/care",{headers:{Origin:baseURL!},data:{kind:"consult_list",cursor:{}}});expect(invalidCursor.status()).toBe(400);
      const [audit]=await db.unsafe("select count(*)::int as n from public.audit_log where actor_id=$1 and target_user_id=$2 and action='clinical_summary_read'",[doctor.actor,patient.subject]);expect(audit.n).toBeGreaterThanOrEqual(2);
    }else{
      await loseFirstSavedResponse(page,"request");
      const section=page.getByRole("heading",{name:"Your doctors",exact:true}).locator("..");await section.getByLabel("Optional note").fill("Sample trend question");await section.getByRole("button",{name:"Request review",exact:true}).click();
      await expect(page.getByRole("status")).toContainText("Failed to fetch");await section.getByRole("button",{name:"Request review",exact:true}).click();
      await expect(page).toHaveURL(/\/consults\/[a-f0-9-]+$/);const consultUrl=page.url();
      expect((await db.unsafe("select count(*)::int n from public.consults where patient_id=$1",[patient.subject]))[0].n).toBe(1);
      await doctorPage.goto(baseURL+"/doctor");await expect(doctorPage.getByRole("link",{name:label+" patient, trend review, requested",exact:true})).toBeVisible();await doctorPage.goto(consultUrl);
      await doctorPage.getByRole("button",{name:"Accept consult",exact:true}).click();await expect(doctorPage.getByLabel("Message",{exact:true})).toBeVisible();
      // Match the persisted message bubble, not the same text still in the composer.
      await loseFirstSavedResponse(doctorPage,"message");
      await doctorPage.getByLabel("Message",{exact:true}).fill("Sample doctor message");await doctorPage.getByRole("button",{name:"Send message",exact:true}).click();
      await expect(doctorPage.getByRole("status")).toContainText("Failed to fetch");await doctorPage.getByRole("button",{name:"Send message",exact:true}).click();
      await expect(doctorPage.locator(".message-row").getByText("Sample doctor message",{exact:true})).toBeVisible();
      await page.getByRole("button",{name:"Refresh messages",exact:true}).click();await expect(page.locator(".message-row").getByText("Sample doctor message",{exact:true})).toBeVisible();
      let loseRefresh=false;
      await page.route("**/api/care",async route=>{
        const input=route.request().postDataJSON();
        if(input.kind==="consult"&&input.action==="message")loseRefresh=true;
        // Realtime may issue its own read before the command's explicit refresh.
        // Keep reads unavailable until the saved-but-not-refreshed state is observed.
        if(input.kind==="consult_read"&&loseRefresh)await route.abort("failed");else await route.fallback();
      });
      await page.getByLabel("Message",{exact:true}).fill("Sample patient reply");await page.getByRole("button",{name:"Send message",exact:true}).click();
      await expect(page.getByRole("status").filter({hasText:"Saved, but the view could not refresh"})).toBeVisible();await expect(page.getByLabel("Message",{exact:true})).toHaveValue("");
      loseRefresh=false;
      await page.getByRole("button",{name:"Refresh messages",exact:true}).click();await expect(page.locator(".message-row").getByText("Sample patient reply",{exact:true})).toBeVisible();
      await doctorPage.getByRole("button",{name:"Refresh messages",exact:true}).click();await expect(doctorPage.locator(".message-row").getByText("Sample patient reply",{exact:true})).toBeVisible();
      await doctorPage.getByLabel("Doctor note",{exact:true}).fill("Sample completed review note.");await doctorPage.getByRole("button",{name:"Close consult",exact:true}).click();await expect(doctorPage.getByText("Sample completed review note.",{exact:true})).toBeVisible();await mobile(doctorPage);
      await page.goto("/history");await expect(page.getByRole("heading",{name:"Consult notes",exact:true})).toBeVisible();await expect(page.getByText("Sample completed review note.",{exact:true})).toBeVisible();await mobile(page);await page.screenshot({path:testInfo.outputPath("completed-note-mobile.png"),fullPage:true});
      const [count]=await db.unsafe("select count(*)::int as n from public.messages where consult_id=$1",[consultUrl.split("/").at(-1)!]);expect(count.n).toBe(2);
    }
    expect(errors).toEqual([]);
  }finally{
    testInfo.setTimeout(testInfo.timeout+60000);await doctorContext?.close();
    for(const actor of actors){const result=await admin.auth.admin.deleteUser(actor);if(result.error)throw new Error("Synthetic care actor cleanup failed.");}
    if(actors.length)await db.unsafe("delete from public.audit_log where actor_id=any($1::uuid[]) or target_user_id=any($2::uuid[])",[actors,subjects]);await db.end();
  }
});
