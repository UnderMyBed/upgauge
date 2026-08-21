import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { BASE_URL } from "@/lib/siteUrl";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  // Every `opengraph-image` route emits a RELATIVE url (`/route/JFK-LAX/opengraph-image`), and
  // og:image must be absolute for a crawler to fetch it. Without this Next resolves that
  // relative url against `http://localhost:3000` and ships a card URL nobody outside this box
  // can reach. `BASE_URL` and not a literal host: a fork, a staging deploy or a `docker run`
  // against another domain must emit its own (lib/siteUrl.ts, and CLAUDE.md's portability rule).
  metadataBase: new URL(BASE_URL),
  title: "Upgauge",
  description: "A structural intelligence layer over US DOT / BTS airline data.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
