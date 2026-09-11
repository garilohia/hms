"use client";
import { displayModes,type DisplayMode } from "@/src/lib/patient/model";
// DESIGN.md §9: one system, three densities. The choice never changes navigation, copy, colour roles or the accessibility floor.
const descriptions:Record<DisplayMode,{title:string;body:string}>={
  simple:{title:"Simple",body:"One hero metric and at most three cards on Today. Larger text and buttons. History shows one small chart per metric."},
  standard:{title:"Standard",body:"The default. Hero, up to three insights and the full History chart with ranges."},
  advanced:{title:"Advanced",body:"Overlay up to four metrics, see the raw daily table with its source, the numeric baseline and how the range is computed."},
};
export function DisplayModePicker({value,onChange,disabled=false}:{value:DisplayMode;onChange:(mode:DisplayMode)=>void;disabled?:boolean}) {
  return <fieldset className="stack" disabled={disabled}><legend className="type-label">Display</legend>
    {displayModes.map(mode=><label key={mode} className="mode-option"><input type="radio" name="display_mode" value={mode} checked={value===mode} onChange={()=>onChange(mode)}/><span><strong>{descriptions[mode].title}</strong>{descriptions[mode].body}</span></label>)}
  </fieldset>;
}
