import { EXPERIENCES } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Icon } from "@/components/icon";
import { Reveal } from "@/components/motion/reveal";
import { Stagger, StaggerItem } from "@/components/motion/stagger";

/**
 * Experiences — an editorial, numbered list rather than a card grid. The data
 * (site.ts EXPERIENCES) is title + icon + body only: no imagery, distances,
 * timings or prices, so none are shown or invented. Mono index numbers echo the
 * flight-log motif; hairline rules and whitespace carry the composition.
 *
 * Server component; motion is confined to the Reveal/Stagger client islands.
 */
export function Experiences() {
  return (
    <section className="border-t hairline py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <ElevationTag label="Experiences" />
          <h2 className="mt-4 max-w-2xl font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
            Fly, wander, gather
          </h2>
        </Reveal>

        <Stagger className="mt-12 sm:mt-16">
          {EXPERIENCES.map((exp, i) => (
            <StaggerItem key={exp.title}>
              <article className="grid gap-4 border-t hairline py-8 sm:grid-cols-[4rem_1fr] sm:gap-10 sm:py-12">
                <span className="font-data text-sm text-amber" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="flex items-center gap-3">
                    <Icon name={exp.icon} size={22} className="shrink-0 text-amber" />
                    <h3 className="font-display text-2xl font-bold leading-tight text-paper sm:text-3xl">
                      {exp.title}
                    </h3>
                  </div>
                  <p className="mt-3 max-w-2xl text-base leading-relaxed text-sage sm:text-lg">
                    {exp.body}
                  </p>
                </div>
              </article>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
