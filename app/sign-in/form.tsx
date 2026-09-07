"use client";
import { useState, type FormEvent } from "react";
export function SignInForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/auth/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, mode }) });
      const result: { message?: string; error?: string } = await response.json();
      setMessage(result.message || result.error || "Please try again.");
    } catch { setMessage("Check your connection and try again."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-5">
    <label className="block">Account
      <select aria-label="Account" value={mode} onChange={e => setMode(e.target.value as "signin" | "signup")} className="mt-2 w-full rounded-lg border p-3">
        <option value="signin">Sign in</option><option value="signup">Create an adult account</option>
      </select>
    </label>
    <label className="block">Email<input name="email" type="email" autoComplete="email" required className="mt-2 w-full rounded-lg border p-3" /></label>
    {mode === "signup" && <>
      <label className="block">Name<input name="name" autoComplete="name" maxLength={120} required className="mt-2 w-full rounded-lg border p-3" /></label>
      <label className="block">Date of birth<input name="dob" type="date" required className="mt-2 w-full rounded-lg border p-3" /></label>
      <p className="text-sm text-zinc-600">Under 18? Your guardian creates a dependent profile from their account.</p>
    </>}
    <button disabled={busy} className="w-full rounded-lg bg-teal-800 p-3 font-medium text-white disabled:opacity-60">{busy ? "Sending…" : "Email me a sign-in link"}</button>
    <p role="status" aria-live="polite">{message}</p>
  </form>;
}
