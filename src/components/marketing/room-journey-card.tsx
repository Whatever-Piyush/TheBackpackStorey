import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { BOOKING_PAUSED } from "@/lib/launch";
import type { Room } from "@/lib/site";
import { RoomPhotoPlaceholder } from "@/components/room-photo-placeholder";

/**
 * A rich room card for the Rooms journey — name, room type, description (up to
 * three lines), one row of features (site.ts lists only what each room's own
 * photos show; the room page has them all), and a CTA to the room detail route.
 * The room number ("Room 1", "Female dorm" …) and the "View room" button sit on
 * the card's centre line, the part of every card the fan keeps in view.
 * Capping the text keeps the photo a usable size on the
 * fixed-height cards even with two-line room names. A room without photos yet
 * gets a "photos coming soon" panel instead of an image. No prices are shown: the data deliberately has
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
        {photo ? (
          <Image
            src={photo.src}
            alt={photo.alt}
            fill
            sizes="(min-width: 768px) 360px, 85vw"
            className="object-cover"
          />
        ) : (
          <RoomPhotoPlaceholder name={room.name} />
        )}
      </div>

      <div className="relative flex flex-col gap-3 p-5 pt-7 sm:p-7 sm:pt-8">
        {/* Room number, centred on the photo's bottom edge. */}
        <span className="font-data absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border hairline bg-pine px-3.5 py-1.5 text-[0.66rem] uppercase tracking-[0.16em] text-paper">
          {room.label}
        </span>
        <div>
          <h3 className="font-display text-2xl font-bold leading-tight text-paper sm:text-3xl">
            {room.name}
          </h3>
          <p className="font-data mt-1 text-xs text-sage/80">{room.kind}</p>
        </div>
        <p className="line-clamp-3 max-w-prose text-sm leading-relaxed text-sage sm:text-base">{room.short}</p>
        {room.features.length > 0 ? (
          <ul className="flex max-h-[1.75rem] flex-wrap gap-2 overflow-hidden">
            {room.features.slice(0, 3).map((f) => (
              <li key={f} className="rounded-full border hairline px-3 py-1 text-xs text-paper">
                {f}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-1 flex flex-col items-center gap-2">
          <Link
            href={`/rooms/${room.slug}`}
            tabIndex={interactive ? undefined : -1}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
          >
            View room <ArrowUpRight size={16} aria-hidden />
          </Link>
          <span className="font-data text-center text-xs text-sage/70">
            {BOOKING_PAUSED ? "Ask for rates on WhatsApp" : "Live rates on the booking page"}
          </span>
        </div>
      </div>
    </article>
  );
}
