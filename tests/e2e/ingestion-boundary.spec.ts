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
});
