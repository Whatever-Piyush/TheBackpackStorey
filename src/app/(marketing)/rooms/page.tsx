import type { Metadata } from "next";
import { BOOKING_PAUSED } from "@/lib/launch";
import { ROOMS, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";
import { GradientShimmer } from "@/components/motion/gradient-shimmer";
import { RoomCard } from "@/components/room-card";

export const metadata: Metadata = {
  title: "Rooms & Dorms",
  description:
    "Two dorms, The Wildflower Den for women and The Trailblazer's Den for men, plus four private rooms at Backpackers Storey, Bir. Pick the bed that fits the trip.",
  alternates: { canonical: "/rooms" },
};

// Grouped as on the property's booking-channel listing: dorms, then private rooms.
const GROUPS = [
  { title: "Dorms", rooms: ROOMS.filter((r) => r.isDorm) },
  { title: "Private rooms", rooms: ROOMS.filter((r) => !r.isDorm) },
];

export default function RoomsPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <ElevationTag label="Stay" elevation={SITE.elevation.property} />
      <h1 className="mt-5 max-w-2xl font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        <GradientShimmer>A bed for every kind of traveller</GradientShimmer>
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-sage">
        Two dorms, one for women and one for men, and four quiet private rooms,
        all a short climb from the rooftop café.{" "}
        {BOOKING_PAUSED
          ? "Message us on WhatsApp for rates and availability."
          : "Rates and live availability open on the booking page."}
      </p>

      {GROUPS.map((group) => (
        <div key={group.title} className="mt-12">
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-paper">
            {group.title}
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {group.rooms.map((room) => (
              <RoomCard key={room.slug} room={room} />
            ))}
          </div>
        </div>
      ))}

      <div className="mt-12 flex flex-wrap items-center gap-4">
        <BookingButton>Check availability</BookingButton>
        <span className="font-data text-xs text-sage/70">
          Check-in {SITE.checkIn} · Check-out {SITE.checkOut}
        </span>
      </div>
    </section>
  );
}
