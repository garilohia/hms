import {randomUUID} from "node:crypto";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createClient} from "@supabase/supabase-js";
import postgres from "postgres";
import {chromium,expect,test,type Page} from "@playwright/test";

async function noOverflow(page:Page) { expect(await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}))).toEqual({viewport:390,width:390}); }
for(const persona of ["b","c"] as const) test(persona==="b"?"golden 1: onboard, sample insight, temperature phase chart and mobile PWA":"golden 2: attention acknowledgement leaves Today and remains in History",async({page,baseURL},testInfo)=>{
  const {NEXT_PUBLIC_SUPABASE_URL:url,SUPABASE_SECRET_KEY:secret,DATABASE_URL:database}=process.env;
  if(!url||!secret||!database) throw new Error("Live golden paths require supplied Supabase credentials.");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}}),db=postgres(database,{max:1,prepare:false});
  let actor:string|undefined,subject:string|undefined;
  const errors:string[]=[];page.on("pageerror",error=>errors.push(new URL(page.url()).pathname+": "+error.message));
  const failures:string[]=[];
  page.on("requestfailed",r=>{if(r.url().startsWith(baseURL!))failures.push(new URL(r.url()).pathname+": "+r.failure()?.errorText);});
  page.on("response",r=>{if(r.status()>=400&&r.url().startsWith(baseURL!))failures.push(new URL(r.url()).pathname+": HTTP "+r.status());});
  try {
    const link=await admin.auth.admin.generateLink({type:"magiclink",email:"hms-golden-"+randomUUID()+"@example.com",options:{data:{dob:persona==="b"?"1984-01-01":"1965-01-01",name:"Sample golden "+persona}}});
    if(link.error)throw new Error("Could not create synthetic session: "+link.error.code);
    actor=link.data.user.id;
    await page.goto("/auth/confirm?token_hash="+encodeURIComponent(link.data.properties.hashed_token));
    await expect(page).toHaveURL(baseURL+"/onboarding");
    const [profile]=await db.unsafe("select id from public.profiles where auth_user_id=$1",[actor]);subject=String(profile.id);
    await expect(page.getByText("Step 1 of 4",{exact:true})).toBeVisible();await noOverflow(page);
    await page.getByLabel("Sex at birth").selectOption(persona==="b"?"female":"male");
    if(persona==="b")await page.getByLabel("Show cycle estimates (optional).",{exact:false}).check();
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByText("Step 2 of 4",{exact:true})).toBeVisible();await noOverflow(page);
    await page.getByLabel("I consent to HMS storing and processing my health readings.",{exact:false}).check();
    await page.getByLabel("Sample persona").selectOption(persona);
    await page.getByRole("button",{name:"Load sample data",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:/Sample data: \d+ readings added/})).toBeVisible({timeout:90000});
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByText("Step 3 of 4",{exact:true})).toBeVisible();await noOverflow(page);
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByText("Step 4 of 4",{exact:true})).toBeVisible();await noOverflow(page);
    await page.getByLabel("I have read and understood the disclaimer.").check();
    await page.getByRole("button",{name:"Open Today",exact:true}).click();
    await expect(page).toHaveURL(baseURL+"/today");
    await expect.poll(async()=>{const [count]=await db.unsafe("select count(*)::int as n from public.summary_jobs where user_id=$1 and revision>processed_revision",[subject!]);return count.n;},{timeout:150000,intervals:[2000]}).toBe(0);
    await expect(page.getByTestId("today-hero").getByRole("status")).toHaveCount(0,{timeout:30000});
    await expect(page.getByTestId("insight-card").first()).toBeVisible({timeout:30000});
    expect(await page.getByTestId("insight-card").count()).toBeLessThanOrEqual(3);
    await expect(page.getByTestId("today-hero").getByText("Sample data",{exact:true})).toBeVisible();await noOverflow(page);
    await page.screenshot({path:testInfo.outputPath("today-"+persona+".png"),fullPage:true});
    if(persona==="c") {
      // Most important wins: acknowledge urgent first, then the required attention event.
      for(let i=0;i<5&&await page.getByRole("heading",{name:"urgent reading",exact:false}).count();i++) {
        await page.getByRole("button",{name:"Acknowledge reading"}).click();
        await expect(page.getByRole("button",{name:"Acknowledge reading"})).toBeEnabled();
      }
      await expect(page.getByRole("heading",{name:"attention reading",exact:false})).toBeVisible();
      const [target]=await db.unsafe("select id,metric_snapshot from public.alerts where user_id=$1 and severity='attention' and acknowledged_at is null order by fired_at desc,id limit 1",[subject!]);
      const body=String(target.metric_snapshot.body);
      await expect(page.getByTestId("today-hero")).toContainText(body);
      await page.getByRole("button",{name:"Acknowledge reading"}).click();
      await expect(page.getByTestId("today-hero")).not.toContainText(body);
      const [stored]=await db.unsafe("select acknowledged_at from public.alerts where id=$1",[target.id]);expect(stored.acknowledged_at).not.toBeNull();
    }
    await page.getByRole("navigation",{name:"Main tabs"}).getByRole("link",{name:"History",exact:true}).click();
    await expect(page.getByRole("heading",{name:"History",exact:true})).toBeVisible();
    if(persona==="b") {
      await page.getByRole("button",{name:"Temp",exact:true}).click();await expect(page.getByTestId("cycle-phase").first()).toBeVisible();
      await page.getByLabel("Reading day").selectOption({index:1});await expect(page.getByTestId("reading-detail")).toContainText("Source device:");
      await expect(page.getByTestId("reading-detail")).toContainText("Source device: Sample data · b");
      await page.getByLabel("Reading day").selectOption({index:2});await expect(page.getByTestId("reading-detail")).toContainText("Source device: Sample data · b");
      await expect(page.getByText("Loading documents…",{exact:true})).toHaveCount(0);
      await page.screenshot({path:testInfo.outputPath("temperature-cycle.png"),fullPage:true});
    } else await expect(page.locator('[data-testid="alert-marker"][data-acknowledged="true"]').first()).toBeVisible();
    await noOverflow(page);
    for(const label of ["7 days","30 days","90 days","365 days","All"]) {await page.getByRole("button",{name:label,exact:true}).click();await expect(page.getByRole("button",{name:label,exact:true})).toBeEnabled();await noOverflow(page);}
    for(const route of ["/more","/more/advanced","/more/cycle","/more/data","/more/alerts"]) {await page.goto(route);await noOverflow(page);}
    if(persona==="b") {
      await page.goto("/more/data");
      await page.getByRole("button",{name:"Withdraw processing consent",exact:true}).click();
      await expect(page.getByRole("status").filter({hasText:"Processing consent withdrawn."})).toBeVisible();
      await expect(page.getByLabel("I consent to HMS storing and processing my health readings.",{exact:false})).not.toBeChecked();
      const [source]=await db.unsafe("select id from public.data_sources where user_id=$1 limit 1",[subject!]);
      const denied=await page.request.post("/api/ingestion/batches",{headers:{Origin:baseURL!},data:{userId:subject,sourceId:source.id,metrics:[{metric_type:"heart_rate",value:70,unit:"bpm",recorded_at:new Date(Date.now()-120000).toISOString(),duration_s:60,at_rest:true,quality:"raw",external_id:null}]}});
      expect(denied.status()).toBe(403);
      // Playwright's default contexts are incognito, which deliberately forbids installation.
      // Use an isolated disposable persistent profile, never the user's real browser profile.
      const profileDir=await mkdtemp(join(tmpdir(),"hms-pwa-"));
      const installContext=await chromium.launchPersistentContext(profileDir,{channel:"chromium",headless:true,viewport:{width:390,height:844}});
      try {
      const installPage=await installContext.newPage();await installPage.goto(baseURL!);
      const cdp=await installContext.newCDPSession(installPage);await cdp.send("Page.enable");
      const manifest=await cdp.send("Page.getAppManifest");expect(manifest.errors).toEqual([]);
      if(!manifest.data)throw new Error("The application manifest is missing.");
      expect(JSON.parse(manifest.data).display).toBe("standalone");
      await expect.poll(async()=>await cdp.send("Page.getInstallabilityErrors"),{timeout:30000}).toEqual({installabilityErrors:[]});
      const installability=await cdp.send("Page.getInstallabilityErrors");
      await expect.poll(()=>installPage.evaluate(async()=>(await navigator.serviceWorker.ready).active?.state)).toBe("activated");
      const worker=await installPage.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return {scope:r.scope,active:r.active?.state,cached:(await caches.keys()).length};});
      expect(worker.active).toBe("activated");expect(worker.cached).toBe(0);
      for(const size of [192,512]){const icon=await page.request.get("/app-icon/"+size);expect(icon.ok()).toBe(true);expect(icon.headers()["content-type"]).toContain("image/png");const bytes=await icon.body();expect(bytes.readUInt32BE(16)).toBe(size);expect(bytes.readUInt32BE(20)).toBe(size);}
      await writeFile(testInfo.outputPath("pwa.json"),JSON.stringify({browser:page.context().browser()?.version(),viewport:390,manifest:JSON.parse(manifest.data),installability,worker},null,2));await cdp.detach();
      }finally{await installContext.close();await rm(profileDir,{recursive:true,force:true});}
    }
    expect(errors).toEqual([]);
  }finally {
    testInfo.setTimeout(testInfo.timeout+60000);
    await writeFile(testInfo.outputPath("network.json"),JSON.stringify({errors,failures},null,2));
    if(actor){const result=await admin.auth.admin.deleteUser(actor);if(result.error)throw new Error("Golden fixture cleanup failed.");await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=$2",[actor,subject??null]);}await db.end();
  }
});
