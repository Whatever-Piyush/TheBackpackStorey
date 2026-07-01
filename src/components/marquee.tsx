import Image from "next/image";
import type { Photo } from "@/lib/site";

/**
 * Full-bleed horizontal image strip that auto-scrolls left → right (CSS only).
 * Hovering anywhere on the strip pauses it; hovering an image lifts it "out" and
 * slides up a caption so you can tell what's in the shot.
 */
export function Marquee({ photos }: { photos: readonly Photo[] }) {
  // Duplicate the list so the translateX loop is seamless.
  const loop = [...photos, ...photos];

  return (
    <div className="marquee group relative overflow-hidden">
      {/* soft edge fades into the page */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-14 bg-gradient-to-r from-pine to-transparent sm:w-28" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-14 bg-gradient-to-l from-pine to-transparent sm:w-28" />

      <ul className="marquee-track flex w-max gap-4 py-4">
        {loop.map((p, i) => (
          <li key={i} aria-hidden={i >= photos.length} className="shrink-0">
            <figure className="group/card relative h-64 w-52 overflow-hidden rounded-card border hairline transition-transform duration-300 ease-out hover:z-10 hover:scale-[1.06] hover:shadow-2xl sm:h-72 sm:w-60">
              <Image
                src={p.src}
                alt={p.alt}
                fill
                sizes="240px"
                className="object-cover transition-transform duration-500 ease-out group-hover/card:scale-110"
              />
              <figcaption className="absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-pine via-pine/85 to-transparent p-3 pt-10 text-xs leading-snug text-paper opacity-0 transition-all duration-300 ease-out group-hover/card:translate-y-0 group-hover/card:opacity-100">
                {p.alt}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}
