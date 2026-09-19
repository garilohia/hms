import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { expect, test, type Request as BrowserRequest } from "@playwright/test";
import { checkedDocumentPath, DOCUMENT_BUCKET } from "../../src/lib/data-rights/documents";
import { liveFixtures, noMobileOverflow } from "./live-fixtures";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
test("golden 5: three CSV readings, private original document, full ZIP and hard account deletion", async ({ page, browser, baseURL }, testInfo) => {
  const fx = liveFixtures(baseURL!), otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let path: string | undefined;
  let patientSubject: string | undefined;
  const failures: unknown[] = [];
  const testStarted = Date.now();
  type Timing = { method: string; pathname: string; startedAfterMs: number; status?: number; headersAfterMs?: number; completedAfterMs?: number; failedAfterMs?: number };
  const timings = new Map<BrowserRequest, Timing>();
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/documents" || pathname === "/api/patient/view") timings.set(request, { method: request.method(), pathname, startedAfterMs: Date.now() - testStarted });
  });
  page.on("response", response => {
    const timing = timings.get(response.request());
    if (timing) { timing.status = response.status(); timing.headersAfterMs = Date.now() - testStarted - timing.startedAfterMs; }
  });
  page.on("requestfinished", request => {
    const timing = timings.get(request);
    if (timing) timing.completedAfterMs = Date.now() - testStarted - timing.startedAfterMs;
  });
  page.on("requestfailed", request => {
    const timing = timings.get(request);
    if (timing) timing.failedAfterMs = Date.now() - testStarted - timing.startedAfterMs;
  });
  try {
    const patient = await fx.actor(page, "Sample data-rights patient");
    patientSubject = patient.subject;
    const otherPage = await otherContext.newPage();
    const other = await fx.actor(otherPage, "Sample unrelated account");
    const times = [3, 2, 1].map(days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) + "T12:00:00.000Z");
    const csv = "timestamp,metric_type,value,unit\n" + times.map((time, i) => `${time},weight_kg,${70 + i},kg`).join("\n") + "\n";
    await page.goto("/more/data");
    await page.getByLabel("I consent to HMS storing and processing my health readings.", { exact: false }).check();
    await page.getByLabel("Health export").setInputFiles({ name: "three.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByRole("button", { name: "Import selected data", exact: true }).click();
    await expect(page.getByTestId("import-progress")).toHaveAttribute("data-inserted", "3");
    await expect(page.getByTestId("import-progress")).toHaveAttribute("data-status", "done");
    await page.goto("/today");
    await expect.poll(async () => (await fx.db.unsafe("select count(*)::int n from public.summary_jobs where user_id=$1 and revision>processed_revision", [patient.subject]))[0].n).toBe(0);
    await page.goto("/history"); await page.getByRole("button", { name: "Weight", exact: true }).click();
    for (const [index, time] of times.entries()) {
      await page.getByLabel("Reading day").selectOption(time.slice(0, 10));
      await expect(page.getByTestId("reading-detail")).toContainText(`${70 + index} kg`);
    }
    await page.getByLabel("Document title", { exact: true }).fill("Sample uploaded report");
    await page.getByLabel("Document file", { exact: false }).setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Add document", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Document added." })).toBeVisible();
    await noMobileOverflow(page); await page.screenshot({ path: testInfo.outputPath("documents-history.png"), fullPage: true });
    const [doc] = await fx.db.unsafe("select id,storage_path from public.documents where user_id=$1", [patient.subject]); path = String(doc.storage_path);
    const ownDownload = await page.request.get("/api/documents/" + doc.id); expect(ownDownload.status()).toBe(200);
    expect(ownDownload.headers()["cache-control"]).toContain("no-store"); expect(await ownDownload.body()).toEqual(png);
    expect((await otherPage.request.get("/api/documents/" + doc.id)).status()).toBe(404);
    const uploadHeaders = { Origin: baseURL!, "Content-Type": "image/png", "x-hms-profile": patient.subject, "x-hms-document-title": "Unrelated", "x-hms-document-type": "other" };
    expect((await otherPage.request.post("/api/documents", { headers: uploadHeaders, data: png })).status()).toBe(403);
    const publicClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await publicClient.storage.from(DOCUMENT_BUCKET).download(path)).error).not.toBeNull();
    // Also retain a valid issued token to verify the post-deletion actor fence.
    const extraLink = await fx.admin.auth.admin.generateLink({ type: "magiclink", email: patient.email });
    if (extraLink.error) throw new Error("Synthetic token fixture failed.");
    const tokenSession = await publicClient.auth.verifyOtp({ token_hash: extraLink.data.properties.hashed_token, type: "magiclink" });
    if (tokenSession.error || !tokenSession.data.session) throw new Error("Synthetic token session failed.");
    const staleToken = tokenSession.data.session.access_token;
    expect((await publicClient.storage.from(DOCUMENT_BUCKET).download(path)).error).not.toBeNull();
    expect((await publicClient.storage.from(DOCUMENT_BUCKET).upload(patient.subject + "/bypass.png", png, { contentType: "image/png" })).error).not.toBeNull();
    const downloadEvent = page.waitForEvent("download");
    await page.goto("/account"); await page.getByRole("link", { name: "Export all owned profiles", exact: true }).click();
    const download = await downloadEvent, archivePath = testInfo.outputPath("account-export.zip"); await download.saveAs(archivePath);
    expect(await download.failure()).toBeNull();
    const archive = new ZipReader(new BlobReader(new Blob([await readFile(archivePath)])), { useWebWorkers: false });
    try {
      const entries = await archive.getEntries();
      expect(entries.some(entry => entry.filename.includes(other.subject))).toBe(false);
      const metric = entries.find(entry => entry.filename.endsWith("metrics/weight_kg.csv"));
      if (!metric || metric.directory) throw new Error("Metric export missing.");
      const content = await metric.getData(new TextWriter()); expect(content.trim().split("\n")).toHaveLength(4);
      for (const [index, time] of times.entries()) expect(content).toContain(`${time.replace(".000Z", ".000000Z")},weight_kg,${70 + index},kg`);
      const original = entries.find(entry => entry.filename.endsWith("documents/" + path!.split("/")[1]));
      if (!original || original.directory) throw new Error("Original document missing.");
      expect(Buffer.from(await original.getData(new Uint8ArrayWriter()))).toEqual(png);
    } finally { await archive.close(); }
    await page.goto("/account/delete"); await noMobileOverflow(page);
    await page.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await page.getByRole("button", { name: "Permanently delete account", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in\?deleted=1$/);
    await expect(page.getByRole("status").filter({hasText:"deleted from the live service"})).toBeVisible();
    for (const table of ["metrics", "daily_summaries", "documents", "data_sources"]) expect(await fx.db.unsafe("select 1 from public." + table + " where user_id=$1", [patient.subject])).toHaveLength(0);
    expect(await fx.db.unsafe("select 1 from auth.users where id=$1", [patient.id])).toHaveLength(0);
    expect(await fx.db.unsafe("select 1 from storage.objects where bucket_id=$1 and name=$2", [DOCUMENT_BUCKET, path])).toHaveLength(0);
    expect(await fx.db.unsafe("select 1 from public.audit_log where actor_id=$1 or target_user_id=$2", [patient.id, patient.subject])).toHaveLength(0);
    expect(await fx.db.unsafe("select 1 from public.profiles where id=$1", [other.subject])).toHaveLength(1);
    expect((await publicClient.auth.getUser(staleToken)).error).not.toBeNull();
    expect((await publicClient.rpc("hms_list_profiles")).error).not.toBeNull();
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    expect(fx.errors).toEqual([]);
  } catch (error) {
    failures.push(error);
  } finally {
    testInfo.setTimeout(testInfo.timeout + 60000);
    // Stop browser requests, then let Auth deletion serialise behind any upload
    // holding this profile's lock. Purge its exact Storage prefix afterwards,
    // including an upload that completed before the test captured its path.
    for (const close of [() => page.close(), () => otherContext.close(), () => fx.cleanup()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (patientSubject) {
      try {
        let empty = false;
        for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
          const listed = await fx.admin.storage.from(DOCUMENT_BUCKET).list(patientSubject, { limit: 100, offset: 0 });
          if (listed.error) throw new Error("Synthetic document prefix listing failed.", { cause: listed.error });
          if (!listed.data.length) { empty = true; break; }
          const paths = listed.data.map(object => checkedDocumentPath(patientSubject!, patientSubject + "/" + object.name));
          const removed = await fx.admin.storage.from(DOCUMENT_BUCKET).remove(paths);
          if (removed.error) throw new Error("Synthetic document prefix cleanup failed.", { cause: removed.error });
        }
        if (!empty) throw new Error("Synthetic document cleanup exceeded its bounded page limit.");
      } catch (error) { failures.push(error); }
    }
    try {
      const timingPath = testInfo.outputPath("document-request-timings.json");
      await writeFile(timingPath, JSON.stringify([...timings.values()], null, 2));
      await testInfo.attach("document-request-timings", { path: timingPath, contentType: "application/json" });
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Data-rights verification or synthetic cleanup failed.");
  }
});

test("interrupted deletion can resume from its durable fence", async ({ page, baseURL }) => {
  const fx = liveFixtures(baseURL!);
  try {
    const patient = await fx.actor(page, "Sample deletion retry");
    // Simulate a request which committed its fence then died before Storage.
    await fx.db.begin(async tx => {
      await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)", [patient.id]);
      await tx.unsafe("select hms_private.begin_account_deletion(false)");
    });
    await page.goto("/today"); await expect(page).toHaveURL(baseURL + "/account/delete");
    await expect(page.getByRole("status")).toContainText("Data access is frozen");
    expect((await page.request.get("/api/account/export")).status()).toBe(403);
    await page.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await page.getByRole("button", { name: "Retry account deletion", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in\?deleted=1$/);
    expect(await fx.db.unsafe("select 1 from auth.users where id=$1", [patient.id])).toHaveLength(0);
    expect(fx.errors).toEqual([]);
  } finally { await fx.cleanup(); }
});
