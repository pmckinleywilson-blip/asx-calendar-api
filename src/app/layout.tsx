import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ASX Calendar API — Corporate Events Calendar",
  description:
    "Browse upcoming earnings dates, AGMs, ex-dividend dates, and other corporate events for all ASX-listed companies. Filter by ASX index, GICS sector, industry, and event type. API-first, built for agents and humans.",
  keywords: [
    "ASX",
    "Australian Securities Exchange",
    "earnings calendar",
    "corporate events",
    "AGM",
    "ex-dividend",
    "ASX 200",
    "ASX 300",
    "All Ords",
    "GICS",
    "API",
  ],
  openGraph: {
    title: "ASX Calendar API",
    description:
      "Corporate events calendar for all ASX-listed companies. Earnings, AGMs, dividends & more.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
