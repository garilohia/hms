"use client";
import { useState } from "react";
import { z } from "zod";
import { documentTypes, MAX_DOCUMENT_BYTES } from "@/src/lib/data-rights/documents";

export function DocumentUpload({ userId, onUploaded }: { userId: string; onUploaded: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  return <form className="stack" onSubmit={async event => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form), file = values.get("document");
    if (!(file instanceof File) || !file.size || file.size > MAX_DOCUMENT_BYTES) { setStatus("Choose a PDF, JPEG or PNG of at most 3 MiB."); return; }
    setBusy(true); setStatus("");
    try {
      const response = await fetch("/api/documents", { method: "POST", headers: { "Content-Type": file.type,
        "x-hms-profile": userId, "x-hms-document-title": encodeURIComponent(String(values.get("title"))), "x-hms-document-type": String(values.get("type")) }, body: file });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error);
      z.object({ id: z.uuid() }).parse(result); form.reset();
      await onUploaded(); setStatus("Document added.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Document upload did not complete. Try again."); }
    finally { setBusy(false); }
  }}>
    <label className="form-field">Document title<input name="title" required maxLength={120} disabled={busy}/></label>
    <label className="form-field">Document type<select name="type" disabled={busy}>{documentTypes.map(type => <option value={type} key={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
    <label className="form-field">Document file (PDF, JPEG or PNG, up to 3 MiB)<input type="file" name="document" required accept="application/pdf,image/jpeg,image/png" disabled={busy}/></label>
    <button className="button secondary" disabled={busy}>{busy ? "Adding document…" : "Add document"}</button>
    {status && <p role="status">{status}</p>}
  </form>;
}
