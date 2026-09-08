import { addDays } from "../analytics/time";
import type { Summary } from "./model";
export const chartMetrics={
  RHR:{field:"rhr",unit:"bpm",source:"resting_heart_rate"}, HRV:{field:"hrv_avg",unit:"ms",source:"hrv_rmssd"},
  SpO2:{field:"spo2_avg",unit:"%",source:"spo2"}, Sleep:{field:"sleep_duration_min",unit:"min",source:"sleep_duration"},
  Temp:{field:"skin_temp_deviation",unit:"°C from baseline",source:"skin_temperature"}, Weight:{field:"weight_kg",unit:"kg",source:"weight_kg"},
  Steps:{field:"steps",unit:"steps",source:"steps"}, BP:{field:"bp_systolic",unit:"mmHg (systolic)",source:"blood_pressure_systolic"},
} as const;
export type ChartMetric=keyof typeof chartMetrics;
export function chartSeries(rows:Summary[],metric:ChartMetric) {
  const config=chartMetrics[metric],sorted=[...rows].sort((a,b)=>a.day.localeCompare(b.day));
  const values=sorted.flatMap(row=>row[config.field]===null?[]:[row[config.field]!]);
  const min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):1,pad=Math.max(.2,(max-min)*.15);
  const low=min-pad,high=max+pad,first=Date.parse(sorted[0]?.day??"2000-01-01"),last=Date.parse(sorted.at(-1)?.day??"2000-01-02");
  const x=(day:string)=>44+((Date.parse(day)-first)/Math.max(86400000,last-first))*520;
  const y=(value:number)=>195-(value-low)/(high-low)*160;
  const points=sorted.map(row=>({row,x:x(row.day),y:row[config.field]===null?null:y(row[config.field]!),value:row[config.field]}));
  // Break the line at every missing day or missing value. Never fill gaps with zero.
  const segments:string[]=[];let active="",previous:string|null=null;
  for(const point of points) {
    if(point.y===null){if(active)segments.push(active);active="";previous=null;continue;}
    if(previous && point.row.day!==addDays(previous,1)){if(active)segments.push(active);active="";}
    active+=(active?" L":"M")+point.x.toFixed(2)+","+point.y.toFixed(2);previous=point.row.day;
  }
  if(active)segments.push(active);
  return {points,segments,min,max,x,y};
}
