"use client";

import { type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT, VIEWPORT } from "./tokens";

/**
 * Scroll-reveal: fades + rises its children as they enter the viewport, once.
 *
 * Framer-Motion successor to `@/components/reveal` (the legacy
 * IntersectionObserver version). Same API — `children`, `className`, `delay`
 * (in ms) — so call sites migrate with just an import-path change; the legacy
 * component is retired once nothing imports it. Honours prefers-reduced-motion
 * by rendering the final state with no animation.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Delay before the reveal, in milliseconds (matches the legacy Reveal API). */
  delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: DUR.base, ease: EASE_OUT, delay: delay / 1000 }}
    >
      {children}
    </motion.div>
  );
}
