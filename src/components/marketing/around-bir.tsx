import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import { ATTRACTIONS } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { Icon } from "@/components/icon";
import { Reveal } from "@/components/reveal";

export function AroundBir() {
  return (
    <section id="bir" className="border-t hairline bg-forest/40">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <Reveal>
          <ElevationTag label="Around Bir" />
          <h2 className="mt-4 max-w-2xl font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
            You did not come this far to stay in your room
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
            Hidden waterfalls, the paragliding capital of India and pure adrenaline —
            all within a couple of kilometres of the door.
          </p>
        </Reveal>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ATTRACTIONS.map((a, i) => {
            const hasPhoto = existsSync(join(process.cwd(), "public", a.photo));
            return (
              <Reveal key={a.slug} delay={i * 70}>
                <div className="group flex h-full flex-col overflow-hidden rounded-card border hairline bg-pine/40 transition-colors hover:border-amber/50">
                  <div className="relative aspect-[16/10] overflow-hidden">
                    {hasPhoto ? (
                      <Image
                        src={a.photo}
                        alt={a.name}
                        fill
                        sizes="(min-width:1024px) 32vw, (min-width:640px) 45vw, 90vw"
                        className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-gradient-to-br from-moss via-forest to-pine">
                        <Icon name={a.icon} size={40} className="text-amber/80" />
                      </div>
                    )}
                    <span className="font-data absolute left-3 top-3 rounded-full bg-pine/70 px-2.5 py-1 text-[0.6rem] uppercase tracking-[0.16em] text-paper backdrop-blur">
                      {a.distance}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <div className="flex items-center gap-2.5">
                      <Icon name={a.icon} size={18} className="text-amber" />
                      <h3 className="font-display text-lg font-bold text-paper">{a.name}</h3>
                    </div>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-sage">{a.blurb}</p>
                    <a
                      href={a.maps}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center gap-1.5 text-sm text-amber transition-colors hover:text-paper"
                    >
                      <Icon name="Navigation" size={15} /> Directions
                    </a>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
