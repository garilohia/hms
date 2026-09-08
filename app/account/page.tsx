import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";

const profileList = z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.enum(["self", "dependent"]) }));
export default async function AccountPage() {
  const session = await authenticatedClient();
  if (!session) redirect("/sign-in");
  const { data, error } = await session.client.rpc("hms_list_profiles");
  if (error) throw new Error("We could not load your profiles.");
  const profiles = profileList.parse(data);
  return <main className="mx-auto w-full max-w-lg space-y-6 p-6 py-16">
    <h1 className="text-3xl font-semibold">Your account</h1>
    <Link href="/today" className="button">Open Today</Link>
    <Link href="/more/data" className="block underline">Devices &amp; data</Link>
    <Link href="/more/alerts" className="block underline">Alert rules and notifications</Link>
    <ul className="space-y-3">{profiles.map(p => <li key={p.id} className="rounded-lg border p-4">{p.name}{p.kind === "dependent" && <span className="ml-2 text-sm">Dependent</span>}</li>)}</ul>
    <form method="post" action="/api/auth/sign-out"><button className="rounded-lg border px-4 py-2">Sign out</button></form>
  </main>;
}
