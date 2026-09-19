import {randomUUID} from "node:crypto";
import {expect,test,type BrowserContext,type Route} from "@playwright/test";
import {liveFixtures} from "./live-fixtures";

test("Today, History and consultation chat update without refresh",async({page,browser,baseURL},testInfo)=>{
  if(!baseURL)throw new Error("Base URL required.");
  const f=liveFixtures(baseURL);let doctorContext:BrowserContext|undefined;
  try{
    const patient=await f.actor(page,"Sample live patient");
    doctorContext=await browser.newContext({viewport:{width:390,height:844}});
    const doctorPage=await doctorContext.newPage();
    const doctor=await f.actor(doctorPage,"Sample live doctor");
    await f.db.unsafe("update public.profiles set display_mode='advanced' where id=$1",[patient.subject]);
    await f.db.unsafe("update public.profiles set role='doctor' where id=$1",[doctor.subject]);
    await f.db.unsafe("insert into public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available,verified_at,is_sample) values($1,$2,'Synthetic test council',array['General medicine'],array['English'],'Sample test practitioner',0,0,true,now(),true)",[doctor.subject,randomUUID()]);
    const [source]=await f.db.unsafe("insert into public.data_sources(user_id,provider,metadata) values($1,'simulator','{\"sample\":true}') returning id",[patient.subject]);
    await f.db.unsafe("insert into public.daily_summaries(user_id,day,rhr,hrv_avg,spo2_avg,sleep_duration_min,steps,contains_sample,source_ids,recovery_evidence) select $1,current_date-n,60,40,97,420,5000,true,jsonb_build_object('rhr',$2::text),'{}'::jsonb from generate_series(0,400) n",[patient.subject,source.id]);

    await page.goto(baseURL+"/today?profile="+patient.subject);
    await expect(page.getByTestId("patient-live-state")).toHaveAttribute("data-live","live",{timeout:20000});
    await f.db.unsafe("update public.daily_summaries set rhr=71,computed_at=now() where user_id=$1 and day=current_date",[patient.subject]);
    await expect(page.getByText("71",{exact:true}).first()).toBeVisible({timeout:15000});
    await page.screenshot({path:testInfo.outputPath("today-live.png")});

    await page.goto(baseURL+"/history?profile="+patient.subject);
    await expect(page.getByTestId("patient-live-state")).toHaveAttribute("data-live","live",{timeout:20000});
    let historyFaults=0;
    const interruptFinalPing=async(route:Route)=>{
      const input=route.request().postDataJSON();
      if(input.section==="history"&&input.userId===patient.subject&&historyFaults===0){
        historyFaults++;
        await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Synthetic temporary view interruption."})});
      }else await route.fallback();
    };
    await page.route("**/api/patient/view",interruptFinalPing);
    try{
      await f.db.unsafe("update public.daily_summaries set rhr=72,computed_at=now() where user_id=$1 and day=current_date",[patient.subject]);
      // No further write/ping: the failed invalidation must recover on its own.
      await expect(page.locator(".raw-table tbody tr").filter({hasText:"72"}).first()).toBeVisible({timeout:15000});
      expect(historyFaults).toBe(1);
      await expect(page.getByTestId("patient-live-state")).toHaveAttribute("data-live","live");
      await page.screenshot({path:testInfo.outputPath("history-recovered.png")});
    }finally{await page.unroute("**/api/patient/view",interruptFinalPing);}

    // A ping must reload the selected page, not replace older history with the latest page.
    await page.getByRole("button",{name:"All",exact:true}).click();
    await page.getByRole("button",{name:"Earlier history",exact:true}).click();
    const [oldDay]=await f.db.unsafe("select (current_date-370)::text as day");
    await page.getByRole("combobox",{name:/Reading day/}).selectOption(oldDay.day);
    await f.db.unsafe("update public.daily_summaries set rhr=83,computed_at=now() where user_id=$1 and day=current_date-370",[patient.subject]);
    await expect(page.getByTestId("reading-detail")).toContainText("83 bpm");
    await expect(page.locator(".raw-table tbody tr").filter({hasText:oldDay.day})).toContainText("83");
    await expect(page.getByText("This page has 36 days.",{exact:false})).toBeVisible();

    await f.db.unsafe("insert into public.consents(user_id,granted_by,authority,consent_type,policy_version,ip_hash) values($1,$2,'self','doctor_sharing','test-live',$3)",[patient.subject,patient.id,"0".repeat(64)]);
    await f.db.unsafe("insert into public.doctor_patient_links(doctor_id,patient_id,status,granted_scopes) values($1,$2,'active',array['full_history','alerts']::public.sharing_scope[])",[doctor.subject,patient.subject]);
    const [consult]=await f.db.unsafe("insert into public.consults(patient_id,doctor_id,type,status) values($1,$2,'trend_review','accepted') returning id",[patient.subject,doctor.subject]);
    const consultUrl=baseURL+"/consults/"+consult.id;
    await Promise.all([page.goto(consultUrl),doctorPage.goto(consultUrl)]);
    await expect(page.getByTestId("consult-live-state")).toHaveAttribute("data-live","live",{timeout:20000});
    await expect(doctorPage.getByTestId("consult-live-state")).toHaveAttribute("data-live","live",{timeout:20000});

    await doctorPage.getByLabel("Message",{exact:true}).fill("Live doctor message");
    await doctorPage.getByRole("button",{name:"Send message",exact:true}).click();
    await expect(page.locator(".message-row").getByText("Live doctor message",{exact:true})).toBeVisible({timeout:15000});
    await page.getByLabel("Message",{exact:true}).fill("Live patient reply");
    await page.getByRole("button",{name:"Send message",exact:true}).click();
    await expect(doctorPage.locator(".message-row").getByText("Live patient reply",{exact:true})).toBeVisible({timeout:15000});

    // An update missed while disconnected must be recovered on the next subscription.
    await doctorContext.setOffline(true);
    await expect(doctorPage.getByTestId("consult-live-state")).not.toHaveAttribute("data-live","live",{timeout:45000});
    await page.getByLabel("Message",{exact:true}).fill("Message while doctor is offline");
    await page.getByRole("button",{name:"Send message",exact:true}).click();
    await expect(page.locator(".message-row").getByText("Message while doctor is offline",{exact:true})).toBeVisible();
    await doctorContext.setOffline(false);
    await expect(doctorPage.locator(".message-row").getByText("Message while doctor is offline",{exact:true})).toBeVisible({timeout:45000});
    expect(f.errors).toEqual([]);
  }finally{
    await doctorContext?.close();
    await f.cleanup();
  }
});
