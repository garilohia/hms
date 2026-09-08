import {randomUUID} from "node:crypto";
import nextEnv from "@next/env";
import {createClient} from "@supabase/supabase-js";
import postgres from "postgres";
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const {DATABASE_URL:database,NEXT_PUBLIC_SUPABASE_URL:url,SUPABASE_SECRET_KEY:key}=process.env;
  if(!database||!url||!key)throw new Error("Supabase configuration required.");
  const db=postgres(database,{max:1,prepare:false}),admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    for(const status of ["verified","pending"]) {
      const email="hms-sample-doctor-"+status+"@example.invalid";
      let [user]=await db.unsafe<{id:string;raw_app_meta_data:Record<string,unknown>}[]>("select id,raw_app_meta_data from auth.users where email=$1",[email]);
      if(user&&user.raw_app_meta_data?.hms_sample_doctor!==true)throw new Error("Refusing to modify an account without the sample-doctor marker.");
      if(!user) {
        const result=await admin.auth.admin.createUser({email,password:randomUUID()+randomUUID(),email_confirm:true,
          user_metadata:{name:"Sample doctor · "+status,dob:"1990-01-01"},app_metadata:{hms_sample_doctor:true}});
        if(result.error)throw new Error("Sample doctor creation failed: "+result.error.code);
        user={id:result.data.user.id,raw_app_meta_data:{hms_sample_doctor:true}};
      }
      await db.begin(async sql=>{
        const [p]=await sql.unsafe("select id from public.profiles where auth_user_id=$1 for update",[user.id]);
        if(!p)throw new Error("Sample doctor profile missing.");
        await sql.unsafe("update public.profiles set role='doctor',onboarding_completed_at=coalesce(onboarding_completed_at,now()) where id=$1",[p.id]);
        await sql.unsafe("insert into public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available,verified_at,is_sample) values($1,$2,'Sample council - not a real registration',array['General medicine'],array['English','Hindi'],'Sample data. Fictional practitioner for demonstrating sharing and consults.',500,10,true,case when $3::boolean then now() else null end,true) on conflict(id) do update set is_sample=true",[p.id,"SAMPLE-"+status,status==="verified"]);
        process.stdout.write(JSON.stringify({fixture:"sample_doctor",status,profile:p.id})+"\n");
      });
    }
  }finally{await db.end();}
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:"Doctor seed failed")+"\n");process.exitCode=1;});
