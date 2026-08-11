import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ROOMS } from "@/lib/site";
import { ElevationTag } from "@/components/elevation-tag";
import { RoomCard } from "@/components/room-card";

export function RoomsShowcase() {
  return (
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
  );
}
