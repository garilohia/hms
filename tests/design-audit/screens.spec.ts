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

async function capture(page:Page,scheme:Scheme,route:string,name=fileName(route)) {
  const response=await page.goto(route,{waitUntil:"load"});
  await page.waitForTimeout(1200);
  const scrollWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
  await page.screenshot({path:`${outDir}/${name}-${scheme}.png`,fullPage:true});
  shots.push({name,scheme,route,scrollWidth,status:response?.status()??null});
  expect(scrollWidth,`${route} must not scroll horizontally`).toBe(390);
}
async function withSchemes(browser:Browser,source:BrowserContext,run:(page:Page,scheme:Scheme)=>Promise<void>) {
  const state=await source.storageState();
  for(const scheme of ["light","dark"] as const) {
    const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:scheme,storageState:state,deviceScaleFactor:2});
    const page=await context.newPage();page.on("pageerror",e=>pageErrors.push(scheme+" "+page.url()+": "+e.message));
    try { await run(page,scheme); } finally { await context.close(); }
  }
}

test("design audit: every route at 390px in light and dark",async({browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");
  await mkdir(outDir,{recursive:true});
  const f=liveFixtures(baseURL);
  const patientContext=await browser.newContext({viewport:{width:390,height:844}}),patientPage=await patientContext.newPage();
  const womanContext=await browser.newContext({viewport:{width:390,height:844}}),womanPage=await womanContext.newPage();
  const caregiverContext=await browser.newContext({viewport:{width:390,height:844}}),caregiverPage=await caregiverContext.newPage();
  const label="Sample caregiver "+randomUUID().slice(0,6);
  const notes:string[]=[];
  try {
    // Anonymous routes.
    await withSchemes(browser,await browser.newContext(),async(page,scheme)=>{ for(const route of ["/","/sign-in","/legal/privacy","/legal/terms","/legal/disclaimer"]) await capture(page,scheme,route); });

    // Onboarding, one fresh account per scheme so every step is captured in both modes.
    for(const scheme of ["light","dark"] as const) {
      const link=await f.admin.auth.admin.generateLink({type:"magiclink",email:"hms-design-"+randomUUID()+"@example.com",options:{data:{dob:"1984-01-01",name:"Design audit "+scheme}}});
      if(link.error)throw new Error("Could not create onboarding fixture: "+link.error.code);
      const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:scheme,deviceScaleFactor:2});const page=await context.newPage();
      page.on("pageerror",e=>pageErrors.push(scheme+" onboarding: "+e.message));
      try {
        await page.goto("/auth/confirm?token_hash="+encodeURIComponent(link.data.properties.hashed_token));await expect(page).toHaveURL(baseURL+"/onboarding");
        const [profile]=await f.db.unsafe("select id from public.profiles where auth_user_id=$1",[link.data.user.id]);f.subjects.push(profile.id);
        await page.waitForTimeout(800);await page.screenshot({path:`${outDir}/onboarding-1-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-1",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByLabel("Sex at birth").selectOption("female");await page.getByRole("button",{name:"Continue",exact:true}).click();
        await expect(page.getByText("Step 2 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-2-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-2",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByText("Step 3 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-3-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-3",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
        await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByText("Step 4 of 4",{exact:true})).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:`${outDir}/onboarding-4-${scheme}.png`,fullPage:true});shots.push({name:"onboarding-4",scheme,route:"/onboarding",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      } finally { await context.close(); const result=await f.admin.auth.admin.deleteUser(link.data.user.id); if(result.error) notes.push("onboarding fixture cleanup failed for "+scheme); }
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
    // A consult with the first verified sample doctor, when the directory has one.
    let consultPath:string|null=null;
    await patientPage.goto("/doctors");
    const consent=patientPage.getByLabel("I consent to sharing this profile with the doctors I choose",{exact:false});
    if(await consent.count()&&await patientPage.getByRole("button",{name:/^Link/}).count()) {
      await consent.check();await patientPage.getByRole("button",{name:/^Link/}).first().click();
      await expect(patientPage.getByRole("button",{name:"Request review",exact:true}).first()).toBeVisible({timeout:20000});
      await patientPage.getByRole("button",{name:"Request review",exact:true}).first().click();
      await patientPage.waitForURL(/\/consults\/[0-9a-f-]+/,{timeout:20000});consultPath=new URL(patientPage.url()).pathname;
    } else notes.push("No verified doctor in the directory; /consults/[id] not captured.");

    const patientRoutes=["/today","/doctors","/history","/more","/more/data","/more/devices","/more/alerts","/more/cycle","/more/pharmacy","/more/family","/more/advanced","/more/advanced/latency","/account","/account/delete","/summary?profile="+patient.subject,"/doctor"];
    await withSchemes(browser,patientContext,async(page,scheme)=>{
      for(const route of patientRoutes) await capture(page,scheme,route);
      if(consultPath) await capture(page,scheme,consultPath,"consult");
      // History with the metric that renders bars and the acknowledged-marker state.
      await page.goto("/history",{waitUntil:"load"});await page.getByRole("button",{name:"Sleep",exact:true}).click();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-sleep-${scheme}.png`,fullPage:true});shots.push({name:"history-sleep",scheme,route:"/history (Sleep)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      await page.getByRole("button",{name:"7 days",exact:true}).click();await expect(page.getByRole("button",{name:"7 days",exact:true})).toBeEnabled();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-7days-${scheme}.png`,fullPage:true});shots.push({name:"history-7days",scheme,route:"/history (7 days)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
    });
    await withSchemes(browser,caregiverContext,async(page,scheme)=>{
      await capture(page,scheme,"/today?profile="+patient.subject,"caregiver-today");
      await capture(page,scheme,"/doctor/alerts?profile="+patient.subject,"caregiver-alerts");
      await capture(page,scheme,"/more/family","caregiver-family");
    });

    // Persona b with cycle estimates for the Temp chart shading.
    const woman=await f.actor(womanPage,"Sample persona b","1984-01-01");
    await womanPage.goto("/more/cycle");await womanPage.getByLabel("Show cycle estimates",{exact:true}).check();await womanPage.waitForTimeout(1500);
    await f.sample(womanPage,woman.subject,"b");
    await withSchemes(browser,womanContext,async(page,scheme)=>{
      await page.goto("/history",{waitUntil:"load"});await page.getByRole("button",{name:"Temp",exact:true}).click();await expect(page.getByTestId("cycle-phase").first()).toBeVisible();await page.waitForTimeout(800);
      await page.screenshot({path:`${outDir}/history-temp-${scheme}.png`,fullPage:true});shots.push({name:"history-temp",scheme,route:"/history (Temp, cycle shading)",scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),status:200});
      await capture(page,scheme,"/today","today-readiness");
    });
    await writeFile(`${outDir}/manifest.json`,JSON.stringify({captured_at:new Date().toISOString(),viewport_width:390,shots,pageErrors,notes},null,2));
    expect(pageErrors).toEqual([]);
  } finally { testInfo.setTimeout(testInfo.timeout+120000);await patientContext.close();await womanContext.close();await caregiverContext.close();await f.cleanup(); }
});
