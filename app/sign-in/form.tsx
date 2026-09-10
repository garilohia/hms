"use client";
import { useState, type FormEvent } from "react";
export function SignInForm({showTestLogin=false}:{showTestLogin?:boolean}) {
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
  async function testLogin() {
    setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/auth/test-login",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      const result:{next?:string;error?:string}=await response.json();
      if(!response.ok||!result.next)throw new Error(result.error||"Test login failed.");
      window.location.assign(result.next);
    } catch(error) { setMessage(error instanceof Error?error.message:"Test login failed.");setBusy(false); }
  }
  return <form onSubmit={submit} className="stack">
    <label className="block">Account
      <select aria-label="Account" value={mode} onChange={e => setMode(e.target.value as "signin" | "signup")} className="mt-2 w-full">
        <option value="signin">Sign in</option><option value="signup">Create an adult account</option>
      </select>
    </label>
    <label className="block">Email<input name="email" type="email" autoComplete="email" required className="mt-2 w-full" /></label>
    {mode === "signup" && <>
      <label className="block">Name<input name="name" autoComplete="name" maxLength={120} required className="mt-2 w-full" /></label>
      <label className="block">Date of birth<input name="dob" type="date" required className="mt-2 w-full" /></label>
      <p className="muted">Under 18? Your guardian creates a dependent profile from their account.</p>
    </>}
    <button disabled={busy} className="button w-full">{busy ? "Sending…" : "Email me a sign-in link"}</button>
    {showTestLogin&&<div className="stack border-t border-rule pt-5"><button type="button" disabled={busy} onClick={()=>void testLogin()} className="button secondary w-full">{busy?"Opening test account…":"Continue as test user"}</button><p className="muted">Local development only. Creates a real Supabase session without sending email.</p></div>}
    <p role="status" aria-live="polite">{message}</p>
  </form>;
}
