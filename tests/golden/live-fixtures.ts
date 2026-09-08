import {randomUUID} from "node:crypto";
import {createClient} from "@supabase/supabase-js";
import postgres from "postgres";
import {expect,type Page} from "@playwright/test";
export function liveFixtures(baseURL:string) {
  const {NEXT_PUBLIC_SUPABASE_URL:url,SUPABASE_SECRET_KEY:key,DATABASE_URL:database}=process.env;
  if(!url||!key||!database)throw new Error("Supabase test configuration required.");
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),db=postgres(database,{max:1,prepare:false});
  const actors:string[]=[],subjects:string[]=[],errors:string[]=[];
  return {db,admin,subjects,errors,
    async actor(page:Page,name:string,dob="1990-01-01") {
      page.on("pageerror",e=>errors.push(e.message));const email="hms-family-"+randomUUID()+"@example.com";
      const link=await admin.auth.admin.generateLink({type:"magiclink",email,options:{data:{name,dob}}});
      if(link.error)throw new Error("Synthetic sign-in failed: "+link.error.code);actors.push(link.data.user.id);
      const [p]=await db.unsafe("select id from public.profiles where auth_user_id=$1",[link.data.user.id]);subjects.push(p.id);
      await db.unsafe("update public.profiles set onboarding_completed_at=now(),sex_at_birth='prefer_not_to_say' where id=$1",[p.id]);
      await page.goto(baseURL+"/auth/confirm?next=/account&token_hash="+encodeURIComponent(link.data.properties.hashed_token));await expect(page.getByRole("heading",{name:"Your account"})).toBeVisible();
      return {id:link.data.user.id,subject:String(p.id),email};
    },
    async sample(page:Page,subject:string,persona:"b"|"c") {
      await page.goto(baseURL+"/more/data?profile="+subject);await page.getByLabel(/I consent to HMS storing and processing my health readings|I give guardian consent to store and process/).check();
      await page.getByLabel("Sample persona").selectOption(persona);await page.getByRole("button",{name:"Load sample data",exact:true}).click();
      await expect(page.getByRole("status").filter({hasText:/Sample data: \d+ readings added/})).toBeVisible({timeout:90000});
      await page.goto(baseURL+"/today?profile="+subject);
      await expect.poll(async()=>{const [count]=await db.unsafe("select count(*)::int as n from public.summary_jobs where user_id=$1 and revision>processed_revision",[subject]);return count.n;},{timeout:150000,intervals:[2000]}).toBe(0);
      await expect(page.getByTestId("today-hero").getByRole("status")).toHaveCount(0,{timeout:30000});
    },
    async cleanup(){
      for(const id of actors){const exists=await db.unsafe("select 1 from auth.users where id=$1",[id]);if(exists.length){const result=await admin.auth.admin.deleteUser(id);if(result.error)throw new Error("Synthetic family account cleanup failed.");}}
      if(actors.length)await db.unsafe("delete from public.audit_log where actor_id=any($1::uuid[]) or target_user_id=any($2::uuid[])",[actors,subjects]);await db.end();
    },
  };
}
export async function noMobileOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);}
