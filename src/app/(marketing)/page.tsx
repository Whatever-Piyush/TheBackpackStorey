import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, LogIn, LogOut, MapPin, Mountain } from "lucide-react";
import { AMENITIES, ATTRACTIONS, CAFE, GALLERY, PHOTOS, ROOMS, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { GalleryLightbox } from "@/components/lightbox";
import { Icon } from "@/components/icon";
import { Marquee } from "@/components/marquee";
import { Reveal } from "@/components/reveal";
import { RoomCard } from "@/components/room-card";

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------- hero */}
      <section className="relative isolate flex min-h-[90vh] flex-col justify-end overflow-hidden">
        <Image
          src={PHOTOS.heroCafe.src}
          alt={PHOTOS.heroCafe.alt}
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-pine via-pine/70 to-pine/30" />

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-14 pt-36 sm:px-8">
          <ElevationTag
            label="Bir · Billing"
            elevation={SITE.elevation.launch}
            size="lg"
            className="border-paper/25 bg-pine/55 text-paper shadow-lg backdrop-blur-md"
          />
          <h1 className="mt-6 max-w-3xl font-display text-5xl font-extrabold leading-[0.95] tracking-tight text-paper sm:text-7xl">
            Sleep where the sky launches.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-sage">
            A small backpacker hostel and rooftop café in Bir — a six-bed dorm, a
            handful of private rooms, and a valley view under the world&apos;s
            second-highest paragliding launch.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <BookingButton>Book a bed</BookingButton>
            <Link
              href="/rooms"
              className="inline-flex items-center gap-1.5 rounded-full border border-paper/30 px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-amber hover:text-amber"
            >
              See the rooms
            </Link>
          </div>
        </div>

        <div className="relative border-t hairline bg-pine/50 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2.5 px-5 py-4 sm:gap-3 sm:px-8">
            {[
              { Icon: LogIn, k: "Check-in", v: SITE.checkIn },
              { Icon: LogOut, k: "Check-out", v: SITE.checkOut },
              { Icon: Mountain, k: "Elevation", v: `${SITE.elevation.property.toLocaleString("en-IN")} m` },
              { Icon: MapPin, k: "Coordinates", v: `${SITE.coords.lat.toFixed(4)}°N · ${SITE.coords.lng.toFixed(4)}°E` },
            ].map((c) => (
              <span
                key={c.k}
                className="inline-flex items-center gap-2.5 rounded-full border hairline bg-pine/40 px-4 py-2 transition-colors hover:border-amber/50"
              >
                <c.Icon size={16} strokeWidth={1.8} className="text-amber" aria-hidden />
                <span className="font-data text-[0.7rem] uppercase tracking-[0.14em] text-sage">{c.k}</span>
                <span className="font-data text-sm text-paper">{c.v}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- intro */}
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

      {/* --------------------------------------------------------- stay */}
      <section id="stay" className="border-t hairline bg-forest/40">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <ElevationTag label="Stay" />
              <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
                A bed for every kind of traveller
              </h2>
            </div>
            <Link href="/rooms" className="inline-flex items-center gap-1.5 text-sm text-amber hover:text-paper">
              All rooms <ArrowUpRight size={16} aria-hidden />
            </Link>
          </div>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ROOMS.map((room) => (
              <RoomCard key={room.slug} room={room} />
            ))}
          </div>
          <p className="font-data mt-6 text-xs text-sage/70">
            Live rates and availability open on the booking page.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------- café */}
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

      {/* ----------------------------------------------- nearby attractions */}
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

      {/* ---------------------------------------------------- amenities */}
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

      {/* ------------------------------------------------------ gallery */}
      <section className="border-t hairline bg-forest/40">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <Reveal>
            <ElevationTag label="The place" />
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
              Have a look around
            </h2>
            <p className="mt-3 text-sm text-sage/80">Tap any photo to open the gallery.</p>
          </Reveal>
          <div className="mt-10">
            <GalleryLightbox photos={GALLERY} />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- final cta */}
      <section className="mx-auto max-w-6xl px-5 py-24 text-center sm:px-8">
        <ElevationTag label="Come up" elevation={SITE.elevation.property} className="mx-auto" />
        <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
          A bed, a bonfire and a valley to wake up to.
        </h2>
        <div className="mt-8 flex justify-center">
          <BookingButton>Book a bed</BookingButton>
        </div>
        <p className="font-data mt-5 text-sm text-sage">
          or call{" "}
          <a href={`tel:${SITE.phones[0].replace(/[^\d]/g, "")}`} className="text-amber hover:text-paper">
            {SITE.phones[0]}
          </a>
        </p>
      </section>
    </>
  );
}
