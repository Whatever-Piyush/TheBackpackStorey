"use client";

import { useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { useReducedMotion } from "framer-motion";

// Hydration/mount flag, the project's idiom (see word-reveal): the server + first
// client render read false, then it flips to true once mounted — with no
// setState-in-effect.
const noopSubscribe = () => () => {};

export interface PhotoStackItem {
  src: string;
  alt: string;
  /** Handwritten note under the photo. */
  caption: string;
  /** Tilt in degrees (sign sets the lean). */
  rotation: number;
  /** Stack nudge, px, from the container centre. */
  offset?: { x?: number; y?: number };
}

/**
 * Photo stack — the property photos as tilted, overlapping "polaroid" cards on a
 * frosted-glass mount, each with a handwritten caption. On hover a card straightens
 * a touch, lifts, scales up and comes to the front; on entry they fade and settle
 * in with a small stagger.
 *
 * Adapted from the reference 3D card stack to this codebase: next/image with the
 * project's own local photos (no external URLs), palette tokens instead of raw
 * white, the handwritten caption via next/font (`font-hand`, no runtime <link>),
 * and a reduced-motion-safe, SSR-safe entrance — the photos and alt text are
 * always in the markup. No new dependency.
 */
export function PhotoStack({ items }: { items: PhotoStackItem[] }) {
  const reduce = useReducedMotion();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [hovered, setHovered] = useState<number | null>(null);

  // Settled from the first paint under reduced motion (and after mount otherwise),
  // so the cards are never stuck hidden.
  const shown = reduce || mounted;

  return (
    <div className="relative mx-auto flex h-[380px] w-full max-w-[24rem] items-center justify-center sm:h-[420px]">
      {items.map((item, i) => {
        const isHovered = hovered === i;
        const ox = item.offset?.x ?? 0;
        const oy = item.offset?.y ?? 0;
        const enterDelay = reduce ? 0 : 120 + i * 200;
        return (
          // Outer: stacking position + entrance (fade / rise / settle), staggered.
          <div
            key={item.src}
            className="absolute left-1/2 top-1/2 cursor-pointer"
            style={{
              transform: `translate(calc(-50% + ${ox}px), calc(-50% + ${oy + (shown ? 0 : 18)}px))`,
              opacity: shown ? 1 : 0,
              zIndex: isHovered ? 30 : 10 + i,
              transition: reduce
                ? "none"
                : `opacity 600ms ease-out ${enterDelay}ms, transform 700ms cubic-bezier(0.22,1,0.36,1) ${enterDelay}ms`,
            }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Inner: the polaroid card + hover lift/straighten/scale. */}
            <div
              className="h-[300px] w-[204px] rounded-lg border border-white/25 bg-white/10 p-2.5 shadow-[0_20px_45px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_0_rgba(255,255,255,0.3)] backdrop-blur-md sm:h-[332px] sm:w-[226px]"
              style={{
                transform: `rotate(${isHovered ? item.rotation * 0.4 : item.rotation}deg) scale(${
                  isHovered ? 1.05 : 1
                }) translateY(${isHovered ? -12 : 0}px)`,
                transition: "transform 350ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              <div className="relative h-[82%] w-full overflow-hidden rounded-md bg-moss">
                <Image
                  src={item.src}
                  alt={item.alt}
                  fill
                  sizes="(min-width:768px) 240px, 60vw"
                  className="object-cover transition-transform duration-300 ease-out"
                  style={{ transform: isHovered ? "scale(1.04)" : "scale(1)" }}
                />
              </div>
              <div className="flex h-[18%] items-center justify-center">
                <p className="font-hand text-2xl leading-none tracking-tight text-paper [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]">
                  {item.caption}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
