"use client";
// Shared chart component for DESIGN.md §5. Identical in every mode; only the series and controls change.
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { buildSeries, describeSeries, formatDay, formatValue, type ChartKind, type DayValue, BASELINE_WINDOW_DAYS } from "@/src/lib/patient/chart";

export type ChartMarker = { day: string; count: number; acknowledged: boolean };
export type ChartPhase = { day: string; phase: string; confidence: string };
export type ChartOverlay = { label: string; unit: string; values: DayValue[]; baseline?: DayValue[] };
export const overlayStyles = ["chart-overlay-1", "chart-overlay-2", "chart-overlay-3"] as const;
export const cyclePhases = ["menstrual", "follicular", "ovulatory", "luteal"] as const;

type Props = {
  values: DayValue[]; baseline?: DayValue[]; kind: ChartKind; label: string; unit: string;
  height?: number; animate?: boolean; sparkline?: boolean;
  markers?: ChartMarker[]; onMarker?: (day: string) => void; onPick?: (day: string) => void; phases?: ChartPhase[]; overlays?: ChartOverlay[];
};

/* Hatch patterns carry the cycle phase without a colour (§12 forbids any colour outside §4.2). */
function PhasePatterns({ id }: { id: string }) {
  return <defs>
    <pattern id={id + "-menstrual"} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" className="chart-phase-stroke" /></pattern>
    <pattern id={id + "-follicular"} width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r=".8" className="chart-phase" /></pattern>
    <pattern id={id + "-ovulatory"} width="4" height="4" patternUnits="userSpaceOnUse"><line x1="0" y1="2" x2="4" y2="2" className="chart-phase-stroke" /></pattern>
    <pattern id={id + "-luteal"} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" className="chart-phase-stroke" /><line x1="0" y1="3.5" x2="7" y2="3.5" className="chart-phase-stroke" /></pattern>
  </defs>;
}
export function PhaseSwatch({ phase }: { phase: string }) {
  const id = useId().replace(/:/g, "");
  return <svg className="phase-swatch" viewBox="0 0 14 10" aria-hidden="true"><PhasePatterns id={id} /><rect width="14" height="10" fill={`url(#${id}-${phase})`} /></svg>;
}

