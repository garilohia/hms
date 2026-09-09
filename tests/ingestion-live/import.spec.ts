import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { generateAppleFixture } from "../fixtures/apple-zip";
import { CSV_TEMPLATE } from "../../src/lib/ingestion/csv";
import { MAX_BODY_BYTES } from "../../src/lib/ingestion/model";

const exec = promisify(execFile);
test("CSV round-trip and 210 MiB Apple ZIP in a browser worker, bounded memory and idempotent re-import", async ({ page, browser, baseURL }, info) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, secret = process.env.SUPABASE_SECRET_KEY, dbUrl = process.env.DATABASE_URL;
  if (!url || !secret || !dbUrl) throw new Error("Live ingestion verification requires the supplied Supabase keys and DATABASE_URL.");
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(dbUrl, { max: 1, prepare: false });
  let actor: string | undefined, subject: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let peakRendererRssBytes = 0, memorySamples = 0, sampling = false, maxBatchBytes = 0, maxBatchRecords = 0, batches = 0, workers = 0;
  const browserErrors: string[] = [], memoryErrors: string[] = [];
  const requestErrors: { path: string; status?: number; error: string }[] = [];
  const passes: { pass: number; durationMs: number; inserted: number; skipped: number }[] = [];
  const cdp = await browser.newBrowserCDPSession();
  try {
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("worker", () => { workers++; });
    page.on("response", async response => {
      if (response.url().includes("/api/ingestion/") && response.status() >= 400 && requestErrors.length < 20) {
        requestErrors.push({ path: new URL(response.url()).pathname, status: response.status(), error: (await response.text().catch(() => "Unreadable response")).slice(0, 1000) });
      }
    });
    page.on("requestfailed", request => {
      if (request.url().includes("/api/ingestion/") && requestErrors.length < 20) requestErrors.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText || "Request failed" });
    });
    page.on("request", request => {
      if (!request.url().endsWith("/api/ingestion/batches")) return;
      const body = request.postDataBuffer();
      maxBatchBytes = Math.max(maxBatchBytes, body?.length || 0);
      const json: { metrics: unknown[] } = request.postDataJSON();
      maxBatchRecords = Math.max(maxBatchRecords, json.metrics.length); batches++;
    });
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: "hms-import-" + randomUUID() + "@example.com", options: { data: { name: "Sample import verification", dob: "1990-01-01" } } });
    if (link.error) throw new Error("Could not create import test actor: " + link.error.code);
    actor = link.data.user.id;
    const [p] = await db.unsafe("select id from public.profiles where auth_user_id=$1", [actor]); subject = p.id;
    await page.goto("/auth/confirm?next=/account&token_hash=" + encodeURIComponent(link.data.properties.hashed_token));
    await expect(page).toHaveURL(baseURL + "/account");
    await page.goto("/more/data");
    await page.getByRole("checkbox").check();
    await page.getByLabel("Health export").setInputFiles({ name: "sample.csv", mimeType: "text/csv", buffer: Buffer.from(CSV_TEMPLATE) });
    await page.getByRole("button", { name: "Import selected data", exact: true }).click();
    const progress = page.getByTestId("import-progress");
    await expect(progress).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-inserted", "3");
    const csv = await db.unsafe("select metric_type,value::text,unit from public.metrics where user_id=$1 order by metric_type", [subject!]);
    expect(csv.map(r => [r.metric_type, Number(r.value), r.unit])).toEqual([["resting_heart_rate", 62, "bpm"], ["spo2", 97, "%"], ["weight_kg", 72, "kg"]]);

    const fixturePath = info.outputPath("apple-export.zip"); await mkdir(dirname(fixturePath), { recursive: true });
    const fixture = await generateAppleFixture(fixturePath);
    expect(fixture.bytes).toBeGreaterThanOrEqual(200 * 1024 * 1024);
    // RSS includes native decompression, JS heaps, backing buffers and the page.
    // Sum ALL renderer processes belonging to this dedicated Chromium instance,
    // including the dedicated worker. No subtraction of the idle baseline.
    async function sampleMemory() {
      if (sampling) return;
      sampling = true;
      try {
        const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
        const pids = processInfo.filter(p => p.type.toLowerCase() === "renderer").map(p => p.id);
        if (!pids.length) throw new Error("No renderer PID was returned for memory verification.");
        const { stdout } = await exec("ps", ["-o", "rss=", "-p", pids.join(",")]);
        const bytes = stdout.trim().split(/\s+/).reduce((sum, n) => sum + Number(n) * 1024, 0);
        if (!Number.isFinite(bytes) || !bytes) throw new Error("Renderer RSS could not be measured.");
        peakRendererRssBytes = Math.max(peakRendererRssBytes, bytes); memorySamples++;
      } catch (error) { memoryErrors.push(error instanceof Error ? error.message : "Memory sample failed."); }
      finally { sampling = false; }
    }
    await sampleMemory(); timer = setInterval(() => { void sampleMemory(); }, 200);
    for (let pass = 0; pass < 2; pass++) {
      await page.getByLabel("Health export").setInputFiles(fixturePath);
      const started = Date.now(); let lastAdvance = started, lastCount = -1, nextReport = started;
      await page.getByRole("button", { name: "Import selected data", exact: true }).click();
      await expect(progress).toHaveAttribute("data-status", "working");
      // M2 specifies correctness and bounded memory, not a WAN throughput target.
      // Allow fifteen minutes per pass, but fail a stalled importer within two minutes.
      // These are test-only limits; production request deadlines remain unchanged.
      for (;;) {
        const state = await progress.evaluate(element => ({ status: element.getAttribute("data-status"),
          count: Number(element.getAttribute("data-inserted")) + Number(element.getAttribute("data-skipped")) }));
        const now = Date.now();
        if (state.count !== lastCount) { lastCount = state.count; lastAdvance = now; }
        if (now >= nextReport) {
          process.stdout.write(JSON.stringify({ benchmarkPass: pass + 1, processed: state.count, total: fixture.records, elapsedSeconds: Math.round((now - started) / 1000) }) + "\n");
          nextReport = now + 60_000;
        }
        if (["done", "error", "cancelled"].includes(state.status || "")) break;
        expect(now - started, "Import exceeded the fifteen-minute test limit").toBeLessThan(900_000);
        expect(now - lastAdvance, "Import made no persisted progress for two minutes").toBeLessThan(120_000);
        await page.waitForTimeout(1000);
      }
      expect(await page.locator("main").innerText()).toContain("Import complete");
      await expect(progress).toHaveAttribute("data-status", "done");
      await expect(progress).toHaveAttribute("data-inserted", String(pass === 0 ? fixture.distinct : 0));
      await expect(progress).toHaveAttribute("data-skipped", String(fixture.records - (pass === 0 ? fixture.distinct : 0)));
      const result = { pass: pass + 1, durationMs: Date.now() - started, inserted: pass === 0 ? fixture.distinct : 0, skipped: fixture.records - (pass === 0 ? fixture.distinct : 0) };
      passes.push(result); process.stdout.write(JSON.stringify({ benchmarkPassComplete: result }) + "\n");
    }
    clearInterval(timer); timer = undefined;
    await sampleMemory();
    const [count] = await db.unsafe("select count(*)::int as n from public.metrics where user_id=$1", [subject!]);
    expect(count.n).toBe(fixture.distinct + 3);
    expect(workers).toBe(3); expect(batches).toBeGreaterThan(100);
    expect(maxBatchBytes).toBeLessThanOrEqual(MAX_BODY_BYTES); expect(maxBatchRecords).toBeLessThanOrEqual(1000);
    expect(memorySamples).toBeGreaterThan(20); expect(memoryErrors).toEqual([]);
    expect(peakRendererRssBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(browserErrors).toEqual([]);
    const report = { fixture, passes, workers, batches, maxBatchBytes, maxBatchRecords, memorySamples, peakRendererRssBytes, memoryMeasurement: "Sum of all Chromium renderer RSS, sampled every 200 ms; includes page, dedicated worker and native memory, no baseline subtraction.", verifiedAt: new Date().toISOString() };
    await writeFile(info.outputPath("ingestion-report.json"), JSON.stringify(report, null, 2));
    await info.attach("ingestion-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  } finally {
    if (timer) clearInterval(timer);
    const ui = page.isClosed() ? "Page closed" : await page.locator("main").innerText().catch(() => "UI unavailable");
    const diagnostics = info.outputPath("diagnostics.json");
    await mkdir(dirname(diagnostics), { recursive: true });
    await writeFile(diagnostics, JSON.stringify({ requestErrors, browserErrors, memoryErrors, maxBatchBytes, batches, peakRendererRssBytes, memorySamples, ui }, null, 2)).catch(error => {
      process.stderr.write("Could not save import diagnostics: " + String(error) + "\n");
    });
    await cdp.detach();
    await page.close();
    if (actor) {
      const { error } = await admin.auth.admin.deleteUser(actor);
      if (error) throw new Error("Import fixture cleanup failed: " + error.code);
      await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=$2", [actor, subject || null]);
    }
    await db.end();
  }
});

