import type { IntegrationProvider } from "./model";

const fallbackDelayMs = 5 * 60_000;
const maximumDateMs = 8_640_000_000_000_000;
const shortDay = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
// HTTP-date accepts IMF-fixdate and the two obsolete wire formats (RFC 9110).
// Do not let Date.parse interpret arbitrary strings such as "1.5" as dates.
const httpDate = new RegExp(`^(?:${shortDay}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT|${shortDay} ${month} (?: \\d|\\d{2}) \\d{2}:\\d{2}:\\d{2} \\d{4})$`);

function secondsDeadline(value: string | null, now: number): number | null {
  if (!value || value.length > 128 || !/^\d+$/.test(value.trim())) return null;
  const deadline = now + Number(value.trim()) * 1000;
  return Number.isFinite(deadline) && deadline <= maximumDateMs ? deadline : null;
}

function retryAfterDeadline(value: string | null, now: number): number | null {
  const seconds = secondsDeadline(value, now);
  if (seconds !== null) return seconds;
  if (!value || value.length > 128 || !httpDate.test(value.trim())) return null;
  let wireDate = value.trim();
  if (!wireDate.endsWith(" GMT")) wireDate += " GMT"; // asctime is GMT, not the host's local zone.
  wireDate = wireDate.replace(/-(\d{2}) (\d{2}:)/, (_match, year: string, time: string) => {
    const latestYear = new Date(now).getUTCFullYear() + 50;
    let resolved = Math.floor(latestYear / 100) * 100 + Number(year);
    if (resolved > latestYear) resolved -= 100;
    return `-${resolved} ${time}`;
  });
  const parsed = Date.parse(wireDate);
  return Number.isFinite(parsed) ? parsed : null;
}

export class ProviderRateLimitError extends Error {
  readonly retryAt: Date;

  constructor(retryAt: Date) {
    super("The wearable provider is limiting requests. Please try again later.");
    if (!Number.isFinite(retryAt.getTime())) throw new RangeError("Invalid provider retry time.");
    this.name = "ProviderRateLimitError";
    this.retryAt = new Date(retryAt.getTime());
  }
}

/** Read only timing headers, never the response body or credentials. */
export function providerResponseError(response: Response, provider: IntegrationProvider, now = new Date()): ProviderRateLimitError | null {
  if (response.status !== 429) return null;
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid provider clock.");
  const retryAt = retryAfterDeadline(response.headers.get("retry-after"), timestamp)
    ?? (provider === "whoop" ? secondsDeadline(response.headers.get("x-ratelimit-reset"), timestamp) : null)
    ?? timestamp + fallbackDelayMs;
  // Expired dates and zero-second responses must not create a hot retry loop.
  return new ProviderRateLimitError(new Date(Math.max(timestamp + 1000, retryAt)));
}

export function providerRetryAfterSeconds(error: ProviderRateLimitError, now = new Date()): string {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid provider clock.");
  return String(Math.max(1, Math.ceil((error.retryAt.getTime() - timestamp) / 1000)));
}
