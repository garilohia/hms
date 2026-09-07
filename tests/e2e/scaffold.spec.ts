import { expect, test } from "@playwright/test";

test("the scaffold opens without a demo database query", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "HMS", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
