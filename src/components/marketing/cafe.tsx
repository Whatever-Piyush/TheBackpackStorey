import { CAFE } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Marquee } from "@/components/marquee";

export function Cafe() {
  return (
    <section id="cafe" className="py-20 sm:py-28">
      {/* details above */}
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <ElevationTag label="Rooftop café" />
        <h2 className="mt-5 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
          {CAFE.name}
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-sage">{CAFE.blurb}</p>
        <ul className="mt-6 flex flex-wrap gap-2.5">
          {CAFE.highlights.map((h) => (
            <li
              key={h}
              className="capsule rounded-full border hairline px-4 py-1.5 text-sm text-paper"
            >
              {h}
            </li>
          ))}
        </ul>
      </div>

      {/* auto-scrolling image strip below */}
      <div className="mt-12">
        <Marquee photos={CAFE.photos} />
      </div>
    </section>
  );
}
