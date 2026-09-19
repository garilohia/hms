import "server-only";
import { createHash } from "node:crypto";
import { rightsDatabase } from "../data-rights/server";
import type { IntegrationProvider } from "./model";
import { ProviderRateLimitError, providerResponseError } from "./rate-limit";

export class ProviderBudgetConfigurationError extends Error {
  constructor() { super("Wearable request allowance is not configured."); this.name = "ProviderBudgetConfigurationError"; }
}
export class ProviderBudgetUnavailableError extends Error {
  constructor() { super("Wearable request allowance could not be checked. Please try again later."); this.name = "ProviderBudgetUnavailableError"; }
}
export class ProviderBudgetDeferredError extends ProviderRateLimitError {
  constructor(retryAt: Date) {
    super(retryAt);
    this.name = "ProviderBudgetDeferredError";
    this.message = "HMS is waiting for its wearable request allowance. Please try again later.";
  }
}

/** Only project/client identity belongs in this key: never a patient or token. */
export function providerQuotaScope(provider: IntegrationProvider): string {
  const value = provider === "google_health" ? process.env.GOOGLE_HEALTH_QUOTA_PROJECT_ID : process.env.WHOOP_CLIENT_ID;
  if (!value || value !== value.trim()) throw new ProviderBudgetConfigurationError();
  if (provider === "google_health") {
    // https://cloud.google.com/resource-manager/docs/creating-managing-projects
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value) || /google|ssl/.test(value) || value === "undefined") throw new ProviderBudgetConfigurationError();
  } else if (!/^[A-Za-z0-9._-]{1,256}$/.test(value)) throw new ProviderBudgetConfigurationError();
  // No environment suffix: the same client/project must share one DB budget.
  return createHash("sha256").update(`${provider}:${value}`).digest("hex");
}

export function providerQuotaConfigured(provider: IntegrationProvider): boolean {
  try { providerQuotaScope(provider); return true; } catch { return false; }
}

async function budgetDecision(provider: IntegrationProvider, scope: string, retryAt?: Date): Promise<Date | null> {
  try {
    const db = rightsDatabase();
    try {
      // Intentionally separate autocommit connection, never the grant/subject
      // transaction: a later rollback must not refund an attempted HTTP request.
      const rows = retryAt
        ? await db.unsafe("select hms_private.defer_provider_requests($1,$2,$3)::text as retry_at", [provider, scope, retryAt])
        : await db.unsafe("select hms_private.reserve_provider_request($1,$2)::text as retry_at", [provider, scope]);
      if (rows.length !== 1 || !("retry_at" in rows[0])) throw new ProviderBudgetUnavailableError();
      const raw: unknown = rows[0].retry_at;
      if (raw === null && !retryAt) return null;
      if (typeof raw !== "string" && !(raw instanceof Date)) throw new ProviderBudgetUnavailableError();
      const parsed = new Date(raw);
      if (!Number.isFinite(parsed.getTime())) throw new ProviderBudgetUnavailableError();
      return parsed;
    } finally { await db.end(); }
  } catch { throw new ProviderBudgetUnavailableError(); }
}

function checkDeadline(deadline: number, signal?: AbortSignal | null) {
  signal?.throwIfAborted();
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new DOMException("Wearable request budget ended.", "TimeoutError");
}

export async function providerRequest(provider: IntegrationProvider, input: string | URL, init: RequestInit, deadline: number, beforeRequest?: () => Promise<void>): Promise<Response> {
  checkDeadline(deadline, init.signal);
  const scope = providerQuotaScope(provider);
  const url = new URL(input);
  const hosts = provider === "google_health" ? ["health.googleapis.com", "oauth2.googleapis.com"] : ["api.prod.whoop.com"];
  if (url.protocol !== "https:" || url.username || url.password || !hosts.includes(url.hostname)) throw new ProviderBudgetConfigurationError();
  const retryAt = await budgetDecision(provider, scope);
  if (retryAt) throw new ProviderBudgetDeferredError(new Date(Math.max(Date.now() + 1000, retryAt.getTime())));
  // Reservation/connection close may use the remaining invocation budget.
  checkDeadline(deadline, init.signal);
  await beforeRequest?.();
  checkDeadline(deadline, init.signal);
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now())));
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // Preserve the validated destination across awaited admission/authority work.
  // A caller can mutate its URL object; strings are already immutable.
  const response = await fetch(typeof input === "string" ? input : url, { ...init, cache: "no-store", redirect: "error", signal });
  const throttled = providerResponseError(response, provider);
  if (!throttled) return response;
  // Never parse or retain a provider error body. Persist shared throttling even
  // if the calling connection is subsequently disconnected or replaced.
  await response.body?.cancel().catch(() => undefined);
  const sharedRetryAt = await budgetDecision(provider, scope, throttled.retryAt);
  if (!sharedRetryAt) throw new ProviderBudgetUnavailableError();
  throw new ProviderRateLimitError(new Date(Math.max(throttled.retryAt.getTime(), sharedRetryAt.getTime())));
}
