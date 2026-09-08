"use client";
import Link from "next/link";
export default function ErrorPage({reset}:{reset:()=>void}) {
  return <main className="onboarding stack"><h1 className="page-title">This page could not load.</h1><p>Check your connection and try again. Your saved readings remain in your account.</p><button className="button" onClick={reset}>Try again</button><Link className="underline" href="/today">Back to Today</Link></main>;
}
