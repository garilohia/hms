import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RegisterWorker } from "./ui/register-worker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "HMS · Your health history", template: "%s · HMS" },
  description: "Your wearable history, understandable trends and a connection to your doctor.",
  applicationName: "HMS",
  appleWebApp: { capable: true, title: "HMS", statusBarStyle: "default" },
  icons: { icon: "/app-icon/192", apple: "/app-icon/192" },
};
export const viewport: Viewport = { themeColor: "#132f47" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><RegisterWorker />{children}</body>
    </html>
  );
}
