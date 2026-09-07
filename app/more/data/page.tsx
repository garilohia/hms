import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";
import { DataImport } from "./upload";

export default async function DataPage() {
  const session = await authenticatedClient();
  if (!session) redirect("/sign-in");
  const { data, error } = await session.client.rpc("hms_list_profiles");
  if (error) throw new Error("We could not load your profiles.");
  const profiles = z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.enum(["self", "dependent"]), timezone: z.string() })).parse(data);
  return <main className="mx-auto max-w-xl space-y-6 px-5 py-10">
    <Link href="/account" className="underline">Your account</Link>
    <h1 className="text-3xl font-semibold">Devices &amp; data</h1>
    <p>Import an Apple Health ZIP or a CSV. Your archive stays on this device. Only normalised readings are sent to HMS.</p>
    <DataImport profiles={profiles} />
    <p className="text-sm text-slate-600">Fitbit API and aggregator connections: coming soon.</p>
  </main>;
}
