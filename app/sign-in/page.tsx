import { SignInForm } from "./form";
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; deleted?: string }> }) {
  const params = await searchParams;
  return <main className="onboarding stack">
    <p className="app-brand">HMS</p>
    <h1 className="page-title">Your health history, together.</h1>
    {params.deleted === "1" && <p role="status">Your account and owned health data have been deleted from the live service.</p>}
    {params.error && <p role="alert">That link could not be used. Request a new sign-in link.</p>}
    <SignInForm showTestLogin={process.env.NODE_ENV === "development"} />
  </main>;
}
