import {randomUUID} from "node:crypto";
import {expect,test} from "@playwright/test";
import {createDeliveryStore} from "../../src/lib/alerts/delivery-store";
import {emailTransport} from "../../src/lib/alerts/transport";
import {liveFixtures,noMobileOverflow} from "./live-fixtures";
test("golden 6: caregiver invitation, read-only scope, attention forwarding and instant revocation",async({page,browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");const f=liveFixtures(baseURL),context=await browser.newContext({viewport:{width:390,height:844}}),caregiverPage=await context.newPage();
  const label="Sample caregiver "+randomUUID().slice(0,6);
  try {
    const patient=await f.actor(page,"Sample persona c","1965-01-01"),caregiver=await f.actor(caregiverPage,label);
    await f.sample(page,patient.subject,"c");
    await page.goto("/more/family");await page.getByLabel("Caregiver account code",{exact:true}).fill(caregiver.id);
    await page.getByLabel("Read-only scope",{exact:true}).selectOption("summary_only");await page.getByLabel("Also share alerts and allow forwarding",{exact:false}).check();
    await page.getByLabel("I consent to sharing this profile with this caregiver",{exact:false}).check();await page.getByRole("button",{name:"Invite caregiver",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:"Invitation saved."})).toBeVisible();await noMobileOverflow(page);
    await caregiverPage.goto(baseURL+"/more/family");await caregiverPage.getByRole("button",{name:"Accept invitation from Sample persona c",exact:true}).click();
    await expect(caregiverPage.getByRole("status").filter({hasText:"Invitation accepted."})).toBeVisible();
    await caregiverPage.getByRole("link",{name:"View Sample persona c read-only",exact:true}).click();
    await expect(caregiverPage.getByTestId("today-hero")).toBeVisible();await expect(caregiverPage.getByRole("button",{name:"Acknowledge reading"})).toHaveCount(0);await noMobileOverflow(caregiverPage);
    const denied=await caregiverPage.goto(baseURL+"/history?profile="+patient.subject);expect(denied?.status()).toBe(404);
    expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"raw"}})).status()).toBe(403);
    await caregiverPage.goto(baseURL+"/more/alerts");await caregiverPage.getByLabel("Email me unusual-reading notices.",{exact:true}).check();
    await expect.poll(async()=>{const [row]=await f.db.unsafe("select count(*)::int as n from public.consents where user_id=$1 and consent_type='alert_email' and revoked_at is null",[caregiver.subject]);return row.n;}).toBe(1);
    const sourceResponse=await page.request.post("/api/ingestion/sources",{headers:{Origin:baseURL},data:{userId:patient.subject,provider:"simulator",key:"Sample caregiver attention fixture"}});expect(sourceResponse.ok()).toBe(true);const source=(await sourceResponse.json()).id as string;
    const batch=await page.request.post("/api/ingestion/batches",{headers:{Origin:baseURL},data:{userId:patient.subject,sourceId:source,metrics:[{metric_type:"spo2",value:91,unit:"%",recorded_at:new Date(Date.now()-40*60000).toISOString(),duration_s:1800,quality:"raw",external_id:null}]}});expect(batch.ok()).toBe(true);
    await page.goto("/today");
    await expect.poll(async()=>{const [r]=await f.db.unsafe("select count(*)::int as n from public.alerts where user_id=$1 and source_id=$2 and severity='attention'",[patient.subject,source]);return r.n;},{timeout:45000}).toBe(1);
    const [delivery]=await f.db.unsafe("select d.id,d.user_id from public.alert_deliveries d join public.alerts a on a.id=d.alert_id where a.user_id=$1 and a.source_id=$2 and d.recipient_kind='caregiver' and d.recipient_key=$3",[patient.subject,source,caregiver.id]);expect(delivery).toBeTruthy();
    // Drive only this fixture's outbox item, never drain unrelated users' work in a golden test.
    const token=randomUUID();await f.db.unsafe("update public.alert_deliveries set lease_token=$2,locked_until=now()+interval '2 minutes',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()) where id=$1",[delivery.id,token]);
    const store=createDeliveryStore(f.db);
    const job={id:String(delivery.id),userId:patient.subject,token,attempts:1},payload=await store.prepare(job,new Date());expect(payload?.to).toBe(caregiver.email);expect(payload?.sample).toBe(true);
    if(!payload)throw new Error("Caregiver forwarding was withheld.");const sent=await emailTransport({}).send("hms-alert/"+job.id,payload);expect(sent).toBe("stubbed");await store.finish(job,new Date(),sent);
    const [stored]=await f.db.unsafe("select status from public.alert_deliveries where id=$1",[job.id]);expect(stored.status).toBe("stubbed");
    await caregiverPage.goto(baseURL+"/doctor/alerts?profile="+patient.subject);await expect(caregiverPage.getByText(/SpO2 was 91 %/)).toBeVisible();await noMobileOverflow(caregiverPage);await caregiverPage.screenshot({path:testInfo.outputPath("caregiver-alert.png"),fullPage:true});
    const countReads=async()=>{const [r]=await f.db.unsafe("select count(*)::int as n from public.audit_log where actor_id=$1 and target_user_id=$2 and target_table='patient_view'",[caregiver.id,patient.subject]);return r.n as number;};
    const before=await countReads();for(let i=0;i<3;i++)expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"today"}})).status()).toBe(200);expect(await countReads()).toBe(before+3);
    await page.goto("/more/family");await page.getByRole("button",{name:"Revoke "+label,exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Caregiver access revoked."})).toBeVisible();
    const revoked=await caregiverPage.goto(baseURL+"/today?profile="+patient.subject);expect(revoked?.status()).toBe(404);
    expect((await caregiverPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:patient.subject,section:"today"}})).status()).toBe(403);expect(f.errors).toEqual([]);
  }finally{testInfo.setTimeout(testInfo.timeout+60000);await context.close();await f.cleanup();}
});
