"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { Room } from "@/lib/site";
import { RoomJourneyCard } from "@/components/marketing/room-journey-card";

/**
 * The Rooms showcase — the site's signature scroll interaction.
 *
 * - Desktop (md+, motion allowed): a pinned horizontal "journey". Vertical page
 *   scroll drives the horizontal room pan via a sticky container + a single
 *   transform (no scroll listeners, no smooth-scroll library).
 * - Tablet / mobile: a native horizontal scroll-snap carousel with a partial
 *   "peek" of the next card. Touch scrolling stays completely native.
 * - Reduced motion: always the native carousel — a simple static horizontal
 *   presentation, never the forced pinned animation.
 *
 * Client island only; the surrounding section stays a server component.
 */
export function RoomsJourney({ rooms }: { rooms: Room[] }) {
  const reduce = useReducedMotion();

  // Reduced motion → the plain native carousel for everyone.
  if (reduce) return <RoomsCarousel rooms={rooms} />;

  return (
    <>
      <div className="md:hidden">
        <RoomsCarousel rooms={rooms} />
      </div>
      <div className="hidden md:block">
        <RoomsPinned rooms={rooms} />
      </div>
    </>
  );
}

/**
 * Native horizontal scroll-snap carousel. No JS motion — the browser does the
 * scrolling, so it is keyboard- and touch-accessible by default. Cards are
 * narrower than the viewport so the next one always peeks.
 */
function RoomsCarousel({ rooms }: { rooms: Room[] }) {
  return (
    <ul
      aria-label="Our rooms"
      className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {rooms.map((room) => (
        <li
          key={room.slug}
          className="h-[64dvh] max-h-[560px] min-h-[400px] w-[80vw] max-w-[22rem] shrink-0 snap-start"
        >
          <RoomJourneyCard room={room} />
        </li>
      ))}
    </ul>
  );
}

// Desktop pinned-journey geometry, all in viewport-width units so the transform
// is purely viewport-relative (and clipped by overflow-hidden → no page overflow).
const CARD_VW = 64;
const GAP_VW = 2.5;
const EDGE_VW = 6;

/**
 * Desktop pinned horizontal journey. A tall wrapper provides the scroll
 * distance; a sticky child holds the track; scroll progress drives a single
 * translateX. Large cards mean the centred room reads as the featured one.
 */
function RoomsPinned({ rooms }: { rooms: Room[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  const trackVw = rooms.length * CARD_VW + (rooms.length - 1) * GAP_VW + EDGE_VW * 2;
  const endVw = Math.max(0, trackVw - 100);
  const x = useTransform(scrollYProgress, [0, 1], ["0vw", `-${endVw}vw`]);
  const outerVh = Math.round(100 + endVw); // ~1vh of scroll per 1vw of pan

  // Keyboard support: when a card's link is focused, scroll the page to the
  // vertical offset that pans that card into view (the pan is scroll-driven, so
  // the browser can't reveal it on its own). onFocus — not a scroll listener.
  function focusScroll(i: number) {
    const el = ref.current;
    if (!el) return;
    const range = el.offsetHeight - window.innerHeight;
    const denom = rooms.length > 1 ? rooms.length - 1 : 1;
    window.scrollTo({ top: el.offsetTop + (i / denom) * range });
  }

  return (
    <div ref={ref} style={{ height: `${outerVh}vh` }} className="relative mt-10">
      <div className="sticky top-0 flex h-[100dvh] w-full items-center overflow-hidden">
        <motion.ul style={{ x }} className="flex items-stretch gap-[2.5vw] pl-[6vw] pr-[6vw]">
          {rooms.map((room, i) => (
            <li key={room.slug} className="h-[74dvh] max-h-[680px] w-[64vw] shrink-0">
              <RoomJourneyCard room={room} onFocus={() => focusScroll(i)} />
            </li>
          ))}
        </motion.ul>
      </div>
    </div>
  );
}
