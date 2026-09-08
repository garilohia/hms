import { describe,expect,it } from "vitest";
import { chartMetrics,chartSeries } from "../src/lib/patient/chart";
import { summarySchema,viewInput } from "../src/lib/patient/model";
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
