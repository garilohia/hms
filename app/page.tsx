import Link from "next/link";
import { redirect } from "next/navigation";
import { authenticatedClient } from "@/src/lib/auth/server";
export default async function Home() {
  if(await authenticatedClient()) redirect("/today");
  return (
    <main className="onboarding stack py-24">
      <h1 className="app-brand">HMS</h1>
      <p className="page-title">Your health history, together.</p>
      <p>See your wearable trends. Keep a lasting history. Share it with your doctor when you choose.</p>
      <Link className="button" href="/sign-in">Sign in or create an account</Link>
      <p className="muted">Not a medical device. Not for emergencies.</p>
    </main>
  );
}
