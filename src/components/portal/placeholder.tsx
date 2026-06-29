import type { Role } from "@/lib/auth";

/**
 * Scaffold for portal surfaces not built yet. Confirms the auth guard + role
 * gating work (it renders the signed-in role) and lists what each phase brings.
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
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="font-data text-xs uppercase tracking-[0.2em] text-amber">{phase} · coming next</p>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
        {title}
      </h1>
      <p className="mt-4 max-w-xl leading-relaxed text-sage">{intro}</p>

      <ul className="mt-8 grid gap-2.5 sm:grid-cols-2">
        {screens.map((s) => (
          <li
            key={s}
            className="rounded-xl border hairline bg-forest px-4 py-3 text-sm text-paper"
          >
            {s}
          </li>
        ))}
      </ul>

      <p className="font-data mt-10 text-xs text-sage/70">
        Signed in as <span className="text-paper">{role ?? "—"}</span>. The auth guard and
        role gating are live; the screens above land in the next phase.
      </p>
    </div>
  );
}
