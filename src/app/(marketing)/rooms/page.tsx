import type { Metadata } from "next";
import { ROOMS, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";
import { RoomCard } from "@/components/room-card";

export const metadata: Metadata = {
  title: "Rooms & Dorm",
  description:
    "A six-bed dormitory and a handful of private rooms at Backpackers Storey, Bir — pick the bed that fits the trip.",
};

export default function RoomsPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <ElevationTag label="Stay" elevation={SITE.elevation.property} />
      <h1 className="mt-5 max-w-2xl font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        <GradientShimmer>A bed for every kind of traveller</GradientShimmer>
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
        One social dorm and a few quiet private rooms, all a short climb from the
        rooftop café. Rates and live availability open on the booking page.
      </p>

      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {ROOMS.map((room) => (
          <RoomCard key={room.slug} room={room} />
        ))}
      </div>

      <div className="mt-12 flex flex-wrap items-center gap-4">
        <BookingButton>Check availability</BookingButton>
        <span className="font-data text-xs text-sage/70">
          Check-in {SITE.checkIn} · Check-out {SITE.checkOut}
        </span>
      </div>
    </section>
  );
}
