import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Space_Mono, Zeyada } from "next/font/google";
import "./globals.css";
import { PHOTOS, SITE } from "@/lib/site";

// §2 type system: display / body / mono
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-bricolage",
  display: "swap",
});

const body = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-instrument",
  display: "swap",
});

const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

// Handwritten accent — for photo-stack captions (the polaroid "note" look).
const hand = Zeyada({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-zeyada",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s · ${SITE.name}`,
  },
  description: SITE.description,
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    locale: "en_IN",
    // Link previews (WhatsApp, Instagram DMs, search): the property's own photo,
    // cropped to 1200×630 at public/og.jpg.
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: PHOTOS.heroCafe.alt }],
  },
  twitter: { card: "summary_large_image", images: ["/og.jpg"] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} ${hand.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-pine text-paper">{children}</body>
    </html>
  );
}
