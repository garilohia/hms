import { expect, test, type Request } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { liveFixtures, noMobileOverflow } from "./live-fixtures";

test("wearable hub exposes real connection boundaries without fake vendor links", async ({ page, baseURL }, testInfo) => {
  const live = liveFixtures(baseURL!);
  const started = Date.now();
  const timings = new Map<Request, { pathname: string; resource: string; startedAfterMs: number; status?: number; headersAfterMs?: number; completedAfterMs?: number; failedAfterMs?: number }>();
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (timings.size < 200 && (pathname === "/more/data" || pathname.startsWith("/_next/static/"))) {
      timings.set(request, { pathname, resource: request.resourceType(), startedAfterMs: Date.now() - started });
    }
  });
  page.on("response", response => {
    const timing = timings.get(response.request());
    if (timing) { timing.status = response.status(); timing.headersAfterMs = Date.now() - started - timing.startedAfterMs; }
  });
  page.on("requestfinished", request => {
    const timing = timings.get(request);
    if (timing) timing.completedAfterMs = Date.now() - started - timing.startedAfterMs;
  });
  page.on("requestfailed", request => {
    const timing = timings.get(request);
    if (timing) timing.failedAfterMs = Date.now() - started - timing.startedAfterMs;
  });
  try {
    const actor = await live.actor(page, "Wearable Test");
    await page.goto(`/more/data?profile=${actor.subject}`);
    await expect(page.getByRole("heading", { name: "Link a wearable" })).toBeVisible();
    for (const name of ["Google Health ecosystem", "WHOOP", "Apple Health ecosystem", "Android Health Connect ecosystem", "Smart scales & body composition", "Garmin Health", "Oura", "Withings", "Clinical sensors", "Fitness & training platforms"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Fitbit Air, Fitbit, Pixel Watch", { exact: false })).toBeVisible();
    await expect(page.getByText("Setup required", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Partner access required", { exact: true })).toHaveCount(4);
    await expect(page.getByRole("link", { name: "Import health data" })).toHaveCount(4);
    await noMobileOverflow(page);
    expect(live.errors).toEqual([]);
  } finally {
    try { await live.cleanup(); }
    finally {
      const timingPath = testInfo.outputPath("wearable-navigation-timings.json");
      await writeFile(timingPath, JSON.stringify([...timings.values()], null, 2));
      await testInfo.attach("wearable-navigation-timings", { path: timingPath, contentType: "application/json" });
    }
  }
});
