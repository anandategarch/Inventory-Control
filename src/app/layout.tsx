import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { QueryProvider } from "@/components/providers";
import { GlobalLoadingBar } from "@/components/ui/global-loading-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Inventory Control Intelligence",
  description: "Inventory Control Intelligence Platform for 19 F&B outlets — reconciliation, anomaly detection, investigation worklist, and AI narrative.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground [font-feature-settings:'cv11','ss01'] selection:bg-amber-200/70 selection:text-amber-950 dark:selection:bg-amber-500/30 dark:selection:text-amber-50`}
      >
        {/* DU-03: Skip-to-content link for keyboard/screen reader users (WCAG 2.4.1) */}
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-amber-600 focus:text-white focus:rounded-lg focus:shadow-lg focus:text-sm focus:font-medium">
          Lewati ke konten utama
        </a>
        <QueryProvider>
          <GlobalLoadingBar />
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
