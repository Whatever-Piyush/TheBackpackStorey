import Image from "next/image";
import { PHOTOS, SITE } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Reveal } from "@/components/reveal";

export function Intro() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
      <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
        <Reveal>
          <ElevationTag label="The property" elevation={SITE.elevation.property} />
          <h2 className="mt-5 font-display text-3xl font-extrabold leading-tight tracking-tight text-paper sm:text-4xl">
            Tiny on purpose. Big on the part that matters.
          </h2>
          <div className="mt-5 space-y-4 text-base leading-relaxed text-sage">
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
          </div>
          <ul className="mt-6 flex flex-wrap gap-2.5">
            {["6-bed dorm", "A few private rooms", "Rooftop café"].map((t) => (
              <li key={t} className="capsule rounded-full border hairline px-4 py-1.5 text-sm text-paper">
                {t}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={120} className="grid grid-cols-2 gap-3">
          <div className="group relative aspect-[4/5] overflow-hidden rounded-card border hairline">
            <Image src={PHOTOS.exterior.src} alt={PHOTOS.exterior.alt} fill sizes="(min-width:768px) 24vw, 45vw" className="object-cover transition-transform duration-500 ease-out group-hover:scale-105" />
          </div>
          <div className="group relative mt-8 aspect-[4/5] overflow-hidden rounded-card border hairline">
            <Image src={PHOTOS.sign.src} alt={PHOTOS.sign.alt} fill sizes="(min-width:768px) 24vw, 45vw" className="object-cover transition-transform duration-500 ease-out group-hover:scale-105" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
