import { describe,expect,it } from "vitest";
import { buildSeries,chartMetrics,chartSeries,describeSeries,rollingBand } from "../src/lib/patient/chart";
import { profileSchema,summarySchema,viewInput } from "../src/lib/patient/model";
import { dailySummary } from "../src/lib/analytics/daily";
const row=(day:string,rhr:number|null)=>summarySchema.parse({...dailySummary([],{day,timezone:"UTC"}),rhr,recovery_evidence:{}});
describe("patient display boundaries",()=>{
  it("breaks chart lines at absent dates and null readings",()=>{
    const result=chartSeries([row("2026-08-01",60),row("2026-08-02",61),row("2026-08-04",62),row("2026-08-05",null),row("2026-08-06",63)],"RHR");
    expect(result.segments).toHaveLength(3);expect(result.points[3].y).toBeNull();
  });
  it("handles empty, single-point and flat charts without infinite coordinates",()=>{
    expect(chartSeries([],"RHR").points).toEqual([]);
    for(const rows of [[row("2026-08-01",60)],[row("2026-08-01",60),row("2026-08-02",60)]]) {
      const result=chartSeries(rows,"RHR");expect(result.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
    }
  });
  it("draws the band only after seven baseline days and reports the honest count until 28",()=>{
    const days=(n:number,value:(i:number)=>number|null)=>Array.from({length:n},(_,i)=>({day:"2026-07-"+String(i+1).padStart(2,"0"),value:value(i)}));
    expect(rollingBand(days(5,()=>60),"2026-07-05")).toBeNull();
    const twelve=buildSeries(days(12,i=>60+(i%3)));
    expect(twelve.bandPaths.length).toBeGreaterThan(0);expect(twelve.building).toBe(true);expect(twelve.baselineDays).toBe(12);
    expect(describeSeries("Resting heart rate","bpm",twelve)).toContain("baseline is still building");
    const month=buildSeries(days(30,i=>60+(i%3)));
    expect(month.building).toBe(false);expect(month.baselineDays).toBe(28);
  });
  it("splits the line at the band boundary and labels the last value",()=>{
    const values=Array.from({length:31},(_,i)=>({day:"2026-08-"+String(i+1).padStart(2,"0"),value:i<28?60+(i%3):72}));
    const series=buildSeries(values);
    expect(series.inside.length).toBeGreaterThan(0);expect(series.outside.length).toBeGreaterThan(0);expect(series.lastOutside).toBe(true);
    expect(series.last?.value).toBe(72);expect(series.segments).toHaveLength(1);
    // The outside piece starts exactly where the inside piece ends, so the polyline is continuous.
    const insideEnd=series.inside[0].split(" L").at(-1),outsideStart=series.outside[0].replace("M","").split(" L")[0];
    expect(insideEnd).toBe(outsideStart);
    expect(describeSeries("Resting heart rate","bpm",series)).toBe("Resting heart rate, 1 Aug to 31 Aug, rising, latest 72 bpm, outside your usual range.");
    const steady=buildSeries(values.map(v=>({...v,value:61})));
    expect(steady.outside).toHaveLength(0);expect(steady.lastOutside).toBe(false);
  });
  it("renders bars from zero with the most recent bar marked",()=>{
    const series=buildSeries([{day:"2026-08-01",value:400},{day:"2026-08-02",value:null},{day:"2026-08-03",value:420}],{kind:"bars"});
    expect(series.low).toBe(0);expect(series.bars).toHaveLength(2);expect(series.bars.at(-1)?.latest).toBe(true);expect(series.bars[0].latest).toBe(false);
  });
  it("defaults the display density to standard and accepts only the three densities",()=>{
    const base={id:"7f1e6c1a-1c7b-4b5e-9a0e-2a2b3c4d5e6f",name:"A",dob:"1990-01-01",kind:"self",timezone:"UTC",sex_at_birth:null,country_of_residence:"IN",onboarding_completed_at:null,cycle_tracking_enabled:false};
    expect(profileSchema.parse(base).display_mode).toBe("standard");expect(profileSchema.parse({...base,display_mode:"simple"}).display_mode).toBe("simple");
    expect(profileSchema.safeParse({...base,display_mode:"dense"}).success).toBe(false);
  });
  it("labels temperature as deviation and BP as systolic, preserving units",()=>{
    expect(chartMetrics.Temp.unit).toBe("°C from baseline");expect(chartMetrics.BP.unit).toContain("systolic");expect(chartMetrics.Sleep.unit).toBe("min");
  });
  it("rejects malformed dates and unbounded cursors",()=>{
    const input={userId:"00000000-0000-4000-8000-000000000001",section:"history"};
    expect(viewInput.safeParse({...input,from:"2026-02-30"}).success).toBe(false);
    expect(viewInput.safeParse({...input,cursor:{at:"x".repeat(100)}}).success).toBe(false);
    expect(viewInput.safeParse({...input,from:"2026-08-01"}).success).toBe(true);
  });
});
