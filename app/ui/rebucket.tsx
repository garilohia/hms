import type { RebucketState } from "@/src/lib/patient/model";

/** OQ005. A timezone change re-groups every imported day. Readings never move, so the
 * history stays readable while its days are recalculated one batch at a time. */
export function RebucketNotice({ state }: { state: RebucketState }) {
  const days = state.pending === 1 ? "1 day" : state.pending + " days";
  return <section className="panel stack" data-testid="rebucket-notice" role="status">
    <p className="type-label">Recalculating your history</p>
    <p>{state.from ? "Your home timezone changed from " + state.from + " to " + state.to + "." : "Your home timezone changed to " + state.to + "."} {days} still to recalculate.</p>
    <p className="muted">Your readings are unchanged. Days marked below are still grouped under the previous timezone. Open this screen again to continue.</p>
  </section>;
}

export function StaleDay({ day, stale }: { day: string; stale: ReadonlySet<string> }) {
  if (!stale.has(day)) return null;
  return <span className="badge" data-testid="stale-day">Awaiting recalculation</span>;
}
