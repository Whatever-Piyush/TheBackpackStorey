"use client";

import { type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT, STAGGER, VIEWPORT } from "./tokens";

/**
 * Reveals its <StaggerItem> children in a quick sequence as the group enters
 * view — for grids/lists (experiences, amenities, attraction cards). Wrap each
 * child in <StaggerItem>. Reduced-motion → renders everything at once.
 */
export function Stagger({
  children,
  className = "",
  gap = STAGGER,
}: {
  children: ReactNode;
  className?: string;
  /** Seconds between each child's entrance. */
  gap?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={{ hidden: {}, visible: { transition: { staggerChildren: gap } } }}
    >
      {children}
    </motion.div>
  );
}

/** One item inside a <Stagger>. Rises + fades in its slot of the sequence. */
export function StaggerItem({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 16 },
        visible: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
      }}
    >
      {children}
    </motion.div>
  );
}
