import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ElevationTag } from "@/components/elevation-tag";
import { BookingWidget, type BookableType } from "@/components/booking/booking-widget";
import { getAvailability, roomTypeIdForCode } from "@/lib/booking/availability";
import { addDays, today } from "@/lib/dates";
import { BOOKING_PAUSED } from "@/lib/launch";
import { ROOMS, SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Book your stay",
  description:
    "Book a dorm bed or a private room at Backpackers Storey, Bir — direct, no middleman.",
};

// Availability moves as people book, so this page is never cached.
export const dynamic = "force-dynamic";

/**
 * Six months of availability for every room type, fetched once on the server.
 *
 * The whole window ships with the page, so changing dates or room type costs no
 * round trip — guests are on the same hill internet the staff are. Room pages
 * show twelve months; six is plenty for actually choosing dates.
 */
const WINDOW_DAYS = 180;

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  // Paused for the portfolio launch: guests go to the contact section instead.
  // Temporary redirect on purpose — this comes back when BOOKING_PAUSED is off.
  if (BOOKING_PAUSED) redirect("/#visit");

  const { type } = await searchParams;

  const from = today();
  const to = addDays(from, WINDOW_DAYS);

  const types = (
    await Promise.all(
      ROOMS.map(async (room): Promise<BookableType | null> => {
        const roomTypeId = await roomTypeIdForCode(room.slug);
        if (!roomTypeId) return null;
        const availability = await getAvailability(roomTypeId, from, to);
        if (!availability) return null;
        return {
          code: room.slug,
          name: room.name,
          isDorm: room.isDorm,
          // A dorm sells beds; a private room sells itself. The allotment caps
          // this again server-side — this is only what we offer to click.
          maxUnits: room.isDorm ? Math.min(room.sleeps, 6) : 1,
          nights: availability.nights,
        };
      }),
    )
  ).filter((t): t is BookableType => t !== null);

  const initialType = types.some((t) => t.code === type) ? type : undefined;

  return (
    <section className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <ElevationTag label="Book direct" elevation={SITE.elevation.property} />
      <h1 className="mt-5 font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        Book your stay
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
        Reserve a dorm bed or a private room straight from us — no middleman. Green
        nights are open; pick your dates and pay when you arrive.
      </p>

      <div className="mt-10">
        <BookingWidget types={types} initialType={initialType} />
      </div>
    </section>
  );
}
