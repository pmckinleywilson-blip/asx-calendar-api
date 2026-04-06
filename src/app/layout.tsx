import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ASX WIRE | Free ASX Events Calendar for AI Agents & Analysts",
  description:
    "Free, machine-readable ASX corporate events calendar sourced from announcements and IR pages. All ASX-listed companies with webcast links, dial-in numbers, and direct calendar invites.",
  keywords:
    "ASX calendar, earnings dates, conference calls, webcast links, AI agents, ASX 200, ASX 300, All Ordinaries, Australian stock exchange",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <div className="max-w-6xl mx-auto w-full px-4 py-3 flex-1 flex flex-col">
          {/* Header */}
          <header className="flex justify-between items-baseline mb-1.5 pb-1.5 border-b-2 border-[#1b1b1b]">
            <a
              href="/"
              className="text-xs font-medium tracking-[2px] text-[#1b1b1b] no-underline"
            >
              ASX WIRE
            </a>
            <nav className="flex items-center gap-4 text-[10px] c-muted">
              <a href="/subscribe" className="hover:text-[#1b1b1b]">
                SUBSCRIBE
              </a>
              <a href="/docs" className="hover:text-[#1b1b1b]">
                API
              </a>
            </nav>
          </header>

          {/* Main */}
          <main className="flex-1">{children}</main>

          {/* Footer */}
          <footer className="mt-1.5 pt-1.5 border-t border-[#ccc] flex justify-between text-[9px] c-muted">
            <span>
              Source: ASX Announcements, Company IR Pages
            </span>
            <nav className="flex gap-3">
              <a href="/docs" className="hover:text-[#1b1b1b]">
                API Docs
              </a>
              <a href="/subscribe" className="hover:text-[#1b1b1b]">
                Subscribe
              </a>
            </nav>
          </footer>
        </div>
      </body>
    </html>
  );
}
