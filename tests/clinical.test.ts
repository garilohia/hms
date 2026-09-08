import {describe,expect,it} from "vitest";
import {clinicalBodySchema,clinicalTrend,type ClinicalBody} from "../src/lib/care/clinical-model";
const empty:ClinicalBody={version:1,generated_at:"2026-09-08T00:00:00Z",from:"2026-08-10",to:"2026-09-08",days:30,
  profile:{id:"b428cecd-084b-4ae7-b2d2-b9d00577bc1f",name:"Sample patient",dob:"1990-01-01",sex_at_birth:"male",timezone:"Asia/Kolkata",country:"IN"},
  consent_given_by_guardian:false,contains_sample:true,medications:[],series:[],alert_counts:[],documents:[],document_count:0,
  disclaimer:"Generated from consumer wearable data; not a medical device."};
const day=(date:string,rhr:number|null)=>({day:date,rhr,hrv_avg:null,spo2_avg:null,spo2_min:null,sleep_duration_min:null,weight_kg:null,bp_systolic:null,bp_diastolic:null,contains_sample:true});
describe("clinical summary aggregates",()=>{
  it("keeps no data absent",()=>{expect(clinicalBodySchema.parse(empty)).toEqual(empty);expect(clinicalTrend(empty,"rhr")).toMatchObject({n:0,mean:null,segments:[]});});
  it("breaks gaps and missing values without zero substitution",()=>{
    const t=clinicalTrend({...empty,series:[day("2026-09-01",60),day("2026-09-02",null),day("2026-09-04",70),day("2026-09-05",80)]},"rhr");
    expect(t.n).toBe(3);expect(t.mean).toBe(70);expect(t.segments).toHaveLength(2);expect(t.first).toBe(60);expect(t.last).toBe(80);
  });
  it("draws flat/single data with finite coordinates and actual window positions",()=>{
    const t=clinicalTrend({...empty,series:[day("2026-09-08",60)]},"rhr");expect(t.points[0].x).toBe(224);expect(Number.isFinite(t.points[0].y)).toBe(true);
  });
});
