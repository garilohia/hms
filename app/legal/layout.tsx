import type { ReactNode } from "react";
import Link from "next/link";
export default function LegalLayout({ children }: { children: ReactNode }) {
  return <><nav aria-label="Legal pages" className="onboarding flex flex-wrap gap-5 text-sm"><Link href="/more">More</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/disclaimer">Health disclaimer</Link></nav>{children}</>;
}