test("Google Fit and Google Health folders import supported files, skip unrelated formats and deduplicate", async ({ page, baseURL }, info) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, secret = process.env.SUPABASE_SECRET_KEY, dbUrl = process.env.DATABASE_URL;
  if (!url || !secret || !dbUrl) throw new Error("Live ingestion verification requires the supplied Supabase keys and DATABASE_URL.");
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(dbUrl, { max: 1, prepare: false });
  let actor: string | undefined, subject: string | undefined;
  try {
    const folder = info.outputPath("google-fit-folder"); await mkdir(folder, { recursive: true });
    await writeFile(folder + "/Daily activity metrics.csv", "Date,Calories (kcal),Average heart rate (bpm),Step count,Average weight (kg)\n2026-09-01,1800,70,8000,71\n2026-09-02,1900,72,9000,70.5\n");
    await writeFile(folder + "/2026-09-01.csv", "Date,Calories (kcal),Average heart rate (bpm),Step count,Average weight (kg)\n2026-09-01,9999,199,99999,199\n");
    await writeFile(folder + "/account.csv", "Name,Email\nSample,private@example.com\n");
    const googleHealth = folder + "/Physical Activity_GoogleData"; await mkdir(googleHealth, { recursive: true });
    await writeFile(googleHealth + "/heart_rate_2026-09-01.csv", "timestamp,beats per minute,data source\n2026-09-01T06:00:00Z,68,Fitbit\n");
    await writeFile(googleHealth + "/weight.csv", "timestamp,weight grams,data source\n2026-09-01T06:00:00Z,69500,Fitbit\n");
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: "hms-import-" + randomUUID() + "@example.com", options: { data: { name: "Sample Google folder verification", dob: "1990-01-01" } } });
    if (link.error) throw new Error("Could not create import test actor: " + link.error.code);
    actor = link.data.user.id;
    const [profile] = await db.unsafe("select id from public.profiles where auth_user_id=$1", [actor]); subject = profile.id;
    await page.goto("/auth/confirm?next=/more/data&token_hash=" + encodeURIComponent(link.data.properties.hashed_token));
    await expect(page).toHaveURL(baseURL + "/more/data");
    await page.getByRole("checkbox").check();
    await page.getByLabel("Health CSV folder").setInputFiles(folder);
    await expect(page.getByText("5 CSV files selected", { exact: false })).toBeVisible();
    const progress = page.getByTestId("import-progress");
    await page.getByRole("button", { name: "Import selected data", exact: true }).click();
    await expect(progress).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-inserted", "10");
    await expect(progress).toHaveAttribute("data-file-count", "5");
    await expect(progress).toHaveAttribute("data-skipped-files", "2");
    const warnings = page.getByRole("status").filter({ hasText: "Skipped redundant daily CSV" });
    await expect(warnings).toContainText("Skipped redundant daily CSV because Daily activity metrics.csv is present: google-fit-folder/2026-09-01.csv.");
    await expect(warnings).toContainText("Skipped unsupported CSV: google-fit-folder/account.csv.");
    const rows = await db.unsafe("select metric_type,count(*)::int as n from public.metrics where user_id=$1 group by metric_type order by metric_type", [subject!]);
    expect(rows.map(row => [row.metric_type, row.n])).toEqual([["heart_rate", 3], ["steps", 2], ["total_calories", 2], ["weight_kg", 3]]);
    const [source] = await db.unsafe("select provider,source_key from public.data_sources where user_id=$1 and source_key=$2", [subject!, "root:Google Health folder"]);
    expect(source).toMatchObject({ provider: "generic_csv", source_key: "root:Google Health folder" });
    await page.getByRole("button", { name: "Import selected data", exact: true }).click();
    await expect(progress).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-inserted", "0");
    await expect(progress).toHaveAttribute("data-skipped", "10");
  } finally {
    await page.close();
    if (actor) {
      const { error } = await admin.auth.admin.deleteUser(actor);
      if (error) throw new Error("Import fixture cleanup failed: " + error.code);
      await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=$2", [actor, subject || null]);
    }
    await db.end();
  }
});
