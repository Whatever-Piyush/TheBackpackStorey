"use client";

import { Fragment } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT, VIEWPORT } from "./tokens";

/**
 * Headline reveal: animates a short line in word-by-word as it enters view.
 * Word-level (not character-level) keeps the DOM small and screen-reader
 * friendly — the whole line is exposed via aria-label while the animated word
 * spans are aria-hidden. Reserve for short headlines (≤ ~8 words). Regular
 * spaces between words let the line wrap normally. Reduced-motion → plain text.
 */
export function WordReveal({
  text,
  className = "",
  delay = 0,
  wordGap = 0.08,
}: {
  text: string;
  className?: string;
  /** Delay before the first word, in milliseconds. */
  delay?: number;
  /** Seconds between words. */
  wordGap?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{text}</span>;

  const words = text.split(" ");
  return (
    <motion.span
      className={className}
      aria-label={text}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: wordGap, delayChildren: delay / 1000 } },
      }}
    >
      {words.map((word, i) => (
        <Fragment key={i}>
          <motion.span
            aria-hidden
            className="inline-block"
            variants={{
              hidden: { opacity: 0, y: "0.4em" },
              visible: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
            }}
          >
            {word}
          </motion.span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </motion.span>
  );
}
