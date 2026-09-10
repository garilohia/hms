import { expect, test } from "@playwright/test";
import { liveFixtures, noMobileOverflow } from "./live-fixtures";

test("wearable hub exposes real connection boundaries without fake vendor links", async ({ page, baseURL }) => {
  const live = liveFixtures(baseURL!);
  try {
    const actor = await live.actor(page, "Wearable Test");
    await page.goto(`/more/data?profile=${actor.subject}`);
    await expect(page.getByRole("heading", { name: "Link a wearable" })).toBeVisible();
    for (const name of ["Google Health", "WHOOP", "Apple Watch", "Garmin", "Other wearables"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Fitbit Air, Fitbit, Pixel Watch", { exact: false })).toBeVisible();
    await expect(page.getByText("Setup required", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Partner access required", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Import health data" })).toHaveCount(2);
    await noMobileOverflow(page);
    expect(live.errors).toEqual([]);
  } finally { await live.cleanup(); }
});
