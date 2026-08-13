import { PHOTOS, SITE } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Reveal } from "@/components/motion/reveal";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";
import { PhotoStack } from "@/components/marketing/photo-stack";

/**
 * Intro — the editorial transition from the hero into the property story.
 * Asymmetric 7/5 composition: a strong typographic statement and copy on the
 * left, a tilted "polaroid" photo stack on the right. Content is unchanged;
 * motion is a restrained staged reveal (heading → copy → chips) plus the stack's
 * own hover/entrance.
 */
export function Intro() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
      <div className="grid gap-12 md:grid-cols-12 md:gap-12">
        <div className="md:col-span-7">
          <Reveal>
            <ElevationTag label="The property" elevation={SITE.elevation.property} />
            <h2 className="mt-6 max-w-2xl font-display text-3xl font-extrabold leading-tight tracking-tight text-paper sm:text-4xl">
              <GradientShimmer>Tiny on purpose. Big on the part that matters.</GradientShimmer>
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

        <div className="flex items-center md:col-span-5">
          <PhotoStack
            items={[
              { ...PHOTOS.exterior, caption: "Out front, at dusk", rotation: -8, offset: { x: -58, y: -6 } },
              { ...PHOTOS.sign, caption: "Painted by hand", rotation: 9, offset: { x: 58, y: 16 } },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
