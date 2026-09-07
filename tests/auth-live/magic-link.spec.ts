import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, test } from "@playwright/test";

test("real Supabase magic-link session, guardian consent, and sign-out", async ({ page, baseURL }) => {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret=process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret || !process.env.DATABASE_URL) throw new Error("Live Supabase verification requires the project's keys and DATABASE_URL.");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false});
  let actor: string | undefined;
  const subjectIds: string[]=[];
  try {
    // Generates a one-time link without emailing anyone.
    const {data: link,error}=await admin.auth.admin.generateLink({
      type:"magiclink", email:"hms-auth-" + randomUUID() + "@example.com",
      options:{data:{dob:"1990-01-01",name:"Sample guardian"}},
    });
    if (error) throw new Error("Supabase could not generate the test link: " + error.code);
    actor=link.user.id;
    await page.goto("/auth/confirm?token_hash=" + encodeURIComponent(link.properties.hashed_token));
    await expect(page).toHaveURL(baseURL + "/account");
    await expect(page.getByText("Sample guardian", {exact:true})).toBeVisible();
    const response=await page.request.post("/api/profiles/dependents",{
      headers:{Origin:baseURL!},
      data:{name:"Sample dependent",dob:"2015-01-01",consent:true},
    });
    expect(response.status()).toBe(201);
    const result: {id:string}=await response.json();
    subjectIds.push(result.id);
    await page.reload();
    await expect(page.getByText("Sample dependent", {exact:false})).toBeVisible();
    const rows=await db.unsafe("select id from public.profiles where owner_account_id=$1",[actor]);
    subjectIds.push(...rows.map(row => row.id as string));
    const [consent]=await db.unsafe("select authority,granted_by from public.consents where user_id=$1",[result.id]);
    expect(consent.authority).toBe("guardian");
    expect(consent.granted_by).toBe(actor);
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await expect(page).toHaveURL(baseURL + "/sign-in");
    await page.goto("/account");
    await expect(page).toHaveURL(baseURL + "/sign-in");
  } finally {
    if (actor) {
      const {error}=await admin.auth.admin.deleteUser(actor);
      if(error) throw new Error("Test account cleanup failed: " + error.code);
      await db.unsafe("delete from public.audit_log where actor_id=$1 or target_user_id=any($2::uuid[])",[actor,subjectIds]);
    }
    await db.end();
  }
});
