import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Room } from "@/lib/site";

/**
 * A rich room card for the Rooms journey — identity badge, name, room type,
 * description, the first few real features (from site.ts, so e.g. the Family
 * Room correctly reads "Shared bathroom", never "attached"), and a CTA to the
 * existing room detail route. No prices are shown: the data deliberately has
 * none, so we point to the booking page for live rates rather than invent any.
 *
 * Presentational only. The CTA is always a real crawlable link; `interactive`
 * (default true) keeps it in the tab order. Set it false for a non-centred card
 * in the fan so it stays in the HTML but out of the keyboard tab order.
 */
export function RoomJourneyCard({
  room,
  interactive = true,
}: {
  room: Room;
  interactive?: boolean;
}) {
  const photo = room.photos[0];
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-card border hairline bg-forest">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Image
          src={photo.src}
          alt={photo.alt}
          fill
          sizes="(min-width: 768px) 360px, 85vw"
          className="object-cover"
        />
        <span className="font-data absolute left-4 top-4 rounded-full bg-pine/70 px-3 py-1 text-[0.62rem] uppercase tracking-[0.16em] text-paper backdrop-blur">
          {room.isDorm ? "Dorm" : "Private"} · ×{room.sleeps}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-5 sm:p-7">
        <div>
          <h3 className="font-display text-2xl font-bold leading-tight text-paper sm:text-3xl">
            {room.name}
          </h3>
          <p className="font-data mt-1 text-xs text-sage/80">{room.kind}</p>
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-sage sm:text-base">{room.short}</p>
        <ul className="flex flex-wrap gap-2">
          {room.features.slice(0, 3).map((f) => (
            <li key={f} className="rounded-full border hairline px-3 py-1 text-xs text-paper">
              {f}
            </li>
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href={`/rooms/${room.slug}`}
            tabIndex={interactive ? undefined : -1}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
          >
            View room <ArrowUpRight size={16} aria-hidden />
          </Link>
          <span className="font-data text-xs text-sage/70">Live rates on the booking page</span>
        </div>
      </div>
    </article>
  );
}
