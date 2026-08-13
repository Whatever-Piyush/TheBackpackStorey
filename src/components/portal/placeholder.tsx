import { Plus, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/auth";

/**
 * Scaffold for portal surfaces not built yet. Confirms the auth guard + role
 * gating work (it renders the signed-in role) and lists what each phase brings.
 *
 * Visually subordinate to the live tiles above it by design: banded off behind
 * a rule, and the planned screens are dashed rather than solid — "drawn, not
 * built yet" should be legible at a glance, without reading a word.
 */
export function PortalPlaceholder({
  title,
  phase,
  role,
  intro,
  screens,
}: {
  title: string;
  phase: string;
  role: Role | null;
  intro: string;
  screens: string[];
}) {
  return (
    <section className="border-t hairline bg-forest/25">
      <div className="mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-16">
        <p className="inline-flex items-center gap-2.5 rounded-full border hairline bg-pine/40 px-3.5 py-1.5">
          <span aria-hidden className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber" />
          </span>
          <span className="font-data text-[0.65rem] uppercase tracking-[0.2em] text-amber">
            {phase} · coming next
          </span>
        </p>

        <h2 className="mt-5 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-xl leading-relaxed text-sage">{intro}</p>

        <ul className="mt-8 grid gap-2.5 sm:grid-cols-2">
          {screens.map((s) => (
            <li
              key={s}
              className="flex items-start gap-3 rounded-xl border border-dashed border-sage/25 bg-forest/40 px-4 py-3.5 text-sm leading-relaxed text-paper/90"
            >
              <Plus size={14} strokeWidth={2} className="mt-1 shrink-0 text-amber/70" aria-hidden />
              <span>{s}</span>
            </li>
          ))}
        </ul>

        <p className="mt-10 flex items-start gap-2.5 text-xs leading-relaxed text-sage/70">
          <ShieldCheck size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-sage/60" aria-hidden />
          <span className="font-data">
            Signed in as <span className="text-paper">{role ?? "—"}</span>. The auth guard and
            role gating are live; the screens above land in the next phase.
          </span>
        </p>
      </div>
    </section>
  );
}
