import webpush from "web-push";

export type EmailPayload = { to: string; body: string; sample: boolean; subscriptions?: never; url?: never };
export type PushPayload = { subscriptions: webpush.PushSubscription[]; url: string; sample: boolean; to?: never; body?: never };
export type NotificationPayload = ({ channel: "email" } & EmailPayload) | ({ channel: "push" } & PushPayload);
export interface EmailTransport { send(key: string, payload: EmailPayload): Promise<"sent" | "stubbed"> }
export function emailTransport(env: { RESEND_API_KEY?: string; EMAIL_FROM?: string } = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM }): EmailTransport {
  return { async send(key, payload) {
    if (payload.sample || !env.RESEND_API_KEY || payload.to.endsWith("@example.invalid")) {
      // Console stub deliberately omits recipients and all health information.
      process.stdout.write(JSON.stringify({ transport: "email_stub", delivery: key }) + "\n");
      return "stubbed";
    }
    if (!env.EMAIL_FROM) throw new Error("EmailSenderMissing");
    const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [payload.to], subject: "HMS reading update", text: payload.body }) });
    if (!response.ok) throw new Error("EmailHTTP" + response.status);
    return "sent";
  } };
}
export interface MessageTransport { send(): Promise<{ status: "stubbed"; reason: string }> }
export const smsTransport: MessageTransport = { async send() { return { status: "stubbed", reason: "SMS provider is not configured." }; } };
export const whatsappTransport: MessageTransport = { async send() { return { status: "stubbed", reason: "WhatsApp provider is not configured." }; } };

export interface PushTransport { send(key: string, payload: PushPayload): Promise<"sent" | "stubbed"> }
export function pushTransport(env: { publicKey?: string; privateKey?: string; subject?: string } = {
  publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT,
}): PushTransport {
  return { async send(_key, payload) {
    if (payload.sample || !payload.subscriptions.length || !env.publicKey || !env.privateKey || !env.subject) return "stubbed";
    webpush.setVapidDetails(env.subject, env.publicKey, env.privateKey);
    const results = await Promise.allSettled(payload.subscriptions.map(subscription => webpush.sendNotification(subscription, JSON.stringify({ url: payload.url }), { TTL: 120, urgency: "high" })));
    if (!results.some(result => result.status === "fulfilled")) throw new Error("PushDeliveryFailed");
    return "sent";
  } };
}

export interface NotificationTransport { send(key: string, payload: NotificationPayload): Promise<"sent" | "stubbed"> }
export function routedTransport(email: EmailTransport, push: PushTransport): NotificationTransport {
  return { send(key, payload) { return payload.channel === "email" ? email.send(key, payload) : push.send(key, payload); } };
}
