import { AMENITIES } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Icon } from "@/components/icon";
import { Reveal } from "@/components/motion/reveal";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";

/**
 * Amenities — a calm editorial spec-grid, not an animated icon wall. Each real
 * amenity (site.ts AMENITIES) is a hairline-ruled row: a restrained amber icon
 * and its label. Motion is a single block reveal for the whole grid (plus the
 * heading), so nothing flickers item-by-item.
 */
export function Amenities() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <Reveal>
        <ElevationTag label="What's here" />
        <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
          <GradientShimmer>The small comforts</GradientShimmer>
        </h2>
      </Reveal>
      <Reveal delay={120}>
        <ul className="mt-10 grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
          {AMENITIES.map((a) => (
            <li key={a.label} className="flex items-center gap-3.5 border-t hairline py-4 sm:py-5">
              <Icon name={a.icon} size={20} className="shrink-0 text-amber" />
              <span className="text-sm text-paper sm:text-base">{a.label}</span>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
