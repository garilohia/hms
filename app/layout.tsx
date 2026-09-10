import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { colourTokens } from "@/src/lib/design/tokens";
import { RegisterWorker } from "./ui/register-worker";

// DESIGN.md §4.6. next/font downloads at build time and serves the files from this origin; no browser request reaches Google.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
  display: "swap",
  fallback: ["Georgia", "serif"],
});

export const metadata: Metadata = {
  title: { default: "HMS · Your health history", template: "%s · HMS" },
  description: "Your wearable history, understandable trends and a connection to your doctor.",
  applicationName: "HMS",
  appleWebApp: { capable: true, title: "HMS", statusBarStyle: "default" },
  icons: { icon: "/app-icon/192", apple: "/app-icon/192" },
};
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: colourTokens.light.groundTop },
    { media: "(prefers-color-scheme: dark)", color: colourTokens.dark.groundTop },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><RegisterWorker />{children}<Analytics /></body>
    </html>
  );
}
