import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";
import { DeleteAccount } from "./confirmation";

export default async function DeleteAccountPage() {
  const session = await authenticatedClient(); if (!session) redirect("/sign-in");
  const { data, error } = await session.client.rpc("hms_account_deletion_status");
  if (error) throw new Error("Could not check account deletion status.");
  const status = z.object({ pending: z.boolean(), stage: z.string().nullable(), profile_count: z.number() }).parse(data);
  return <main className="mx-auto w-full max-w-lg p-6 py-12 stack"><h1 className="page-title">Delete your account</h1>
    <p>This permanently removes your health profiles, readings, uploaded documents, summaries and sharing links from the live service, then deletes your sign-in account.</p>
    <p>Dependent profiles you still own will also be deleted. This cannot be undone. Export anything you need first.</p>
    <p className="muted">If you are a doctor, other patients keep their consultation history without your account identifier. Provider backups follow their separate retention periods; this is not an immediate backup purge.</p>
    {status.pending ? <p role="status">Deletion is pending ({status.stage?.replaceAll("_", " ")}). Data access is frozen. Retry below to finish.</p> : <a className="button secondary" href="/api/account/export">Export all owned profiles</a>}
    <DeleteAccount pending={status.pending}/>
    {!status.pending && <a className="underline" href="/account">Keep my account</a>}
  </main>;
}
