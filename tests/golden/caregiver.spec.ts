import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {expect,test,type Page,type Request,type Response} from "@playwright/test";
import {createDeliveryStore} from "../../src/lib/alerts/delivery-store";
import {emailTransport} from "../../src/lib/alerts/transport";
import {liveFixtures,noMobileOverflow} from "./live-fixtures";
test("golden 6: caregiver invitation, read-only scope, attention forwarding and instant revocation",async({page,browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");const f=liveFixtures(baseURL),context=await browser.newContext({viewport:{width:390,height:844}}),caregiverPage=await context.newPage();
  const label="Sample caregiver "+randomUUID().slice(0,6);
  const failures:unknown[]=[],started=Date.now(),origin=new URL(baseURL).origin;
  let phase="create patient session";
  type PageIdentity="patient"|"caregiver";
  type Timing={page:PageIdentity;phase:string;route:string;resource:string;startedAfterMs:number;status?:number;headersAfterMs?:number;completedAfterMs?:number;failedAfterMs?:number;failure?:string};
  const timings=new Map<Request,Timing>();
  const recorded:Record<PageIdentity,number>={patient:0,caregiver:0},dropped:Record<PageIdentity,number>={patient:0,caregiver:0};
  const navigationEvents:{page:PageIdentity;phase:string;event:"domcontentloaded"|"load";afterMs:number}[]=[];
  const safeRoutes=new Set(["/auth/confirm","/account","/onboarding","/sign-in","/today","/history","/more/family","/more/alerts","/doctor/alerts","/api/patient/view","/api/patient/refresh","/api/consents"]);
  const track=(trackedPage:Page,identity:PageIdentity)=>{
    const onRequest=(request:Request)=>{
      const url=new URL(request.url()),resource=request.resourceType();
      const isStatic=url.origin===origin&&url.pathname.startsWith("/_next/static/");
      const isApi=url.origin===origin&&url.pathname.startsWith("/api/");
      if(!isStatic&&!isApi&&!["document","script","stylesheet","font"].includes(resource))return;
      if(recorded[identity]>=250){dropped[identity]++;return;}
      recorded[identity]++;
      // Only fixed route labels are retained. No origins, arbitrary paths,
      // query strings, headers, bodies or actor/profile identifiers are saved.
      const route=url.origin!==origin?"external resource":isStatic?"/_next/static/*":safeRoutes.has(url.pathname)?url.pathname:isApi?"/api/*":"other app resource";
      timings.set(request,{page:identity,phase,route,resource,startedAfterMs:Date.now()-started});
    };
    const onResponse=(response:Response)=>{
      const timing=timings.get(response.request());
      if(timing){timing.status=response.status();timing.headersAfterMs=Date.now()-started-timing.startedAfterMs;}
    };
    const onFinished=(request:Request)=>{
      const timing=timings.get(request);
      if(timing)timing.completedAfterMs=Date.now()-started-timing.startedAfterMs;
    };
    const onFailed=(request:Request)=>{
      const timing=timings.get(request);
      if(timing){
        timing.failedAfterMs=Date.now()-started-timing.startedAfterMs;
        const failure=request.failure()?.errorText;
        timing.failure=failure&&/^net::ERR_[A-Z_]+$/.test(failure)?failure:"request failed";
      }
    };
    const navigation=(event:"domcontentloaded"|"load")=>{
      if(navigationEvents.length<160)navigationEvents.push({page:identity,phase,event,afterMs:Date.now()-started});
    };
    const onDomContentLoaded=()=>navigation("domcontentloaded"),onLoad=()=>navigation("load");
    trackedPage.on("request",onRequest);trackedPage.on("response",onResponse);trackedPage.on("requestfinished",onFinished);trackedPage.on("requestfailed",onFailed);
    trackedPage.on("domcontentloaded",onDomContentLoaded);trackedPage.on("load",onLoad);
    return ()=>{
      trackedPage.off("request",onRequest);trackedPage.off("response",onResponse);trackedPage.off("requestfinished",onFinished);trackedPage.off("requestfailed",onFailed);
      trackedPage.off("domcontentloaded",onDomContentLoaded);trackedPage.off("load",onLoad);
    };
  };
  const stopTracking=[track(page,"patient"),track(caregiverPage,"caregiver")];
  try {
    const patient=await f.actor(page,"Sample persona c","1965-01-01");
    phase="create caregiver session";
    const caregiver=await f.actor(caregiverPage,label);
    phase="seed sample data";
    await f.sample(page,patient.subject,"c");
    phase="invite caregiver";
    await page.goto("/more/family");await page.getByLabel("Caregiver account code",{exact:true}).fill(caregiver.id);
    await page.getByLabel("Read-only scope",{exact:true}).selectOption("summary_only");await page.getByLabel("Also share alerts and allow forwarding",{exact:false}).check();
    await page.getByLabel("I consent to sharing this profile with this caregiver",{exact:false}).check();await page.getByRole("button",{name:"Invite caregiver",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:"Invitation saved."})).toBeVisible();await noMobileOverflow(page);
    phase="accept invitation";
    await caregiverPage.goto(baseURL+"/more/family");await caregiverPage.getByRole("button",{name:"Accept invitation from Sample persona c",exact:true}).click();
    await expect(caregiverPage.getByRole("status").filter({hasText:"Invitation accepted."})).toBeVisible();
    phase="open read-only Today";
    await caregiverPage.getByRole("link",{name:"View Sample persona c read-only",exact:true}).click();
    await expect(caregiverPage.getByTestId("today-hero")).toBeVisible();await expect(caregiverPage.getByRole("button",{name:"Acknowledge reading"})).toHaveCount(0);await noMobileOverflow(caregiverPage);
    phase="verify raw access denied";
    const denied=await caregiverPage.goto(baseURL+"/history?profile="+patient.subject);expect(denied?.status()).toBe(404);
    expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"raw"}})).status()).toBe(403);
    phase="open caregiver alert settings";
    await caregiverPage.goto(baseURL+"/more/alerts");
    phase="enable caregiver email notices";
    await caregiverPage.getByLabel("Email me unusual-reading notices.",{exact:true}).check();
    await expect.poll(async()=>{const [row]=await f.db.unsafe("select count(*)::int as n from public.consents where user_id=$1 and consent_type='alert_email' and revoked_at is null",[caregiver.subject]);return row.n;}).toBe(1);
    phase="create attention reading";
    const sourceResponse=await page.request.post("/api/ingestion/sources",{headers:{Origin:baseURL},data:{userId:patient.subject,provider:"simulator",key:"Sample caregiver attention fixture"}});expect(sourceResponse.ok()).toBe(true);const source=(await sourceResponse.json()).id as string;
    const batch=await page.request.post("/api/ingestion/batches",{headers:{Origin:baseURL},data:{userId:patient.subject,sourceId:source,metrics:[{metric_type:"spo2",value:91,unit:"%",recorded_at:new Date(Date.now()-40*60000).toISOString(),duration_s:1800,quality:"raw",external_id:null}]}});expect(batch.ok()).toBe(true);
    phase="compute patient alert";
    await page.goto("/today");
    await expect.poll(async()=>{const [r]=await f.db.unsafe("select count(*)::int as n from public.alerts where user_id=$1 and source_id=$2 and severity='attention'",[patient.subject,source]);return r.n;},{timeout:45000}).toBe(1);
    phase="verify sample forwarding";
    const [delivery]=await f.db.unsafe("select d.id,d.user_id from public.alert_deliveries d join public.alerts a on a.id=d.alert_id where a.user_id=$1 and a.source_id=$2 and d.recipient_kind='caregiver' and d.recipient_key=$3",[patient.subject,source,caregiver.id]);expect(delivery).toBeTruthy();
    // Drive only this fixture's outbox item, never drain unrelated users' work in a golden test.
    const token=randomUUID();await f.db.unsafe("update public.alert_deliveries set lease_token=$2,locked_until=now()+interval '2 minutes',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()) where id=$1",[delivery.id,token]);
    const store=createDeliveryStore(f.db);
    const job={id:String(delivery.id),userId:patient.subject,token,attempts:1},payload=await store.prepare(job,new Date());expect(payload?.to).toBe(caregiver.email);expect(payload?.sample).toBe(true);
    if(!payload)throw new Error("Caregiver forwarding was withheld.");const sent=await emailTransport({}).send("hms-alert/"+job.id,payload);expect(sent).toBe("stubbed");await store.finish(job,new Date(),sent);
    const [stored]=await f.db.unsafe("select status from public.alert_deliveries where id=$1",[job.id]);expect(stored.status).toBe("stubbed");
    phase="open caregiver alert inbox";
    await caregiverPage.goto(baseURL+"/doctor/alerts?profile="+patient.subject);await expect(caregiverPage.getByText(/SpO2 was 91 %/)).toBeVisible();await noMobileOverflow(caregiverPage);await caregiverPage.screenshot({path:testInfo.outputPath("caregiver-alert.png"),fullPage:true});
    phase="verify read audit";
    const countReads=async()=>{const [r]=await f.db.unsafe("select count(*)::int as n from public.audit_log where actor_id=$1 and target_user_id=$2 and target_table='patient_view'",[caregiver.id,patient.subject]);return r.n as number;};
    const before=await countReads();for(let i=0;i<3;i++)expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"today"}})).status()).toBe(200);expect(await countReads()).toBe(before+3);
    phase="revoke caregiver access";
    await page.goto("/more/family");await page.getByRole("button",{name:"Revoke "+label,exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Caregiver access revoked."})).toBeVisible();
    phase="verify revocation";
    const revoked=await caregiverPage.goto(baseURL+"/today?profile="+patient.subject);expect(revoked?.status()).toBe(404);
    expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"today"}})).status()).toBe(403);expect(f.errors).toEqual([]);
  }catch(error){failures.push(error);}
  finally{
    testInfo.setTimeout(testInfo.timeout+60000);
    try{
      // Snapshot before closing pages: cleanup must not turn pending requests
      // into misleading requestfailed records or hide a navigation timeout.
      for(const stop of stopTracking)stop();
      const capturedAfterMs=Date.now()-started;
      const requests=[...timings.values()].map(timing=>({...timing,ageMs:capturedAfterMs-timing.startedAfterMs,state:timing.failedAfterMs!==undefined?"failed":timing.completedAfterMs!==undefined?"finished":timing.headersAfterMs!==undefined?"pending body":"pending headers"}));
      const timingPath=testInfo.outputPath("caregiver-request-timings.json");
      await writeFile(timingPath,JSON.stringify({scope:"Browser-page requests only; APIRequestContext and database operations are not observed.",phase,capturedAfterMs,testFailed:failures.length>0,limitPerPage:250,dropped,navigationEvents,requests},null,2));
      await testInfo.attach("caregiver-request-timings",{path:timingPath,contentType:"application/json"});
    }catch(error){failures.push(error);}
    finally{
      try{await context.close();}catch(error){failures.push(error);}
      finally{try{await f.cleanup();}catch(error){failures.push(error);}}
    }
  }
  if(failures.length===1)throw failures[0];
  if(failures.length>1)throw new AggregateError(failures,"Caregiver golden path or cleanup failed.");
});
