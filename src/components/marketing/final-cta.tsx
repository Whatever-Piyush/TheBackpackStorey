import { SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { Reveal } from "@/components/motion/reveal";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";

/**
 * Final CTA — the emphatic close that bookends the hero: the same shimmering
 * headline, an oversized statement, then the booking action. Copy, the
 * BookingButton (→ /book) and the phone link are unchanged.
 */
export function FinalCta() {
  const tel = SITE.phones[0].replace(/[^\d]/g, "");
  return (
    <section className="mx-auto max-w-6xl px-5 py-28 text-center sm:px-8 sm:py-40">
      <Reveal>
        <ElevationTag label="Come up" elevation={SITE.elevation.property} className="mx-auto" />
      </Reveal>
      <h2 className="mx-auto mt-7 max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-paper sm:text-6xl">
        <GradientShimmer>A bed, a bonfire and a valley to wake up to.</GradientShimmer>
      </h2>
      <Reveal delay={220} className="mt-9 flex justify-center">
        <BookingButton>Book a bed</BookingButton>
      </Reveal>
      <Reveal delay={300}>
        <p className="font-data mt-5 text-sm text-sage">
          or call{" "}
          <a href={`tel:${tel}`} className="text-amber hover:text-paper">
            {SITE.phones[0]}
          </a>
        </p>
      </Reveal>
    </section>
  );
}
