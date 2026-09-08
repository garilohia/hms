import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, test } from "@playwright/test";
test("sample alerts, protected cron, acknowledgement, settings and Chrome notification worker", async ({ page, context, baseURL }) => {
  const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret, DATABASE_URL: database, HMS_TEST_CRON_SECRET: cronSecret } = process.env;
  if (!url || !secret || !database || !cronSecret) throw new Error("Live alert verification requires supplied credentials and a test cron secret.");
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(database, { max: 1, prepare: false });
  let actor: string | undefined, subject: string | undefined;
  try {
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: "hms-alert-" + randomUUID() + "@example.com", options: { data: { dob: "1990-01-01", name: "Sample alert tester" } } });
    if (link.error) throw new Error("Could not create test session: " + link.error.code);
    actor = link.data.user.id;
    await page.goto("/auth/confirm?token_hash=" + encodeURIComponent(link.data.properties.hashed_token));
    await expect(page).toHaveURL(baseURL + "/account");
    const [profile] = await db.unsafe("select id from public.profiles where auth_user_id=$1", [actor]); subject = String(profile.id);
    await page.goto("/more/alerts");
    await expect(page.getByRole("heading", { name: "Alert rules and notifications" })).toBeVisible();
    await expect(page.getByText("Browser notification worker registered.", { exact: true })).toBeVisible();
    await context.grantPermissions(["notifications"]);
    await page.getByRole("button", { name: "Test browser notification" }).click();
    await expect(page.getByText("Local test notification shown. Server push is not enabled.", { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications({ tag: "hms-test" })).length)).toBe(1);
    await page.getByLabel("Email me unusual-reading notices.").check();
    await expect(page.getByText("Consent updated.", { exact: true })).toBeVisible();
    const headers = { Origin: baseURL! };
    expect((await page.request.post("/api/consents", { headers, data: { userId: subject, type: "data_ingestion", grant: true } })).ok()).toBe(true);
    const source = await page.request.post("/api/ingestion/sources", { headers, data: { userId: subject, provider: "simulator", key: "Sample data · Alert verification" } });
    expect(source.ok()).toBe(true); const sourceData = await source.json();
    const now = Date.now();
    const metrics = Array.from({ length: 35 }, (_, minute) => ({ metric_type: "spo2", value: minute < 12 ? 88 : 91, unit: "%", recorded_at: new Date(now - 3600000 + minute * 60000).toISOString(), duration_s: 60, quality: "raw", external_id: null }));
    expect((await page.request.post("/api/ingestion/batches", { headers, data: { userId: subject, sourceId: sourceData.id, metrics } })).ok()).toBe(true);
    expect((await page.request.post("/api/jobs/tick")).status()).toBe(401);
    expect((await page.request.post("/api/jobs/tick", { headers: { Authorization: "Bearer incorrect" } })).status()).toBe(401);
    const tick = await page.request.post("/api/jobs/tick", { headers: { Authorization: "Bearer " + cronSecret }, timeout: 110000 });
    expect(tick.status(), await tick.text()).toBe(200);
    // Previous seeded work can be ahead of this new profile; tick bounded batches until this fixture is ready.
    for (let i = 0; i < 10; i++) {
      const [count] = await db.unsafe("select count(*)::int as n from public.alerts where user_id=$1", [subject]);
      if (count.n >= 2) break;
      expect((await page.request.post("/api/jobs/tick", { headers: { Authorization: "Bearer " + cronSecret }, timeout: 110000 })).status()).toBe(200);
    }
    await page.reload();
    await expect(page.getByText("Sample data", { exact: true })).toHaveCount(2);
    await expect(page.getByText("attention", { exact: true })).toBeVisible();
    for (let i = 0; i < 6; i++) {
      const deliveries = await db.unsafe("select status from public.alert_deliveries where user_id=$1", [subject]);
      if (deliveries.length === 2 && deliveries.every(d => d.status === "stubbed")) break;
      expect((await page.request.post("/api/jobs/tick", { headers: { Authorization: "Bearer " + cronSecret }, timeout: 110000 })).status()).toBe(200);
    }
    const delivered = await db.unsafe("select status from public.alert_deliveries where user_id=$1", [subject]);
    expect(delivered.map(d => d.status)).toEqual(["stubbed", "stubbed"]);
    const urgent = page.locator("article").filter({ has: page.getByText("urgent", { exact: true }) });
    await urgent.getByRole("button", { name: "Acknowledge" }).click();
    await expect(page.getByText("1 acknowledged alerts retained in history.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const [stored] = await db.unsafe("select acknowledged_at from public.alerts where user_id=$1 and severity='urgent'", [subject]);
    expect(stored.acknowledged_at).not.toBeNull();
    const wrongOrigin = await page.request.post("/api/alerts/settings", { headers: { Origin: "https://untrusted.example" }, data: { userId: subject, action: "read" } });
    expect(wrongOrigin.status()).toBe(403);
  } finally {
    if (actor) {
      const cleanup = await admin.auth.admin.deleteUser(actor); if (cleanup.error) throw new Error("Alert fixture cleanup failed.");
      await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=$2", [actor, subject || null]);
    }
    await db.end();
  }
});
