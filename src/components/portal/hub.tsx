import Link from "next/link";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { ElevationTag } from "@/components/elevation-tag";
import { SITE } from "@/lib/site";

/**
 * Shared furniture for the portal hub screens (Café POS, Stays).
 *
 * The hubs are the first thing staff see after signing in, so they carry the
 * brand rather than reading like a link dump: a ruled eyebrow, the elevation
 * tag as the signature device, and tiles that lift into dusk-gold on hover.
 */

export type HubTile = {
  href: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  /** Built and reachable. Anything else renders dimmed with a "Soon" chip. */
  live?: boolean;
};

export function HubHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: string;
  intro: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-5">
      {/* max-w-lg, not max-w-xl: the intro and the tag have to share a 64rem
          row, and at max-w-xl the tag wraps onto a line of its own. */}
      <div className="max-w-lg">
        <p className="flex items-center gap-3">
          <span aria-hidden className="h-px w-8 bg-gradient-to-r from-amber to-amber/0" />
          <span className="font-data text-xs uppercase tracking-[0.2em] text-amber">
            {eyebrow}
          </span>
        </p>
        <h1 className="mt-4 font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-paper sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 leading-relaxed text-sage">{intro}</p>
      </div>

      <ElevationTag
        label="Bir · Billing"
        elevation={SITE.elevation.property}
        className="mt-2 hidden bg-forest/40 lg:inline-flex"
      />
    </header>
  );
}

/**
 * Two-up tiles. An odd count would leave a gap on the last row, so the final
 * tile stretches across and switches to the wide layout — deliberate, rather
 * than an orphan. Counts vary by role, so this is computed, not hard-coded.
 */
export function HubGrid({ tiles }: { tiles: HubTile[] }) {
  const wideLast = tiles.length % 2 === 1;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {tiles.map((tile, i) => (
        <HubCard key={tile.href} tile={tile} wide={wideLast && i === tiles.length - 1} />
      ))}
    </div>
  );
}

function HubCard({ tile, wide = false }: { tile: HubTile; wide?: boolean }) {
  const live = tile.live !== false;
  const Icon = tile.icon;

  const body = (
    <>
      <span
        className={`grid shrink-0 place-items-center rounded-xl border border-amber/25 bg-amber/10 text-amber transition-colors duration-200 ${
          wide ? "h-12 w-12" : "h-11 w-11"
        } ${live ? "group-hover:border-amber group-hover:bg-amber group-hover:text-pine" : ""}`}
      >
        <Icon size={wide ? 22 : 20} strokeWidth={1.7} aria-hidden />
      </span>

      <span className={wide ? "min-w-0" : "mt-4 block"}>
        <span className="block font-display text-lg font-bold leading-snug text-paper">
          {tile.label}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-sage">{tile.blurb}</span>
      </span>

      {live ? (
        <ArrowUpRight
          size={18}
          strokeWidth={1.8}
          aria-hidden
          className={`shrink-0 text-sage/60 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-amber ${
            wide ? "ml-auto self-center" : "absolute right-5 top-6"
          }`}
        />
      ) : (
        <span
          className={`font-data shrink-0 rounded-full border hairline px-2.5 py-1 text-[0.6rem] uppercase tracking-[0.18em] text-sage/70 ${
            wide ? "ml-auto self-center" : "absolute right-5 top-5"
          }`}
        >
          Soon
        </span>
      )}
    </>
  );

  const shape = `tile group relative flex h-full rounded-card border hairline p-5 ${
    wide ? "items-center gap-4 sm:col-span-2 sm:p-6" : "flex-col"
  }`;

  return live ? (
    <Link
      href={tile.href}
      className={`${shape} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/70 focus-visible:ring-offset-2 focus-visible:ring-offset-pine`}
    >
      {body}
    </Link>
  ) : (
    <div className={`${shape} tile-idle`}>{body}</div>
  );
}