export function DataChart({ values, baseline, kind, label, unit, height = 160, animate = false, sparkline = false, markers = [], onMarker, onPick, phases, overlays = [] }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [drawing, setDrawing] = useState(animate);
  const id = useId().replace(/:/g, "");
  useEffect(() => {
    const element = frame.current; if (!element) return;
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0].contentRect.width); if (next >= 120) setWidth(next); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  // §8: the line draws once on first paint, then everything responds to actions only.
  useEffect(() => { if (!animate) return; const timer = setTimeout(() => setDrawing(false), 600); return () => clearTimeout(timer); }, [animate]);
  const compact = sparkline;
  const layout = { width, height, top: 14, bottom: compact ? 4 : 14, left: 4, right: compact ? 34 : 44 };
  const series = buildSeries(values, { kind, baseline, layout });
  const overlaySeries = overlays.slice(0, 3).map(o => ({...o,series:buildSeries(o.values, { kind: "line", baseline:o.baseline, layout })}));
  const sentence = describeSeries(label, unit, series) + overlaySeries.map(o => " " + describeSeries(o.label, o.unit, o.series)).join("");
  const draw = drawing ? " chart-draw" : "";
  function pick(event: PointerEvent<SVGSVGElement>) {
    if (!onPick || (event.target as Element).closest("[data-testid=alert-marker]")) return;
    const box = event.currentTarget.getBoundingClientRect(), px = (event.clientX - box.left) * width / box.width;
    const nearest = series.points.filter(p => p.y !== null).reduce<typeof series.points[number] | null>((best, p) => !best || Math.abs(p.x - px) < Math.abs(best.x - px) ? p : best, null);
    if (nearest) onPick(nearest.day);
  }
  const plotHeight = series.axisY - series.layout.top;
  return <div ref={frame} className="chart">
    <svg className="data-chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={sentence} onPointerDown={pick}>
      <title>{sentence}</title>
      {phases && <PhasePatterns id={id} />}
      {phases?.filter(c => cyclePhases.includes(c.phase as typeof cyclePhases[number])).map(c => <rect key={c.day} data-testid="cycle-phase" x={series.x(c.day) - Math.max(1.5, (width - 48) / Math.max(1, series.points.length) / 2)} y={series.layout.top} width={Math.max(3, (width - 48) / Math.max(1, series.points.length))} height={plotHeight} fill={`url(#${id}-${c.phase})`}><title>{c.day + ": " + c.phase + " estimate (" + c.confidence + ")"}</title></rect>)}
      {(compact ? [series.gridValues[2]] : series.gridValues).map((value, i) => <line key={i} className="chart-grid" x1={series.layout.left} x2={width - series.layout.right} y1={series.y(value)} y2={series.y(value)} />)}
      {series.last && <text x={series.layout.left} y={series.layout.top - 4}>{formatValue(series.high)} {unit}</text>}
      {series.bandPaths.map((d, i) => <path key={"band" + i} className={"chart-band" + (series.building ? " building" : "")} d={d} />)}
      {kind === "bars"
        ? series.bars.map(bar => <rect key={bar.day} className={"chart-bar" + (bar.latest ? " latest" : "")} x={bar.x} y={bar.y} width={bar.width} height={bar.height} />)
        : <>
          {series.inside.map((d, i) => <path key={"in" + i} className={"chart-line-inside" + draw} pathLength={1} d={d} />)}
          {series.outside.map((d, i) => <path key={"out" + i} className={"chart-line-outside" + draw} pathLength={1} d={d} />)}
        </>}
      {overlaySeries.map((overlay, i) => <g key={"overlay-" + i}>
        {overlay.series.inside.map((d, j) => <path key={"in-" + j} className={"chart-overlay chart-overlay-inside " + overlayStyles[i]} d={d} />)}
        {overlay.series.outside.map((d, j) => <path key={"out-" + j} className={"chart-overlay chart-overlay-outside " + overlayStyles[i]} d={d} />)}
        {overlay.series.last&&overlay.series.last.y!==null&&overlay.series.lastOutside&&<circle className="chart-end" cx={overlay.series.last.x} cy={overlay.series.last.y} r={2.2}/>}
        {overlay.series.last&&overlay.series.last.y!==null&&<text className="chart-value" x={overlay.series.last.x+5} y={overlay.series.last.y+4}>{formatValue(overlay.series.last.value!)}</text>}
      </g>)}
      {series.last && series.lastOutside && kind !== "bars" && <circle className="chart-end" cx={series.last.x} cy={series.last.y!} r={2.2} />}
      {series.last && <text className="chart-value" x={series.last.x + (kind === "bars" ? series.bars.at(-1)!.width / 2 + 4 : 5)} y={series.last.y! + 4}>{formatValue(series.last.value!)}</text>}
      {markers.map(m => <g key={m.day} data-testid="alert-marker" data-acknowledged={m.acknowledged} role="button" tabIndex={0} aria-label={"Alerts " + m.day + (m.acknowledged ? ", acknowledged" : "")} onClick={() => onMarker?.(m.day)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onMarker?.(m.day); } }}>
        <rect x={series.x(m.day) - 22} y={series.axisY - 22} width={44} height={44} fill="transparent" />
        <line className="chart-notch" x1={series.x(m.day)} x2={series.x(m.day)} y1={series.axisY - 1} y2={series.axisY + 7} />
        <title>{m.count + " unusual readings on " + m.day + (m.acknowledged ? ", acknowledged" : "")}</title>
      </g>)}
    </svg>
    {series.firstDay && <div className="chart-axis"><span>{formatDay(series.firstDay)}</span><span>{series.lastDay && series.lastDay !== series.firstDay ? formatDay(series.lastDay) : ""}</span></div>}
    {series.building && series.last && <div className="chart-building"><span>Building your baseline</span><b>{series.baselineDays} of {BASELINE_WINDOW_DAYS} days</b></div>}
  </div>;
}
