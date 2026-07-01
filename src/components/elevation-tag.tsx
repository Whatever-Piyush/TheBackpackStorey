import { SITE } from "@/lib/site";

/**
 * The signature device (§2): a mono coordinate / elevation tag.
 * Use it to anchor sections in place, the way a flight log notes a fix.
 */
type Size = "sm" | "lg";

const SIZES: Record<Size, string> = {
  sm: "gap-2 px-3 py-1 text-[0.7rem]",
  lg: "gap-2.5 px-4 py-2 text-sm sm:text-base",
};

export function ElevationTag({
  label,
  elevation,
  className = "",
  size = "sm",
}: {
  label?: string;
  elevation?: number;
  className?: string;
  size?: Size;
}) {
  const coordClass = size === "lg" ? "text-paper/70" : "text-sage/50";
  return (
    <span
      className={`font-data inline-flex items-center rounded-full border hairline font-medium uppercase tracking-[0.18em] text-sage ${SIZES[size]} ${className}`}
    >
      {label ? <span className="font-semibold text-amber">{label}</span> : null}
      <span aria-hidden className={coordClass}>
        {SITE.coords.lat.toFixed(4)}°N · {SITE.coords.lng.toFixed(4)}°E
      </span>
      {typeof elevation === "number" ? (
        <span className="font-semibold text-paper">↑ {elevation.toLocaleString("en-IN")} m</span>
      ) : null}
    </span>
  );
}
