import Image from "next/image";
import { PHOTOS, SITE } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Reveal } from "@/components/motion/reveal";

/**
 * Intro — the editorial transition from the hero into the property story.
 * Asymmetric 7/5 composition: a strong typographic statement and copy on the
 * left, an offset image pair on the right. Content is unchanged; motion is a
 * restrained staged reveal (heading → copy → chips) plus a single image reveal.
 */
export function Intro() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
      <div className="grid gap-12 md:grid-cols-12 md:gap-12">
        <div className="md:col-span-7">
          <Reveal>
            <ElevationTag label="The property" elevation={SITE.elevation.property} />
            <h2 className="mt-6 max-w-2xl font-display text-4xl font-extrabold leading-[1.03] tracking-tight text-paper sm:text-5xl">
              Tiny on purpose. Big on the part that matters.
            </h2>
          </Reveal>
          <Reveal delay={140} className="mt-6 max-w-xl space-y-5 text-base leading-relaxed text-sage sm:text-lg">
            <p>
              Bir is a Tibetan settlement in the Kangra valley and the paragliding
              capital of India. We sit right in it — pine forest at the back,
              monasteries down the road, and the launch at Billing a short drive up.
            </p>
            <p>
              The place is intentionally small: one six-bed dorm and a few private
              rooms, all wrapped around a rooftop café. You will know the other
              guests by their first names before you leave.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <ul className="mt-8 flex flex-wrap gap-2.5">
              {["6-bed dorm", "A few private rooms", "Rooftop café"].map((t) => (
                <li key={t} className="capsule rounded-full border hairline px-4 py-1.5 text-sm text-paper">
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <div className="md:col-span-5">
          <Reveal delay={120} className="grid grid-cols-2 gap-3 sm:gap-4">
            <div className="group relative aspect-[4/5] overflow-hidden rounded-card border hairline">
              <Image
                src={PHOTOS.exterior.src}
                alt={PHOTOS.exterior.alt}
                fill
                sizes="(min-width:768px) 22vw, 45vw"
                className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              />
            </div>
            <div className="group relative mt-10 aspect-[4/5] overflow-hidden rounded-card border hairline">
              <Image
                src={PHOTOS.sign.src}
                alt={PHOTOS.sign.alt}
                fill
                sizes="(min-width:768px) 22vw, 45vw"
                className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
