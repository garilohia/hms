import { expect, test } from "@playwright/test";

test("live seeded catalogue has dated prices, mobile filters and honest unknowns", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more/devices");
  await expect(page.getByRole("heading", { name: "Which device?" })).toBeVisible();
  expect(await page.getByRole("article").count()).toBeGreaterThanOrEqual(18);
  const noise = page.getByRole("article", { name: "Noise ColorFit Icon Buzz", exact: true });
  await expect(noise).toContainText("₹1,499.00"); await expect(noise).toContainText("Price verified 8 Sept 2026");
  await page.getByLabel("Budget band").selectOption("entry"); await expect(noise).toBeVisible();
  await expect(page.getByRole("article", { name: "Oura Ring 5 (Black)", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Price currency").selectOption("USD");
  await page.getByLabel("Skin temperature", { exact: true }).check(); await page.getByLabel("SpO₂", { exact: true }).check();
  await page.getByLabel("HRV", { exact: true }).check(); await page.getByLabel("Screen", { exact: true }).selectOption("no");
  await page.getByLabel("Advertised battery life").selectOption("7");
  const oura = page.getByRole("article", { name: "Oura Ring 5 (Black)", exact: true });
  await expect(oura).toBeVisible(); await expect(oura).toContainText("$399.00"); await expect(oura).toContainText("Paid membership");
  await expect(page.getByRole("article", { name: "Samsung Galaxy Ring", exact: true })).toContainText("Check price");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("device-filters-mobile.png"), fullPage: true });
  await page.getByLabel("ECG", { exact: true }).check(); await expect(page.getByRole("status").filter({ hasText: "0 devices match" })).toBeVisible();
  await expect(page.getByText("No devices match all these filters.", { exact: false })).toBeVisible();
});
