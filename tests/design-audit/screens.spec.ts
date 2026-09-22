import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {expect,test,type Browser,type BrowserContext,type Page} from "@playwright/test";
import {liveFixtures} from "../golden/live-fixtures";

// Captures every route at 390px wide in both colour schemes for the DESIGN.md §13 walk. Output: design-audit/<route>-<scheme>.png
const outDir="design-audit";
type Scheme="light"|"dark";
type Shot={name:string;scheme:Scheme;route:string;scrollWidth:number;status:number|null};
const shots:Shot[]=[];const pageErrors:string[]=[];
const fileName=(route:string)=>route.replace(/\?.*$/,"").replace(/^\/+|\/+$/g,"").replace(/\//g,"-")||"home";

async function navigate(page:Page,route:string,name=fileName(route)) {
  const response=await page.goto(route,{waitUntil:"load"});
  expect(response?.status(),`${name} must return its page, not an error`).toBe(200);
  const expected=new URL(route,page.url()),actual=new URL(page.url());
  expect(actual.pathname,`${name} must not redirect to another screen`).toBe(expected.pathname);
  for(const [key,value] of expected.searchParams)expect(actual.searchParams.get(key),`${name} must retain its selected profile`).toBe(value);
  return response;
}
async function capture(page:Page,scheme:Scheme,route:string,name=fileName(route)) {
  const response=await navigate(page,route,name);
  await page.waitForTimeout(1200);
  const scrollWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
  await page.screenshot({path:`${outDir}/${name}-${scheme}.png`,fullPage:true});
  shots.push({name,scheme,route,scrollWidth,status:response?.status()??null});
  expect(scrollWidth,`${route} must not scroll horizontally`).toBe(390);
}
test("design audit: every route at 390px in light and dark",async({browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");
  shots.length=0;pageErrors.length=0;
  await mkdir(outDir,{recursive:true});
  const f=liveFixtures(baseURL);
  const failures:unknown[]=[],contexts=new Set<BrowserContext>(),onboardingActors=new Set<string>();
  const startedAt=new Date().toISOString();
  const label="Sample caregiver "+randomUUID().slice(0,6);
  const doctorLabel="Sample design doctor "+randomUUID().slice(0,8);
  const notes:string[]=[];
  const manifest=(state:"running"|"complete"|"failed")=>writeFile(`${outDir}/manifest.json`,JSON.stringify({started_at:startedAt,captured_at:new Date().toISOString(),state,complete:state==="complete",viewport_width:390,shots,pageErrors,notes,failure_count:failures.length},null,2));
  async function createContext(options:Parameters<Browser["newContext"]>[0]={}) {
    const context=await browser.newContext({baseURL,viewport:{width:390,height:844},...options});contexts.add(context);return context;
  }
  async function closeContext(context:BrowserContext) {
    try {await context.close();contexts.delete(context);}catch(error){failures.push(error);}
  }
  async function cleanupOnboarding(actor:string) {
    try {
      const result=await f.admin.auth.admin.deleteUser(actor);
      if(result.error)throw new Error("Design onboarding fixture cleanup failed.");
      onboardingActors.delete(actor);
    }catch(error){failures.push(error);}
    // These fixtures never leave onboarding or share another person's data.
    try {await f.db.unsafe("delete from public.audit_log where actor_id=$1",[actor]);}catch(error){failures.push(error);}
  }
  async function withSchemes(source:BrowserContext,run:(page:Page,scheme:Scheme)=>Promise<void>) {
    const state=await source.storageState();
    for(const scheme of ["light","dark"] as const) {
      const context=await createContext({colorScheme:scheme,storageState:state,deviceScaleFactor:2});
      try {
        const page=await context.newPage();
        page.on("pageerror",e=>pageErrors.push(scheme+" "+new URL(page.url()).pathname+": "+e.message));
        await run(page,scheme);
      }finally{await closeContext(context);}
    }
  }
  try {
    // Replace any previous success manifest before creating external fixtures.
    await manifest("running");
    const patientContext=await createContext(),patientPage=await patientContext.newPage();
    const womanContext=await createContext(),womanPage=await womanContext.newPage();
    const caregiverContext=await createContext(),caregiverPage=await caregiverContext.newPage();
    const doctorContext=await createContext(),doctorPage=await doctorContext.newPage();
    // Anonymous routes.
    const anonymousContext=await createContext();
    try {await withSchemes(anonymousContext,async(page,scheme)=>{for(const route of ["/","/sign-in","/legal/privacy","/legal/terms","/legal/disclaimer"])await capture(page,scheme,route);});}
    finally{await closeContext(anonymousContext);}

    // Onboarding, one fresh account per scheme so every step is captured in both modes.
    for(const scheme of ["light","dark"] as const) {
      const link=await f.admin.auth.admin.generateLink({type:"magiclink",email:"hms-design-"+randomUUID()+"@example.com",options:{data:{dob:"1984-01-01",name:"Design audit "+scheme}}});
      if(link.error)throw new Error("Could not create onboarding fixture: "+link.error.code);
      onboardingActors.add(link.data.user.id);
      const context=await createContext({colorScheme:scheme,deviceScaleFactor:2});
      try {
        const page=await context.newPage();page.on("pageerror",e=>pageErrors.push(scheme+" onboarding: "+e.message));
        const response=await page.goto("/auth/confirm?token_hash="+encodeURIComponent(link.data.properties.hashed_token));
        expect(response?.status()).toBe(200);await expect(page).toHaveURL(baseURL+"/onboarding");
        const [profile]=await f.db.unsafe("select id from public.profiles where auth_user_id=$1",[link.data.user.id]);f.subjects.push(profile.id);
        await page.waitForTimeout(800);await page.screenshot({path:`${outDir}/onboarding-1-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-1",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByLabel("Sex at birth").selectOption("female");await page.getByRole("button",{name:"Continue",exact:true}).click();
        await expect(page.getByText("Step 2 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-2-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-2",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByText("Step 3 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-3-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-3",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByText("Step 4 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-4-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-4",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      }finally{await closeContext(context);await cleanupOnboarding(link.data.user.id);}
    }

    // Patient with persona c: alerts, readiness, markers.
    const patient=await f.actor(patientPage,"Sample persona c","1965-01-01");await f.sample(patientPage,patient.subject,"c");
    // Caregiver with summary and alert scope.
    const caregiver=await f.actor(caregiverPage,label);
    await patientPage.goto("/more/family");await patientPage.getByLabel("Caregiver account code",{exact:true}).fill(caregiver.id);
    await patientPage.getByLabel("Read-only scope",{exact:true}).selectOption("summary_only");await patientPage.getByLabel("Also share alerts and allow forwarding",{exact:false}).check();
    await patientPage.getByLabel("I consent to sharing this profile with this caregiver",{exact:false}).check();await patientPage.getByRole("button",{name:"Invite caregiver",exact:true}).click();
    await expect(patientPage.getByRole("status").filter({hasText:"Invitation saved."})).toBeVisible();
    await caregiverPage.goto(baseURL+"/more/family");await caregiverPage.getByRole("button",{name:"Accept invitation from Sample persona c",exact:true}).click();
    await expect(caregiverPage.getByRole("status").filter({hasText:"Invitation accepted."})).toBeVisible();
    // Own the practitioner fixture too: never contact an existing directory doctor.
    const doctor=await f.actor(doctorPage,doctorLabel);
    await f.db.unsafe("update public.profiles set role='doctor' where id=$1",[doctor.subject]);
    await f.db.unsafe("insert into public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available,verified_at,is_sample) values($1,$2,'Synthetic test council',array['General medicine'],array['English'],'Sample test practitioner',0,0,true,now(),true)",[doctor.subject,randomUUID()]);
    await patientPage.goto("/doctors");
    const linkDoctor=patientPage.getByRole("button",{name:"Link "+doctorLabel,exact:true});
    // Directory pagination is read-only and bounded; only the exact fixture may be linked.
    for(let pageIndex=0;await linkDoctor.count()===0&&pageIndex<10;pageIndex++) {
      const next=patientPage.getByRole("button",{name:"More doctors",exact:true});
      if(await next.count()===0)break;
      const previous=await patientPage.locator("article h3").allTextContents();
      await next.click();
      await expect.poll(()=>patientPage.locator("article h3").allTextContents()).not.toEqual(previous);
    }
    await patientPage.getByLabel("I consent to sharing this profile with the doctors I choose",{exact:false}).check();
    await linkDoctor.click();
    await expect(patientPage.getByRole("status")).toHaveText("Doctor linked with your chosen scope.");
    const doctorCard=patientPage.getByRole("heading",{name:"Your doctors",exact:true}).locator("..").getByRole("heading",{name:doctorLabel,exact:true}).locator("..");
    await expect(doctorCard.getByRole("button",{name:"Request review",exact:true})).toBeVisible({timeout:20000});
    await doctorCard.getByRole("button",{name:"Request review",exact:true}).click();
    await patientPage.waitForURL(/\/consults\/[0-9a-f-]+/,{timeout:20000});
    const consultPath=new URL(patientPage.url()).pathname;
    const [consult]=await f.db.unsafe("select doctor_id from public.consults where id=$1 and patient_id=$2",[consultPath.split("/").at(-1)!,patient.subject]);
    expect(consult?.doctor_id).toBe(doctor.subject);

    const patientRoutes=["/today","/doctors","/history","/more","/more/data","/more/devices","/more/alerts","/more/cycle","/more/pharmacy","/more/family","/more/display","/more/advanced","/more/advanced/latency","/account","/account/delete","/summary?profile="+patient.subject,"/doctor"];
    await withSchemes(patientContext,async(page,scheme)=>{
      for(const route of patientRoutes) await capture(page,scheme,route);
      await capture(page,scheme,consultPath,"consult");
      // History with the metric that renders bars and the acknowledged-marker state.
      await navigate(page,"/history");await page.getByRole("button",{name:"Sleep",exact:true}).click();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-sleep-${scheme}.png`,fullPage:true});shots.push({name:"history-sleep",scheme,route:"/history (Sleep)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      await page.getByRole("button",{name:"7 days",exact:true}).click();await expect(page.getByRole("button",{name:"7 days",exact:true})).toBeEnabled();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-7days-${scheme}.png`,fullPage:true});shots.push({name:"history-7days",scheme,route:"/history (7 days)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
    });
    // Densities (DESIGN.md §9) and 200% text (§10) on the patient account.
    for(const mode of ["simple","advanced"] as const) {
      await patientPage.goto("/more/display");await patientPage.getByRole("radio",{name:new RegExp("^"+mode,"i")}).check();
      await expect(patientPage.getByRole("status").filter({hasText:"Saved."})).toBeVisible();
      await withSchemes(patientContext,async(page,scheme)=>{
        await capture(page,scheme,"/today","today-"+mode);await capture(page,scheme,"/history","history-"+mode);
        if(mode==="advanced") {
          await page.getByRole("button",{name:"+ HRV",exact:true}).click();
          await page.getByRole("button",{name:"+ SpO2",exact:true}).click();
          await expect.poll(()=>page.locator(".data-chart .chart-overlay").count()).toBeGreaterThan(0);
          await expect(page.locator(".data-chart .chart-value")).toHaveCount(3);
          await expect(page.locator(".data-chart")).toHaveAttribute("aria-label",/HRV.*SpO2/);
          await page.waitForTimeout(800);
          await page.screenshot({path:`${outDir}/history-advanced-overlays-${scheme}.png`,fullPage:true});
          shots.push({name:"history-advanced-overlays",scheme,route:"/history (Advanced overlays)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        }
      });
    }
    await patientPage.goto("/more/display");await patientPage.getByRole("radio",{name:/^standard/i}).check();await expect(patientPage.getByRole("status").filter({hasText:"Saved."})).toBeVisible();
    await withSchemes(patientContext,async(page,scheme)=>{
      if(scheme!=="light") return;
      for(const route of ["/today","/history","/more"]) {
        await navigate(page,route);await page.evaluate(()=>{document.documentElement.style.fontSize="34px";});await page.waitForTimeout(800);
        const scrollWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
        await page.screenshot({path:`${outDir}/${fileName(route)}-200pct-${scheme}.png`,fullPage:true});shots.push({name:fileName(route)+"-200pct",scheme,route:route+" at 200% text",scrollWidth,status:200});
        expect(scrollWidth,route+" at 200% text must not scroll horizontally").toBe(390);
      }
    });
    await withSchemes(caregiverContext,async(page,scheme)=>{
      await capture(page,scheme,"/today?profile="+patient.subject,"caregiver-today");
      await capture(page,scheme,"/doctor/alerts?profile="+patient.subject,"caregiver-alerts");
      await capture(page,scheme,"/more/family","caregiver-family");
    });
    await withSchemes(doctorContext,async(page,scheme)=>{
      await capture(page,scheme,"/doctor","doctor-verified");
      await expect(page.getByRole("heading",{name:"Your patients",exact:true})).toBeVisible();
      await expect(page.getByRole("heading",{name:"Sample persona c",exact:true})).toBeVisible();
      await expect(page.getByRole("link",{name:"Sample persona c, trend review, requested",exact:true})).toBeVisible();
      await capture(page,scheme,"/summary?profile="+patient.subject,"doctor-summary");
      await expect(page.getByRole("heading",{name:"Clinical summary",exact:true})).toBeVisible();
      await capture(page,scheme,consultPath,"doctor-consult");
      await expect(page.getByRole("button",{name:"Accept consult",exact:true})).toBeVisible();
    });

    // Persona b with cycle estimates for the Temp chart shading.
    const woman=await f.actor(womanPage,"Sample persona b","1984-01-01");
    await womanPage.goto("/more/cycle");await womanPage.getByLabel("Show cycle estimates",{exact:true}).check();await womanPage.waitForTimeout(1500);
    await f.sample(womanPage,woman.subject,"b");
    await withSchemes(womanContext,async(page,scheme)=>{
      await navigate(page,"/history");await page.getByRole("button",{name:"Temp",exact:true}).click();await expect(page.getByTestId("cycle-phase").first()).toBeVisible();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-temp-${scheme}.png`,fullPage:true});shots.push({name:"history-temp",scheme,route:"/history (Temp, cycle shading)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      await capture(page,scheme,"/today","today-readiness");
    });
    for(const shot of shots)expect(shot.scrollWidth,`${shot.name} (${shot.scheme}) must not scroll horizontally`).toBe(390);
    expect(pageErrors).toEqual([]);
    expect(f.errors).toEqual([]);
  }catch(error){failures.push(error);}
  finally{
    testInfo.setTimeout(testInfo.timeout+120000);
    // Save observed coverage before cleanup as well, in case teardown stalls.
    try{await manifest(failures.length?"failed":"running");}catch(error){failures.push(error);}
    for(const context of [...contexts])await closeContext(context);
    for(const actor of [...onboardingActors])await cleanupOnboarding(actor);
    try{await f.cleanup();}catch(error){failures.push(error);}
    finally{try{await f.db.end();}catch(error){failures.push(error);}}
    // A failed run must replace the old manifest with its actual partial coverage.
    try{await manifest(failures.length?"failed":"complete");}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];
  if(failures.length>1)throw new AggregateError(failures,"Design audit or fixture cleanup failed.");
});
