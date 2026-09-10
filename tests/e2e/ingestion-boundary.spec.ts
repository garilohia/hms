import { expect, test } from "@playwright/test";

test("import page requires a session and CSV template is downloadable", async ({ page, request }) => {
  await page.goto("/more/data");
  await expect(page).toHaveURL(/\/sign-in$/);
  const template = await request.get("/api/ingestion/template");
  expect(template.status()).toBe(200);
  expect(template.headers()["content-disposition"]).toContain("hms-template.csv");
  expect((await template.text()).trim().split("\n")).toHaveLength(4);
});
test("ingestion rejects unauthenticated and cross-origin writes", async ({ request, baseURL }) => {
  for (const path of ["/api/ingestion/sources", "/api/ingestion/batches", "/api/consents"]) {
    const crossOrigin = await request.post(path, { headers: { Origin: "https://untrusted.invalid" }, data: {} });
    expect(crossOrigin.status()).toBe(403);
    const unsigned = await request.post(path, { headers: { Origin: baseURL! }, data: {} });
    expect(unsigned.status()).toBe(401);
  }
  const connect = await request.get("/api/integrations/google_health/connect?profile=00000000-0000-4000-8000-000000000000", { maxRedirects: 0 });
  expect(connect.status()).toBe(302);
  expect(connect.headers().location).toContain("/sign-in");
  const crossOriginDisconnect = await request.delete("/api/integrations/whoop", { headers: { Origin: "https://untrusted.invalid" }, data: {} });
  expect(crossOriginDisconnect.status()).toBe(403);
  const unsignedDisconnect = await request.delete("/api/integrations/whoop", { headers: { Origin: baseURL! }, data: {} });
  expect(unsignedDisconnect.status()).toBe(401);
  const unsignedSync = await request.post("/api/integrations/google_health/sync", { headers: { Origin: baseURL! }, data: {} });
  expect(unsignedSync.status()).toBe(401);
});
