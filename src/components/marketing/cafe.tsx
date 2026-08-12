import Image from "next/image";
import { CAFE, PHOTOS } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Marquee } from "@/components/marquee";
import { Parallax } from "@/components/motion/parallax";
import { Reveal } from "@/components/motion/reveal";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";

/**
 * Café — a large atmospheric feature image paired with editorial copy, then the
 * existing auto-scrolling photo strip below. The image drifts on a subtle
 * parallax (decorative only); the copy reveals in. Highlights come straight from
 * CAFE.highlights — no invented menu items or prices.
 */
export function Cafe() {
  return (
    <section id="cafe" className="py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="grid items-center gap-10 md:grid-cols-2 md:gap-14">
          {/* Static frame; the image drifts within it (clipped) on scroll. */}
          <div className="relative aspect-[5/6] overflow-hidden rounded-card border hairline sm:aspect-[4/5]">
            <Parallax distance={28} className="absolute inset-x-0 -inset-y-[9%]">
              <Image
                src={PHOTOS.rooftopDusk.src}
                alt={PHOTOS.rooftopDusk.alt}
                fill
                sizes="(min-width:768px) 48vw, 92vw"
                className="object-cover"
              />
            </Parallax>
          </div>

          <div>
            <Reveal>
              <ElevationTag label="Rooftop café" />
              <h2 className="mt-5 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
                <GradientShimmer>{CAFE.name}</GradientShimmer>
              </h2>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-sage sm:text-lg">{CAFE.blurb}</p>
            </Reveal>
            <Reveal delay={140}>
              <ul className="mt-7 flex flex-wrap gap-2.5">
                {CAFE.highlights.map((h) => (
                  <li key={h} className="capsule rounded-full border hairline px-4 py-1.5 text-sm text-paper">
                    {h}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </div>

      {/* auto-scrolling image strip below (existing) */}
      <div className="mt-16 sm:mt-24">
        <Marquee photos={CAFE.photos} />
      </div>
    </section>
  );
}
