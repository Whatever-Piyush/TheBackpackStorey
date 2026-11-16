import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { BOOKING_PAUSED } from "@/lib/launch";
import { getRoom, ROOMS, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { RoomCard } from "@/components/room-card";
import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import { addDays, today } from "@/lib/dates";
import { getAvailability, roomTypeIdForCode } from "@/lib/booking/availability";

// Pre-render every room type, then refresh the calendar periodically. The page
// itself never depends on availability loading — see below.
export function generateStaticParams() {
  return ROOMS.map((room) => ({ type: room.slug }));
}

export const revalidate = 300;

// Next 16: route params arrive as a Promise.
type Params = { params: Promise<{ type: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { type } = await params;
  const room = getRoom(type);
  if (!room) return { title: "Room not found" };
  return {
    title: room.name,
    description: room.short,
    alternates: { canonical: `/rooms/${room.slug}` },
  };
}

export default async function RoomDetailPage({ params }: Params) {
  const { type } = await params;
  const room = getRoom(type);
  if (!room) notFound();

  const [hero, ...rest] = room.photos;
  const others = ROOMS.filter((r) => r.slug !== room.slug);

  // The room ALWAYS renders. Availability is additive: if the database is
  // unreachable, or Supabase isn't configured, the page still sells the room and
  // simply doesn't show a calendar. While booking is paused there is no lookup
  // at all — the page is pure content plus the WhatsApp enquiry CTA.
  const roomTypeId = BOOKING_PAUSED ? null : await roomTypeIdForCode(room.slug);
  const availability = roomTypeId
    ? await getAvailability(roomTypeId, today(), addDays(today(), 365))
    : null;

  return (
    <article className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <Link
        href="/rooms"
        transitionTypes={["nav-back"]}
        className="inline-flex items-center gap-1.5 text-sm text-sage transition-colors hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> All rooms
      </Link>

      <div className="mt-8 grid gap-8 md:grid-cols-2 md:gap-12">
        <div className="relative aspect-[4/5] overflow-hidden rounded-card">
          <Image
            src={hero.src}
            alt={hero.alt}
            fill
            priority
            sizes="(min-width:768px) 48vw, 92vw"
            className="object-cover"
          />
        </div>

        <div className="self-center">
          <ElevationTag label={room.isDorm ? "Dormitory" : "Private room"} />
          <h1 className="mt-5 font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
            {room.name}
          </h1>
          <p className="font-data mt-2 text-sm text-sage">{room.kind}</p>

          <div className="mt-6 space-y-4 text-base leading-relaxed text-sage">
            {room.long.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>

          <ul className="mt-7 grid grid-cols-2 gap-x-5 gap-y-2.5">
            {room.features.map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-paper">
                <Check size={16} strokeWidth={2.4} className="shrink-0 text-amber" aria-hidden />
                {f}
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <BookingButton type={room.slug}>Book this {room.isDorm ? "bed" : "room"}</BookingButton>
            <a
              href={`tel:${SITE.phones[0].replace(/[^\d]/g, "")}`}
              className="font-data text-sm text-sage hover:text-paper"
            >
              or call {SITE.phones[0]}
            </a>
          </div>
        </div>
      </div>

      {BOOKING_PAUSED ? null : (
        <section className="mt-14">
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-paper">
            When you can stay
          </h2>
          <p className="mt-1.5 text-sm text-sage">
            Twelve months ahead. Green nights are open — pick your dates on the
            booking page.
          </p>
          <div className="mt-4 max-w-md">
            <AvailabilityCalendar
              nights={availability?.nights ?? []}
              unitNoun={room.isDorm ? "bed" : "room"}
            />
          </div>
        </section>
      )}

      {rest.length > 0 ? (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {rest.map((p) => (
            <div key={p.src} className="relative aspect-[4/3] overflow-hidden rounded-xl">
              <Image
                src={p.src}
                alt={p.alt}
                fill
                sizes="(min-width:640px) 30vw, 45vw"
                className="object-cover"
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-20 border-t hairline pt-12">
        <h2 className="font-display text-2xl font-extrabold tracking-tight text-paper">
          Other rooms
        </h2>
        <div className="mt-6 grid gap-5 sm:grid-cols-3">
          {others.map((r) => (
            <RoomCard key={r.slug} room={r} />
          ))}
        </div>
      </div>
    </article>
  );
}
