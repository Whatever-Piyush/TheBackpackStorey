import Link from "next/link";
import { Home, UtensilsCrossed, Images, MapPin, type LucideIcon } from "lucide-react";
import { NAV } from "@/lib/site";

/**
 * GradientNav — the desktop header nav as gradient "expanding pill" buttons,
 * adapted from the reference Gradient Menu. Each item rests as a small glass
 * circle showing just its icon; on hover it grows into a pill, the icon swaps out
 * for the label, and a per-item gradient (plus a soft glow) fills it in.
 *
 * Frosted "liquid glass" circles at rest (translucent + backdrop blur + a soft
 * top highlight) that expand into gradient pills on hover, light icons that scale
 * out, the title that scales in, and the blur glow underneath. Icons are
 * lucide-react (no new dependency) and items are real crawlable next/link with
 * accessible names.
 */

type NavStyle = { Icon: LucideIcon; from: string; to: string };

// Keyed by href so it stays correct if labels change. Icons per the brief
// (Stay → home, Café → crossed cutlery, Bir → gallery, Visit → map pin); the
// gradients lean vibrant but keep the site's amber + violet in the mix.
const STYLES: Record<string, NavStyle> = {
  "/rooms": { Icon: Home, from: "#33B4D9", to: "#0E5A82" }, // Stay — ocean blue
  "/#cafe": { Icon: UtensilsCrossed, from: "#A56EE0", to: "#6E4BD0" }, // Café — purple
  "/#bir": { Icon: Images, from: "#a955ff", to: "#ea51ff" }, // Bir — violet → magenta
  "/#visit": { Icon: MapPin, from: "#56CCF2", to: "#2F80ED" }, // Visit — sky blue
};

const FALLBACK: NavStyle = { Icon: MapPin, from: "#a955ff", to: "#ea51ff" };

export function GradientNav() {
  return (
    <ul className="flex items-center gap-4">
      {NAV.map((item) => {
        const { Icon, from, to } = STYLES[item.href] ?? FALLBACK;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-label={item.label}
              // The width transition is set inline: globals.css has an unlayered
              // `a, button { transition: …150ms }` rule (no `width` in its
              // property list) that would otherwise override any Tailwind
              // `duration-*`/`transition-all` on this anchor and snap it open.
              style={{ ["--from" as string]: from, ["--to" as string]: to, transition: "all 0.35s ease-out" }}
              className="group relative flex h-[46px] w-[46px] cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-paper shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] backdrop-blur-md hover:w-[140px] hover:border-transparent hover:shadow-none"
            >
              {/* Gradient background on hover */}
              <span
                aria-hidden
                className="absolute inset-0 rounded-full bg-[linear-gradient(45deg,var(--from),var(--to))] opacity-0 transition-all duration-[350ms] group-hover:opacity-100"
              />
              {/* Blur glow */}
              <span
                aria-hidden
                className="absolute inset-x-0 top-2 -z-10 h-full rounded-full bg-[linear-gradient(45deg,var(--from),var(--to))] opacity-0 blur-[15px] transition-all duration-[350ms] group-hover:opacity-50"
              />
              {/* Icon */}
              <span className="relative z-10 transition-all delay-0 duration-[350ms] group-hover:scale-0">
                <Icon size={19} className="text-paper" aria-hidden />
              </span>
              {/* Title */}
              <span className="absolute z-10 scale-0 text-xs uppercase tracking-wide text-white transition-all delay-150 duration-[350ms] group-hover:scale-100">
                {item.label}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
