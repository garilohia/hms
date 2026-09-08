import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import type { EmailPayload } from "./transport";
type Executor = Pick<postgres.Sql, "unsafe">;
type Transaction = <T>(work: (tx: Executor) => Promise<T>) => Promise<T>;
export type DeliveryJob = { id: string; userId: string; token: string; attempts: number };
export interface DeliveryStore {
  escalate(now: Date): Promise<number>;
  claim(now: Date): Promise<DeliveryJob | null>;
  prepare(job: DeliveryJob, now: Date): Promise<EmailPayload | null>;
  finish(job: DeliveryJob, now: Date, status: "sent" | "stubbed"): Promise<void>;
  retry(job: DeliveryJob, now: Date, error: string): Promise<void>;
}
export class PostgresDeliveryStore implements DeliveryStore {
  private t: (name: string) => string;
  private transaction: Transaction;
  constructor(private db: Executor, options: { transaction: Transaction; schema?: string }) {
    const schema = options.schema || "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid schema.");
    this.t = name => '"' + schema + '"."' + name + '"'; this.transaction = options.transaction;
  }
  async escalate(now: Date) {
    const t = this.t;
    const candidates = await this.db.unsafe("select id,user_id from " + t("alerts") + " where escalation_due_at<=$1 and escalation_processed_at is null and acknowledged_at is null order by escalation_due_at,id limit 10", [now]);
    let count = 0;
    for (const candidate of candidates) {
      count += await this.transaction(async tx => {
        const [profile] = await tx.unsafe("select id,emergency_contact from " + t("profiles") + " where id=$1 for update skip locked", [candidate.user_id]);
        if (!profile) return 0;
        const [alert] = await tx.unsafe("select id from " + t("alerts") + " where id=$1 and escalation_due_at<=$2 and escalation_processed_at is null and acknowledged_at is null for update skip locked", [candidate.id, now]);
        if (!alert) return 0;
        const consent = await tx.unsafe("select 1 from " + t("consents") + " where user_id=$1 and consent_type::text='emergency_contact' and revoked_at is null", [profile.id]);
        const address = z.email().safeParse(profile.emergency_contact?.email);
        if (consent.length && address.success) await tx.unsafe("insert into " + t("alert_deliveries") + "(user_id,alert_id,recipient_kind,recipient_key,available_at) values($1,$2,'contact',$3,$4) on conflict do nothing", [profile.id, alert.id, address.data, now]);
        await tx.unsafe("update " + t("alerts") + " set escalation_processed_at=$2 where id=$1", [alert.id, now]);
        await tx.unsafe("insert into " + t("audit_log") + "(action,target_user_id,target_table,target_id) values('system_escalation_read',$1,'alerts',$2)", [profile.id, alert.id]);
        return 1;
      });
    }
    return count;
  }
  async claim(now: Date): Promise<DeliveryJob | null> {
    const t = this.t;
    return this.transaction(async tx => {
      const [row] = await tx.unsafe("select id,user_id,attempts from " + t("alert_deliveries") + " where status='pending' and channel='email' and available_at<=$1 and (locked_until is null or locked_until<=$1) order by available_at,id limit 1 for update skip locked", [now]);
      if (!row) return null;
      const token = randomUUID();
      await tx.unsafe("update " + t("alert_deliveries") + " set lease_token=$2,locked_until=$3,attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,$4) where id=$1", [row.id, token, new Date(now.getTime() + 120000), now]);
      return { id: row.id, userId: row.user_id, token, attempts: row.attempts + 1 };
    });
  }
  async prepare(job: DeliveryJob, now: Date): Promise<EmailPayload | null> {
    const t = this.t;
    return this.transaction(async tx => {
      const [profile] = await tx.unsafe("select id,owner_account_id,emergency_contact from " + t("profiles") + " where id=$1 for update", [job.userId]);
      if (!profile) return null;
      const [delivery] = await tx.unsafe("select * from " + t("alert_deliveries") + " where id=$1 and lease_token=$2 and status='pending' for update", [job.id, job.token]);
      if (!delivery) return null;
      const [alert] = await tx.unsafe("select a.*,coalesce((select r.enabled from " + t("alert_rules") + " r where r.rule_key=a.metric_snapshot->>'rule_key' and (r.user_id=a.user_id or r.user_id is null) order by r.user_id nulls last limit 1),false) as enabled from " + t("alerts") + " a where a.id=$1", [delivery.alert_id]);
      const consents = await tx.unsafe("select consent_type::text as type from " + t("consents") + " where user_id=$1 and revoked_at is null", [job.userId]);
      const has = (name: string) => consents.some(c => c.type === name);
      let to: string | undefined, permitted = Boolean(alert && !alert.acknowledged_at && !alert.is_historical && alert.enabled && has("data_ingestion"));
      if (delivery.recipient_kind === "contact") {
        permitted &&= has("emergency_contact") && profile.emergency_contact?.email === delivery.recipient_key && alert.severity === "urgent" && new Date(alert.escalation_due_at).getTime() <= now.getTime();
        to = profile.emergency_contact?.email;
      } else {
        const [actor] = await tx.unsafe("select email from auth.users where id=$1 and deleted_at is null and (banned_until is null or banned_until<=$2) and email_confirmed_at is not null", [delivery.recipient_key, now]);
        to = actor?.email;
        if (delivery.recipient_kind === "owner") permitted &&= profile.owner_account_id === delivery.recipient_key && has("alert_email");
        else {
          const access = await tx.unsafe("select 1 from " + t("caregiver_links") + " l where l.patient_id=$1 and l.caregiver_id=$2 and l.role='caregiver' and l.status='active' and l.revoked_at is null and 'alerts'=any(l.granted_scopes) and exists(select 1 from " + t("profiles") + " p join " + t("consents") + " c on c.user_id=p.id where p.auth_user_id=$2 and c.consent_type::text='alert_email' and c.revoked_at is null)", [job.userId, delivery.recipient_key]);
          permitted &&= has("doctor_sharing") && access.length > 0;
        }
      }
      const parsedEmail = z.email().safeParse(to);
      const expired = now.getTime() - new Date(delivery.first_attempt_at).getTime() >= 23 * 3600000;
      if (!permitted || !parsedEmail.success || expired) {
        await tx.unsafe("update " + t("alert_deliveries") + " set status=$3,lease_token=null,locked_until=null,last_error=$4 where id=$1 and lease_token=$2", [job.id, job.token, expired ? "failed" : "cancelled", expired ? "IdempotencyWindowExpired" : null]);
        return null;
      }
      // Freeze provider payload before the first call; retries use exactly the same body.
      const payload = delivery.payload ? z.object({ to: z.email(), body: z.string(), sample: z.boolean() }).parse(delivery.payload) : { to: parsedEmail.data, body: String(alert.metric_snapshot.body), sample: Boolean(alert.is_sample) };
      if (payload.to !== parsedEmail.data) {
        await tx.unsafe("update " + t("alert_deliveries") + " set status='cancelled',lease_token=null,locked_until=null where id=$1 and lease_token=$2", [job.id, job.token]);
        return null;
      }
      await tx.unsafe("update " + t("alert_deliveries") + " set payload=$3::text::jsonb where id=$1 and lease_token=$2", [job.id, job.token, JSON.stringify(payload)]);
      await tx.unsafe("insert into " + t("audit_log") + "(action,target_user_id,target_table,target_id,metadata) values('system_notification_read',$1,'alerts',$2,jsonb_build_object('recipient_kind',$3::text,'recipient_actor',$4::text))", [job.userId, alert.id, delivery.recipient_kind, delivery.recipient_kind === "contact" ? null : delivery.recipient_key]);
      return payload;
    });
  }
  async finish(job: DeliveryJob, now: Date, status: "sent" | "stubbed") {
    const t = this.t;
    await this.transaction(async tx => {
      // Match acknowledgement's profile-first lock order before touching outbox/alert.
      await tx.unsafe("select id from " + t("profiles") + " where id=$1 for update", [job.userId]);
      const [delivery] = await tx.unsafe("update " + t("alert_deliveries") + " set status=$3,delivered_at=$4,lease_token=null,locked_until=null,last_error=null where id=$1 and lease_token=$2 and status='pending' returning alert_id,recipient_kind", [job.id, job.token, status, now]);
      if (delivery?.recipient_kind === "contact" && status === "sent") await tx.unsafe("update " + t("alerts") + " set escalated_to_contact_at=coalesce(escalated_to_contact_at,$2) where id=$1", [delivery.alert_id, now]);
    });
  }
  async retry(job: DeliveryJob, now: Date, error: string) {
    await this.db.unsafe("update " + this.t("alert_deliveries") + " set lease_token=null,locked_until=null,status=$3,last_error=$4,available_at=$5 where id=$1 and lease_token=$2 and status='pending'", [job.id, job.token, job.attempts >= 8 ? "failed" : "pending", error.slice(0, 80), new Date(now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)))]);
  }
}
export function createDeliveryStore(db: postgres.Sql) {
  return new PostgresDeliveryStore(db, { transaction: <T>(work: (tx: Executor) => Promise<T>) => db.begin(tx => work(tx)) as Promise<T> });
}
