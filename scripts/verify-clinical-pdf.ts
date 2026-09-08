import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {join,resolve} from "node:path";
import nextEnv from "@next/env";
import postgres from "postgres";
import {clinicalSnapshotSchema,type ClinicalBody} from "../src/lib/care/clinical-model";
import {renderClinicalPdf,UnsupportedPdfText} from "../src/lib/care/clinical-pdf";

nextEnv.loadEnvConfig(process.cwd());
async function main() {
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL required for sample verification.");
  const out=resolve("test-results/clinical-pdf");await mkdir(out,{recursive:true});
  const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false});
  const reports:Record<string,unknown>[]=[];
  async function render(name:string,body:ClinicalBody) {
    const path=join(out,name+".pdf");await writeFile(path,await renderClinicalPdf(body));
    const info=execFileSync(process.env.HMS_PDFINFO||"pdfinfo",[path],{encoding:"utf8"});
    assert.match(info,/Pages:\s+1\b/,name+" must be one page");
    const text=execFileSync(process.env.HMS_PDFTOTEXT||"pdftotext",[path,"-"],{encoding:"utf8"});
    assert.ok(text.includes(body.disclaimer));assert.ok(text.includes("Sample data"));
    if(body.consent_given_by_guardian)assert.ok(text.includes("Consent given by guardian"));
    for(const medication of body.medications.slice(0,6))assert.ok(text.replace(/\s+/g,"").includes(medication.replace(/\s+/g,"")),"Listed medication must not be truncated");
    for(const metric of ["Resting heart rate","HRV (RMSSD)","SpO2","Sleep duration","Weight","Blood pressure"])assert.ok(text.includes(metric));
    execFileSync(process.env.HMS_PDFTOPPM||"pdftoppm",["-r","120","-png","-singlefile",path,join(out,name)]);
    reports.push({name,pages:1,days:body.days,recorded_days:body.series.length,guardian_flag:body.consent_given_by_guardian});
  }
  try {
    for(const persona of ["a","b","c"]) {
      const [p]=await db.unsafe("select p.id,p.auth_user_id from public.profiles p join auth.users u on u.id=p.auth_user_id where u.email=$1 and u.raw_app_meta_data->>'hms_seed'='true' and u.raw_app_meta_data->>'hms_seed_version'='2'",["hms-sample-"+persona+"@example.invalid"]);
      assert.ok(p,"Run the current sample seed first.");
      const result=await db.begin(async sql=>{
        await sql.unsafe("SET LOCAL ROLE authenticated");await sql.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[p.auth_user_id]);
        const [r]=await sql.unsafe("select public.hms_clinical_summary($1,$2) as s",[p.id,persona==="a"?30:90]);
        return clinicalSnapshotSchema.parse(r.s);
      });
      assert.equal(result.body.contains_sample,true);assert.ok(result.body.series.length>0);await render("persona-"+persona,result.body);
      if(persona==="b") {
        const stress={...result.body,consent_given_by_guardian:true,profile:{...result.body.profile,name:"Sample guardian layout stress "+"Long ".repeat(20)},
          medications:Array.from({length:12},(_,i)=>"Sample reported medicine "+i+" - "+"long entry ".repeat(8)),
          documents:Array.from({length:8},(_,i)=>({id:randomUUID(),type:"prescription",title:"Sample prescription "+i+" "+"long title ".repeat(7),uploaded_at:result.body.generated_at})),document_count:12};
        await render("guardian-layout-stress",stress);
        await render("unicode-layout",{...result.body,profile:{...result.body.profile,name:"Sample / नमूना आर्या शर्मा / José"},medications:["Sample medication 100 mg"],documents:[]});
        await assert.rejects(renderClinicalPdf({...result.body,profile:{...result.body.profile,name:"Sample 😀"}}),UnsupportedPdfText);
        await render("wide-layout-stress",{...stress,profile:{...stress.profile,name:"W".repeat(120)},medications:Array.from({length:12},()=>"W".repeat(120))});
      }
    }
    await writeFile(join(out,"report.json"),JSON.stringify(reports,null,2));process.stdout.write(JSON.stringify(reports)+"\n");
  }finally{await db.end();}
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:"PDF verification failed")+"\n");process.exitCode=1;});
