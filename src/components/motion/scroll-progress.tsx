"use client";

import { motion, useReducedMotion, useScroll, useSpring } from "framer-motion";

/**
 * Thin amber progress bar pinned to the top of the viewport, its width tracking
 * page scroll — a quiet "descent" indicator on the long homepage. Spring-smoothed
 * so it eases rather than snaps. Sits above the sticky header (z-60).
 * Reduced-motion → not rendered.
 */
export function ScrollProgress() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.3 });

  if (reduce) return null;

  return (
    <motion.div
      aria-hidden
      className="fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-amber"
      style={{ scaleX }}
    />
  );
}
