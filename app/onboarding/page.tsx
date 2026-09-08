import { redirect } from "next/navigation";
import Link from "next/link";
import { ownedProfiles } from "@/src/lib/patient/server";
import { Onboarding } from "./steps";
export default async function OnboardingPage() {
  const {profiles}=await ownedProfiles();
  const profile=profiles.find(p=>p.kind==="self");
  if(!profile) redirect("/account");
  if(profile.onboarding_completed_at) redirect("/today");
  return <main className="onboarding stack"><Link href="/" className="app-brand">HMS</Link><Onboarding initial={profile} emailEnabled={Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM)}/></main>;
}
