import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import type { Room } from "@/lib/site";

export function RoomCard({ room }: { room: Room }) {
  const photo = room.photos[0];
  return (
    <Link
      href={`/rooms/${room.slug}`}
      className="group flex flex-col overflow-hidden rounded-card border hairline bg-forest transition-colors hover:border-amber/50"
    >
      <div className="relative aspect-[4/5] overflow-hidden">
        <Image
          src={photo.src}
          alt={photo.alt}
          fill
          sizes="(min-width:1024px) 24vw, (min-width:640px) 45vw, 90vw"
          className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
        <span className="font-data absolute left-3 top-3 rounded-full bg-pine/70 px-2.5 py-1 text-[0.6rem] uppercase tracking-[0.16em] text-paper backdrop-blur">
          {room.isDorm ? "Dorm" : "Private"} · ×{room.sleeps}
        </span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold leading-tight text-paper">{room.name}</h3>
          <ArrowUpRight
            size={18}
            className="mt-1 shrink-0 text-sage transition-colors group-hover:text-amber"
            aria-hidden
          />
        </div>
        <p className="font-data mt-1 text-xs text-sage/80">{room.kind}</p>
        <p className="mt-3 text-sm leading-relaxed text-sage">{room.short}</p>
      </div>
    </Link>
  );
}
