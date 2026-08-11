/**
 * Shared motion rhythm for the marketing site — one easing/duration language so
 * every animation feels like the same hand. Keep motion to transform/opacity
 * only; enter with expo-out (a cinematic "arrive and settle"), exit faster.
 *
 * No framer-motion import here on purpose: these are plain constants so the file
 * stays server/client-agnostic and cheap to share.
 */

/** Cubic-bezier expo-out. The signature "settle" for entrances. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Durations in seconds. Enter 0.4–0.7s; exits should run ~65% of these. */
export const DUR = { fast: 0.3, base: 0.55, slow: 0.7 } as const;

/** Seconds between staggered children (grids/lists). ~40–60ms reads as a wave. */
export const STAGGER = 0.06;

/**
 * Standard whileInView config: animate once, when ~20% of the element has
 * entered the viewport. `once` avoids re-triggering on every scroll reversal.
 */
export const VIEWPORT = { once: true, amount: 0.2 };
