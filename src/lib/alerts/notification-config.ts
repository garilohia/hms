import { createECDH, timingSafeEqual } from "node:crypto";

export type NotificationEnvironment = {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  NEXT_PUBLIC_VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};
export type NotificationConfigCheck = {
  check: string;
  status: "pass" | "fail" | "unverified";
  detail: string;
};

function usableDomain(domain: string): boolean {
  return domain.length <= 253 && domain.split(".").length >= 2
    && domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    && !/\.(?:example|invalid|test|localhost)$/i.test(domain)
    && !/^(?:.+\.)?example\.(?:com|net|org)$/i.test(domain);
}

/** Accepts the plain address and display-name forms supported by EMAIL_FROM. */
export function senderDomain(sender: string | undefined): string | null {
  if (!sender || sender !== sender.trim() || /[\r\n]/.test(sender)) return null;
  const display = /^[^<>]+ <([^<>]+)>$/.exec(sender);
  const address = display ? display[1] : sender;
  const match = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9.-]+)$/i.exec(address);
  if (!match || match[1].length > 64 || match[1].startsWith(".") || match[1].endsWith(".") || match[1].includes("..") || !usableDomain(match[2])) return null;
  return match[2].toLowerCase();
}

function validSubject(subject: string | undefined): boolean {
  if (!subject || subject !== subject.trim() || /\s/.test(subject)) return false;
  try {
    const url = new URL(subject);
    if (url.protocol === "mailto:") return Boolean(senderDomain(url.pathname)) && !url.search && !url.hash;
    return url.protocol === "https:" && usableDomain(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function decodeKey(value: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === length && decoded.toString("base64url") === value ? decoded : null;
}

/** Returns only fixed descriptions, never keys, sender addresses or raw errors. */
export function inspectNotificationConfig(env: NotificationEnvironment): NotificationConfigCheck[] {
  const checks: NotificationConfigCheck[] = [];
  const add = (check: string, ok: boolean, pass: string, fail: string) => checks.push({ check, status: ok ? "pass" : "fail", detail: ok ? pass : fail });
  add("resend_key", Boolean(env.RESEND_API_KEY && /^re_[A-Za-z0-9_-]+$/.test(env.RESEND_API_KEY)),
    "API key syntax is valid; this does not establish sending permission.", "RESEND_API_KEY is missing or malformed.");
  const domain = senderDomain(env.EMAIL_FROM);
  add("email_sender", Boolean(domain && domain !== "resend.dev"),
    "A non-test sender is configured; domain verification is checked separately.", "EMAIL_FROM is missing, malformed, a placeholder, or the Resend test sender.");
  let pairMatches = false;
  try {
    const publicKey = decodeKey(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "", 65);
    const privateKey = decodeKey(env.VAPID_PRIVATE_KEY ?? "", 32);
    if (publicKey && privateKey && publicKey[0] === 4) {
      const curve = createECDH("prime256v1");
      curve.setPrivateKey(privateKey);
      pairMatches = timingSafeEqual(publicKey, curve.getPublicKey());
    }
  } catch { /* Invalid scalars and points are configuration failures, without echoing the key. */ }
  add("vapid_key_pair", pairMatches, "Public and private VAPID keys form the same P-256 key pair.",
    "VAPID keys are missing, malformed, or do not form the same P-256 key pair.");
  add("vapid_subject", validSubject(env.VAPID_SUBJECT), "VAPID subject has a non-placeholder HTTPS or email contact.",
    "VAPID_SUBJECT requires a non-placeholder HTTPS URL or mailto address.");
  return checks;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resend GET /domains response. Unknown shapes cannot establish readiness. */
export function inspectSenderDomain(body: unknown, domain: string): { result: NotificationConfigCheck; nextCursor?: string } {
  const result = (status: NotificationConfigCheck["status"], detail: string) => ({ result: { check: "sender_domain", status, detail } });
  if (!record(body) || body.object !== "list" || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
    return result("unverified", "The provider returned an unrecognised domain-list response.");
  }
  const match = body.data.find((item: unknown) => record(item) && typeof item.name === "string" && item.name.toLowerCase() === domain);
  if (record(match)) {
    if (match.status !== "verified") return result("fail", "The configured sender domain is not verified by Resend.");
    if (!record(match.capabilities) || typeof match.capabilities.sending !== "string") {
      return result("unverified", "Domain verification exists, but sending capability could not be established.");
    }
    return match.capabilities.sending === "enabled"
      ? result("pass", "Resend reports the exact sender domain verified with sending enabled; inbox delivery remains unverified.")
      : result("fail", "The configured sender domain has sending disabled.");
  }
  if (body.has_more) {
    const last: unknown = body.data.at(-1);
    const nextCursor = record(last) && typeof last.id === "string" && last.id ? last.id : undefined;
    return { ...result("unverified", "The sender domain has not been found; the domain list is incomplete."), nextCursor };
  }
  return result("fail", "The exact sender domain is absent from the provider account visible to this API key.");
}
