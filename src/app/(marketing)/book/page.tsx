import type { Metadata } from "next";
import { ElevationTag } from "@/components/elevation-tag";
import { BookingWidget } from "@/components/booking/booking-widget";
import { SITE, type RoomType } from "@/lib/site";

export const metadata: Metadata = {
  title: "Book your stay",
  description:
    "Book a dorm bed or a private room at Backpackers Storey, Bir — direct, no middleman.",
};

const VALID: RoomType[] = ["dorm", "deluxe", "premium", "family"];

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const initialType = VALID.includes(type as RoomType) ? (type as RoomType) : undefined;

  return (
    <section className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <ElevationTag label="Book direct" elevation={SITE.elevation.property} />
      <h1 className="mt-5 font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        Book your stay
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
        Reserve a dorm bed or a private room straight from us — no middleman. Pick
        your dates, we'll show what's free, and you pay when you arrive.
      </p>

      <div className="mt-10">
        <BookingWidget initialType={initialType} />
      </div>
    </section>
  );
}
