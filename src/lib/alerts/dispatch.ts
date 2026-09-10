import type { DeliveryStore } from "./delivery-store";
import type { EmailTransport, NotificationTransport } from "./transport";
export async function dispatchAlerts(store: DeliveryStore, transport: NotificationTransport | EmailTransport, options: { clock?: () => Date; limit?: number; budgetMs?: number } = {}) {
  const clock = options.clock || (() => new Date());
  const start = performance.now();
  const result = { escalations: await store.escalate(clock()), sent: 0, stubbed: 0, cancelled: 0, failed: 0 };
  for (let i = 0; i < Math.min(options.limit ?? 10, 20) && performance.now() - start < (options.budgetMs ?? 15000); i++) {
    const job = await store.claim(clock());
    if (!job) break;
    try {
      const payload = await store.prepare(job, clock());
      if (!payload) { result.cancelled++; continue; }
      const status = await (transport as NotificationTransport).send("hms-alert/" + job.id, payload);
      await store.finish(job, clock(), status); result[status]++;
    } catch (error) {
      const safe = error instanceof Error && /^[A-Za-z0-9]{1,60}$/.test(error.message) ? error.message : "NotificationError";
      await store.retry(job, clock(), safe); result.failed++;
    }
  }
  return result;
}
