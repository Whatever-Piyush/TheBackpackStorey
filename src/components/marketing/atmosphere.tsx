/**
 * Fixed atmospheric backdrop for the marketing site.
 *
 * Replaces the former `body { background-attachment: fixed }` gradient, which was
 * moved out of globals.css so it no longer forces a full-viewport repaint on every
 * scroll frame — the worst offender for scroll jank on mobile Safari. A real
 * `position: fixed` element composites on its own layer and simply stays put behind
 * the page as it scrolls, giving the identical dusk-sky depth far more cheaply.
 *
 * Marketing-only: rendered from (marketing)/layout.tsx, so the portal/reception
 * fall back to the plain pine background by design (approved — Option A).
 *
 * Server component — no interactivity, keeps the homepage server-first.
 */
export function Atmosphere() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        // Same three radials as the old body background, now painted on a fixed
        // layer. Positioned relative to the viewport (the fixed box), so the effect
        // matches the previous `background-attachment: fixed` exactly.
        backgroundImage: [
          // warm dawn glow, top-left
          "radial-gradient(1100px 520px at 12% -8%, color-mix(in srgb, var(--color-amber) 11%, transparent), transparent 62%)",
          // bright indigo bloom, top-right
          "radial-gradient(1000px 640px at 108% 2%, color-mix(in srgb, var(--color-violet) 26%, transparent), transparent 58%)",
          // violet haze rising from the horizon
          "radial-gradient(1200px 900px at 50% 118%, color-mix(in srgb, #59308f 32%, transparent), transparent 60%)",
        ].join(", "),
      }}
    />
  );
}
