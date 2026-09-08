import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";
import { AlertSettings } from "./settings";
import { PushTest } from "./push-test";
export default async function AlertsPage() {
  const session = await authenticatedClient();
  if (!session) redirect("/sign-in");
  const result = await session.client.rpc("hms_list_profiles");
  const profiles = z.array(z.object({ id: z.uuid(), name: z.string() })).safeParse(result.data);
  return <main className="mx-auto max-w-2xl space-y-6 px-5 py-8"><Link href="/account" className="underline">Account</Link><h1 className="text-2xl font-semibold">Alert rules and notifications</h1>
    <p>These are unusual-reading notices, not a medical assessment. The app is not for emergencies.</p>
    {profiles.success ? <AlertSettings profiles={profiles.data} /> : <p>Could not load profiles. Please reload.</p>}<PushTest /></main>;
}
