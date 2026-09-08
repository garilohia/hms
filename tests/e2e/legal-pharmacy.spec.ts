import { expect, test } from "@playwright/test";

test("public legal notices are complete, cross-linked and mobile-readable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, heading] of [["privacy", "Privacy notice"], ["terms", "Terms of use"], ["disclaimer", "Health disclaimer"]]) {
    const response = await page.goto("/legal/" + path); expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Legal pages" }).getByRole("link")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: testInfo.outputPath(path + "-mobile.png"), fullPage: true });
  }
  await page.goto("/legal/privacy");
  await expect(page.getByText("Grievance officer / privacy contact:", { exact: false })).toContainText("not yet appointed");
  await expect(page.getByText("Live history is currently retained", { exact: false })).toContainText("approved retention schedule before launch");
});

test("pharmacy only prepares explicit external search links without querying a partner", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const external: string[] = [];
  page.on("request", request => { if (/1mg\.com|apollopharmacy\.in/.test(request.url())) external.push(request.url()); });
  await page.goto("/more/pharmacy"); await page.getByLabel("Product search").fill("bandage & gauze");
  await page.getByRole("button", { name: "Prepare pharmacy links", exact: true }).click();
  const tata = page.getByRole("link", { name: "Search on Tata 1mg", exact: true }), apollo = page.getByRole("link", { name: "Open Apollo search", exact: true });
  await expect(tata).toHaveAttribute("href", "https://www.1mg.com/search/all?name=bandage+%26+gauze");
  await expect(apollo).toHaveAttribute("href", "https://www.apollopharmacy.in/search-medicines");
  await expect(tata).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(page.getByText("The link does not prefill your query.", { exact: false })).toBeVisible();
  expect(external).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("pharmacy-mobile.png"), fullPage: true });
  await page.getByLabel("Product search").fill("updated"); await expect(tata).toHaveCount(0);
});
