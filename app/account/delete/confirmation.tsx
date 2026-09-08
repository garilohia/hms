"use client";
import { useState } from "react";
import { z } from "zod";

export function DeleteAccount({ pending }: { pending: boolean }) {
  const [confirmation, setConfirmation] = useState(""), [dependents, setDependents] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form className="card stack" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation, confirmDependents: dependents }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error);
      z.object({ deleted: z.literal(true) }).parse(result);
      window.location.replace("/sign-in?deleted=1");
    } catch (error) { setError(error instanceof Error ? error.message : "Deletion did not finish. Retry here."); }
    finally { setBusy(false); }
  }}>
    <label className="form-field">Type DELETE to confirm<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" required pattern="DELETE" disabled={busy}/></label>
    <label className="check-label"><input type="checkbox" checked={dependents} onChange={event => setDependents(event.target.checked)} disabled={busy}/><span>I also confirm permanent deletion of every dependent profile I still own.</span></label>
    <button className="button" disabled={busy || confirmation !== "DELETE"}>{busy ? "Deleting. Keep this page open…" : pending ? "Retry account deletion" : "Permanently delete account"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
