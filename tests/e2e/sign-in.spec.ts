import { expect, test } from "@playwright/test";
test("signed-out users must sign in to view profiles", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("button",{name:"Continue as test user"})).toHaveCount(0);
});
test("production does not expose the local test-login endpoint",async({request,baseURL})=>{
  const response=await request.post("/api/auth/test-login",{headers:{Origin:baseURL!},data:{}});
  expect(response.status()).toBe(404);
});
test("minor self-signup is rejected by the server before sending an email", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Account", { exact: true }).selectOption("signup");
  await page.getByLabel("Email", { exact: true }).fill("hms-minor-test@example.com");
  await page.getByLabel("Name", { exact: true }).fill("Sample child");
  await page.getByLabel("Date of birth").fill("2015-01-01");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("guardian");
});
