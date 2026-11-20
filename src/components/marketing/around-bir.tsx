import { ATTRACTIONS } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Icon } from "@/components/icon";
import { Reveal } from "@/components/motion/reveal";
import { Stagger, StaggerItem } from "@/components/motion/stagger";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";

/**
 * Around Bir — place and context, as a distance-led editorial list rather than a
 * card grid. The attraction photos don't exist on disk, so the section is
 * icon-led: real distances (shown as coordinates in the flight-log voice), names,
 * blurbs and Directions links, all from ATTRACTIONS. Nothing is invented; the
 * unused photo field simply isn't rendered.
 *
 * Server component; motion is the Reveal/Stagger client islands.
 */
export function AroundBir() {
  return (
    <section id="bir" className="border-t hairline bg-forest/40 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <ElevationTag label="Around Bir" />
          <h2 className="mt-4 max-w-2xl font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
            <GradientShimmer>You did not come this far to stay in your room</GradientShimmer>
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
            Hidden waterfalls, the paragliding capital of India and pure adrenaline —
            all within a few kilometres of the door.
          </p>
        </Reveal>

        <Stagger className="mt-12 sm:mt-14">
          {ATTRACTIONS.map((a) => (
            <StaggerItem key={a.slug}>
              <article className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-4 gap-y-3 border-t hairline py-7 sm:grid-cols-[7rem_1fr_auto] sm:items-center sm:gap-8 sm:py-8">
                <span className="font-data text-sm text-amber" aria-hidden>
                  {a.distance}
                </span>
                <div>
                  <div className="flex items-center gap-2.5">
                    <Icon name={a.icon} size={18} className="shrink-0 text-amber/90" />
                    <h3 className="font-display text-xl font-bold text-paper sm:text-2xl">{a.name}</h3>
                    <span className="sr-only">— {a.distance} away</span>
                  </div>
                  <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-sage">{a.blurb}</p>
                </div>
                <a
                  href={a.maps}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="col-span-2 inline-flex w-fit items-center gap-1.5 text-sm text-amber transition-colors hover:text-paper sm:col-span-1"
                >
                  <Icon name="Navigation" size={15} /> Directions
                </a>
              </article>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
