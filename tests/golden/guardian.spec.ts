import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {expect,test} from "@playwright/test";
import {liveFixtures,noMobileOverflow} from "./live-fixtures";

test("golden 7: guardian consent, separate dependent history and controlled-clock adult conversion",async({page,browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");
  const f=liveFixtures(baseURL),otherContext=await browser.newContext({viewport:{width:390,height:844}}),doctorContext=await browser.newContext({viewport:{width:390,height:844}});
  const recipientPage=await otherContext.newPage(),doctorPage=await doctorContext.newPage(),name="Sample dependent "+randomUUID().slice(0,6);
  try {
    const [dates]=await f.db.unsafe("select ((current_date+1)-interval '18 years')::date::text as dob, (current_date+1)::text||'T12:00:00Z' as adult");
    const minorEmail="hms-minor-"+randomUUID()+"@example.com";
    expect((await page.request.post("/api/auth/sign-in",{headers:{Origin:baseURL},data:{mode:"signup",email:minorEmail,name,dob:dates.dob}})).status()).toBe(400);
    const [minor]=await f.db.unsafe("select count(*)::int as n from auth.users where email=$1",[minorEmail]);expect(minor.n).toBe(0);
    const guardian=await f.actor(page,"Sample guardian"),recipient=await f.actor(recipientPage,"Sample future adult"),doctor=await f.actor(doctorPage,"Sample guardian doctor "+name);
    await f.db.unsafe("update public.profiles set role='doctor' where id=$1",[doctor.subject]);
    await f.db.unsafe("insert into public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available,verified_at,is_sample) values($1,$2,'Synthetic test council',array['General medicine'],array['English'],'Sample practitioner',0,0,true,now(),true)",[doctor.subject,randomUUID()]);
    await page.goto("/more/family");await page.getByLabel("Dependent name",{exact:true}).fill(name);await page.getByLabel("Date of birth",{exact:true}).fill(dates.dob);
    await page.getByLabel("I am the adult guardian and consent",{exact:false}).check();await page.getByRole("button",{name:"Create dependent profile",exact:true}).click();await expect(page).toHaveURL(/\/more\/family\?profile=[a-f0-9-]+$/);
    const subject=new URL(page.url()).searchParams.get("profile")!;f.subjects.push(subject);await noMobileOverflow(page);
    const [child]=await f.db.unsafe("select auth_user_id,owner_account_id from public.profiles where id=$1",[subject]);expect(child.auth_user_id).toBeNull();expect(child.owner_account_id).toBe(guardian.id);
    await f.sample(page,subject,"b");
    const [history]=await f.db.unsafe("select count(*)::int as n from public.metrics where user_id=$1",[subject]);expect(history.n).toBeGreaterThan(1000);
    const [parentHistory]=await f.db.unsafe("select count(*)::int as n from public.metrics where user_id=$1",[guardian.subject]);expect(parentHistory.n).toBe(0);
    await page.goto("/doctors?profile="+subject);await page.getByLabel("I consent to sharing this profile",{exact:false}).check();await page.getByRole("button",{name:"Link Sample guardian doctor "+name,exact:true}).click();
    await expect(page.getByRole("status")).toHaveText("Doctor linked with your chosen scope.");await page.getByRole("link",{name:"Your clinical summary",exact:true}).click();
    await page.getByRole("button",{name:"Save current summary snapshot",exact:true}).click();await expect(page.getByRole("status")).toContainText("Snapshot saved.");
    const download=await page.getByRole("link",{name:"Download clinical PDF",exact:true}).getAttribute("href");if(!download)throw new Error("Snapshot PDF missing.");
    await doctorPage.goto(baseURL+"/summary?profile="+subject);await expect(doctorPage.getByText("Consent given by guardian",{exact:true})).toBeVisible();await noMobileOverflow(doctorPage);
    const pdf=await doctorPage.request.get(baseURL+download);expect(pdf.status()).toBe(200);const pdfPath=testInfo.outputPath("guardian-summary.pdf");await writeFile(pdfPath,await pdf.body());
    expect(execFileSync(process.env.HMS_PDFTOTEXT||"pdftotext",[pdfPath,"-"],{encoding:"utf8"})).toContain("Consent given by guardian");await doctorPage.screenshot({path:testInfo.outputPath("guardian-summary-mobile.png"),fullPage:true});
    expect((await recipientPage.request.post(baseURL+"/api/patient/view",{headers:{Origin:baseURL},data:{userId:subject,section:"today"}})).status()).toBe(403);
    const [link]=await f.db.unsafe("select id from public.caregiver_links where patient_id=$1 and role='guardian'",[subject]);
    expect((await page.request.post("/api/care",{headers:{Origin:baseURL},data:{kind:"sharing",userId:subject,action:"revoke_caregiver",data:{linkId:link.id}}})).status()).toBe(403);
    // A dependent has no Auth identity. Even a database test claiming their profile ID is not a live actor.
    await expect(f.db.begin(async tx=>{await tx.unsafe("SET LOCAL ROLE authenticated");await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[subject]);await tx.unsafe("select public.hms_care_change($1,'revoke_caregiver',$2::text::jsonb)",[subject,JSON.stringify({linkId:link.id})]);})).rejects.toMatchObject({code:"42501"});
    await page.goto("/more/family?profile="+subject);await page.getByLabel("Recipient account code",{exact:true}).fill(recipient.id);await page.getByLabel("I am the owning guardian and am offering",{exact:false}).check();await page.getByRole("button",{name:"Offer adult account conversion",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:"Transfer unavailable."})).toBeVisible();
    // Test-only DB-owner clock: no API or authenticated role may set the current time.
    // This synthetic recipient was created as an adult by Auth; align only its empty fixture profile to the birthday under test.
    await f.db.unsafe("update public.profiles set dob=$2 where id=$1",[recipient.subject,dates.dob]);
    const offer=await f.db.begin(async tx=>{await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[guardian.id]);const [r]=await tx.unsafe("select hms_private.transfer_at($1,'offer',$2::text::jsonb,'golden-test',$3,$4) as id",[subject,JSON.stringify({recipientId:recipient.id}),"a".repeat(64),dates.adult]);return String(r.id);});
    await recipientPage.goto(baseURL+"/more/family");await expect(recipientPage.getByRole("heading",{name:"Conversion offer for "+name,exact:true})).toBeVisible();
    await f.db.begin(async tx=>{await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[recipient.id]);await tx.unsafe("select hms_private.transfer_at($1,'accept',$2::text::jsonb,'golden-test',$3,$4)",[subject,JSON.stringify({offerId:offer,acceptOwnership:true,replaceEmptyProfile:true,consent:true,disclaimer:true}),"a".repeat(64),dates.adult]);});
    await recipientPage.goto(baseURL+"/today?profile="+subject);await expect(recipientPage.getByTestId("today-hero")).toBeVisible();await noMobileOverflow(recipientPage);
    expect((await page.goto("/today?profile="+subject))?.status()).toBe(404);
    expect((await doctorPage.request.get(baseURL+download)).status()).toBe(403);
    const [adult]=await f.db.unsafe("select kind,auth_user_id,owner_account_id from public.profiles where id=$1",[subject]);expect(adult).toMatchObject({kind:"self",auth_user_id:recipient.id,owner_account_id:recipient.id});
    const [retained]=await f.db.unsafe("select count(*)::int as n from public.metrics where user_id=$1",[subject]);expect(retained.n).toBe(history.n);
    const consents=await f.db.unsafe("select authority,granted_by,revoked_at from public.consents where user_id=$1",[subject]);expect(consents.some(c=>c.authority==="guardian"&&c.granted_by===guardian.id&&c.revoked_at)).toBe(true);expect(consents.some(c=>c.authority==="self"&&c.granted_by===recipient.id&&!c.revoked_at)).toBe(true);
    const [retired]=await f.db.unsafe("select status from public.caregiver_links where id=$1",[link.id]);expect(retired.status).toBe("revoked");
    const snapshotId=new URL(download,baseURL).searchParams.get("snapshot");const [snapshot]=await f.db.unsafe("select body from public.summary_snapshots where id=$1",[snapshotId]);expect(snapshot.body.consent_given_by_guardian).toBe(true);
    // Also exercise the production offer/accept route and all UI confirmations. Only
    // this second synthetic dependent's fixture DOB is advanced; no app clock override exists.
    const accepting=await f.actor(recipientPage,"Sample accepting adult");
    await page.goto("/more/family");await page.getByLabel("Dependent name",{exact:true}).fill("Sample adult UI transfer");await page.getByLabel("Date of birth",{exact:true}).fill("2015-01-01");
    await page.getByLabel("I am the adult guardian and consent",{exact:false}).check();await page.getByRole("button",{name:"Create dependent profile",exact:true}).click();await expect(page).toHaveURL(/\/more\/family\?profile=[a-f0-9-]+$/);
    const adultSubject=new URL(page.url()).searchParams.get("profile")!;f.subjects.push(adultSubject);await f.db.unsafe("update public.profiles set dob='1990-01-01' where id=$1",[adultSubject]);
    await page.reload();await page.getByLabel("Recipient account code",{exact:true}).fill(accepting.id);await page.getByLabel("I am the owning guardian and am offering",{exact:false}).check();await page.getByRole("button",{name:"Offer adult account conversion",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Offer saved."})).toBeVisible();
    await recipientPage.goto(baseURL+"/more/family");await expect(recipientPage.getByRole("heading",{name:"Conversion offer for Sample adult UI transfer",exact:true})).toBeVisible();
    for(const label of ["This is my health profile. I accept ownership.","Replace only my empty signup profile.","I consent to HMS storing and processing my health data.","I have read the health disclaimer."])await recipientPage.getByLabel(label,{exact:false}).check();
    await recipientPage.screenshot({path:testInfo.outputPath("adult-transfer-confirmations.png"),fullPage:true});await recipientPage.getByRole("button",{name:"Accept ownership",exact:true}).click();
    await expect(recipientPage).toHaveURL(baseURL+"/today?profile="+adultSubject);await expect(recipientPage.getByTestId("today-hero")).toBeVisible();expect((await page.goto("/today?profile="+adultSubject))?.status()).toBe(404);expect(f.errors).toEqual([]);
  }finally{testInfo.setTimeout(testInfo.timeout+60000);await otherContext.close();await doctorContext.close();await f.cleanup();}
});
