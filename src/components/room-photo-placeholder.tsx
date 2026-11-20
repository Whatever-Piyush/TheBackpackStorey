import { BedSingle } from "lucide-react";

/**
 * Stands in for a room's photo until the owner adds some (e.g. a newly listed
 * dorm). Fills its positioned parent, like an `<Image fill>` would.
 */
export function RoomPhotoPlaceholder({ name }: { name: string }) {
  return (
    <div
      role="img"
      aria-label={`Photos of ${name} coming soon`}
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-forest via-pine to-forest text-sage"
    >
      <BedSingle size={40} strokeWidth={1.4} aria-hidden />
      <span className="font-data text-[0.65rem] uppercase tracking-[0.18em]">Photos coming soon</span>
    </div>
  );
}
