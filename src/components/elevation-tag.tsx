import { SITE } from "@/lib/site";

/**
 * The signature device (§2): a mono coordinate / elevation tag.
 * Use it to anchor sections in place, the way a flight log notes a fix.
 */
export function ElevationTag({
  label,
  elevation,
  className = "",
}: {
  label?: string;
  elevation?: number;
  className?: string;
}) {
  return (
    <span
      className={`font-data inline-flex items-center gap-2 rounded-full border hairline px-3 py-1 text-[0.7rem] uppercase tracking-[0.18em] text-sage ${className}`}
    >
      {label ? <span className="text-amber">{label}</span> : null}
      <span aria-hidden className="text-sage/50">
        {SITE.coords.lat.toFixed(4)}°N · {SITE.coords.lng.toFixed(4)}°E
      </span>
      {typeof elevation === "number" ? (
        <span className="text-paper">↑ {elevation.toLocaleString("en-IN")} m</span>
      ) : null}
    </span>
  );
}
