import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";

const profileList = z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.enum(["self", "dependent"]) }));
export default async function AccountPage() {
  const session = await authenticatedClient();
  if (!session) redirect("/sign-in");
  const deletion = await session.client.rpc("hms_account_deletion_status");
  if (!deletion.error && z.object({ pending: z.boolean() }).parse(deletion.data).pending) redirect("/account/delete");
  const { data, error } = await session.client.rpc("hms_list_profiles");
  if (error) throw new Error("We could not load your profiles.");
  const profiles = profileList.parse(data);
  return <main className="onboarding stack">
    <h1 className="page-title">Your account</h1>
    <Link href="/today" className="button">Open Today</Link>
    <Link href="/more/data" className="block underline">Devices &amp; data</Link>
    <Link href="/more/alerts" className="block underline">Alert rules and notifications</Link>
    <a href="/api/account/export" className="block underline">Export all owned profiles</a>
    <Link href="/account/delete" className="block underline">Delete account</Link>
    <ul className="stack">{profiles.map(p => <li key={p.id} className="card">{p.name}{p.kind === "dependent" && <span className="ml-2 text-sm">Dependent</span>}</li>)}</ul>
    <form method="post" action="/api/auth/sign-out"><button className="button secondary">Sign out</button></form>
  </main>;
}
