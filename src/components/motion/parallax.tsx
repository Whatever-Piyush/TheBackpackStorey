"use client";

import { type ReactNode, useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";

/**
 * Subtle scroll parallax for DECORATIVE layers only (images / backdrops) — never
 * body text or interactive controls. Translates on the Y axis (transform only,
 * no layout thrash) as the element travels through the viewport. Keep the parent
 * wrapper `overflow-hidden` so the layer never spills. Reduced-motion → static.
 *
 * Uses Framer's rAF-driven useScroll — no manual scroll listeners.
 */
export function Parallax({
  children,
  className = "",
  distance = 40,
}: {
  children: ReactNode;
  className?: string;
  /** Total vertical travel in px across the scroll pass (keep small: 20–60). */
  distance?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance]);

  if (reduce) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    );
  }

  return (
    <motion.div ref={ref} className={className} style={{ y }}>
      {children}
    </motion.div>
  );
}
