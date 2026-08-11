import { AMENITIES } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Icon } from "@/components/icon";
import { Reveal } from "@/components/reveal";

export function Amenities() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <Reveal>
        <ElevationTag label="What's here" />
        <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
          The small comforts
        </h2>
        <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
          {AMENITIES.map((a) => (
            <li key={a.label} className="flex items-center gap-3 text-sage">
              <Icon name={a.icon} className="shrink-0 text-amber" size={22} />
              <span className="text-sm text-paper">{a.label}</span>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
