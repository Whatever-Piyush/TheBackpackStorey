import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ROOMS } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";
import { RoomsFan } from "@/components/marketing/rooms-fan";

export function RoomsShowcase() {
  return (
    <section id="stay" className="border-t hairline bg-forest/40 py-20 sm:py-24">
      {/* Header stays in the reading column; the journey below is full-bleed. */}
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <ElevationTag label="Stay" />
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
              <GradientShimmer>A bed for every kind of traveller</GradientShimmer>
            </h2>
          </div>
          <Link href="/rooms" className="inline-flex items-center gap-1.5 text-sm text-amber hover:text-paper">
            All rooms <ArrowUpRight size={16} aria-hidden />
          </Link>
        </div>
        <p className="font-data mt-4 text-xs text-sage/70">
          Live rates and availability open on the booking page.
        </p>
      </div>

      {/* Signature interaction: a fanned deck of room cards you cycle through
          (arrows / swipe / ← →); native scroll-snap under reduced motion. */}
      <RoomsFan rooms={ROOMS} />
    </section>
  );
}
