import Image from "next/image";
import Link from "next/link";
import { LogIn, LogOut, MapPin, Mountain } from "lucide-react";
import { PHOTOS, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { Parallax } from "@/components/motion/parallax";
import { Reveal } from "@/components/motion/reveal";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";
import { PhotoStack } from "@/components/marketing/photo-stack";

const STATS = [
  { Icon: LogIn, k: "Check-in", v: SITE.checkIn },
  { Icon: LogOut, k: "Check-out", v: SITE.checkOut },
  { Icon: Mountain, k: "Elevation", v: `${SITE.elevation.property.toLocaleString("en-IN")} m` },
  { Icon: MapPin, k: "Coordinates", v: `${SITE.coords.lat.toFixed(4)}°N · ${SITE.coords.lng.toFixed(4)}°E` },
];

/**
 * Homepage hero. Server component; the motion lives in small client islands
 * (Parallax backdrop, WordReveal headline, staged Reveal entrances) so the page
 * stays server-first. One cohesive top-down entrance on load + a subtle scroll
 * parallax on the backdrop — cinematic, not busy. All motion is reduced-motion
 * safe, and the section clips its own overflow so nothing scrolls sideways.
 */
export function Hero() {
  return (
    <section className="relative isolate flex min-h-[90dvh] flex-col justify-end overflow-hidden">
      {/* Decorative backdrop with a subtle scroll parallax. Oversized vertically
          so the drift never exposes an edge; the section's overflow-hidden clips
          it, and the Y-only transform can't cause horizontal overflow. */}
      <Parallax distance={40} className="pointer-events-none absolute inset-x-0 -inset-y-[10%]">
        <Image
          src={PHOTOS.heroCafe.src}
          alt={PHOTOS.heroCafe.alt}
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
      </Parallax>
      <div className="absolute inset-0 bg-gradient-to-t from-pine via-pine/70 to-pine/30" />

      {/* The property polaroids, re-attached to the hero: a tilted, overlapping
          stack on the right that spreads on hover. Desktop-only so it never
          crowds the headline; it sits over the café image without covering the
          left-aligned copy. */}
      <div className="absolute right-6 top-1/2 z-20 hidden w-[24rem] -translate-y-1/2 lg:block xl:right-16">
        <PhotoStack
          items={[
            { ...PHOTOS.exterior, caption: "Out front, at dusk", rotation: -8, offset: { x: -56, y: -8 } },
            { ...PHOTOS.sign, caption: "Painted by hand", rotation: 9, offset: { x: 56, y: 14 } },
          ]}
        />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-5 pb-14 pt-36 sm:px-8">
        <Reveal>
          <ElevationTag
            label="Bir · Billing"
            elevation={SITE.elevation.launch}
            size="lg"
            className="border-paper/25 bg-pine/55 text-paper shadow-lg backdrop-blur-md"
          />
        </Reveal>
        <h1 className="mt-6 max-w-3xl font-display text-5xl font-extrabold leading-[0.95] tracking-tight text-paper sm:text-7xl">
          <GradientShimmer>Sleep where the sky launches.</GradientShimmer>
        </h1>
        <Reveal delay={320}>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-sage">
            A small backpacker hostel and rooftop café in Bir — two dorms, four
            private rooms, and a valley view under the world&apos;s
            second-highest paragliding launch.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <BookingButton>Book a bed</BookingButton>
            <Link
              href="/rooms"
              className="inline-flex items-center gap-1.5 rounded-full border border-paper/30 px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-amber hover:text-amber"
            >
              See the rooms
            </Link>
          </div>
        </Reveal>
      </div>

      <Reveal delay={460} className="relative border-t hairline bg-pine/50 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2.5 px-5 py-4 sm:gap-3 sm:px-8">
          {STATS.map((c) => (
            <span
              key={c.k}
              className="inline-flex items-center gap-2.5 rounded-full border hairline bg-pine/40 px-4 py-2 transition-colors hover:border-amber/50"
            >
              <c.Icon size={16} strokeWidth={1.8} className="text-amber" aria-hidden />
              <span className="font-data text-[0.7rem] uppercase tracking-[0.14em] text-sage">{c.k}</span>
              <span className="font-data text-sm text-paper">{c.v}</span>
            </span>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
