"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Room } from "@/lib/site";
import { RoomJourneyCard } from "@/components/marketing/room-journey-card";

/**
 * Rooms fan — the "stay" showcase as a balanced fan of full room cards. All the
 * rooms fan out in one centred, symmetric arc (six cards today: two dorms and
 * four private rooms), so none is buried behind another. Cards are spaced so
 * every card's centre line stays in view, which is where each card shows its
 * room number and its "View room" button. The whole fan is then scaled to the
 * stage width, so every card stays fully in frame on any screen it's shown on.
 * Tilt, shrink and drop keep the original four-card deck's silhouette. The
 * active card is the upright, full-size hero; arrows, a swipe, or the ← → keys
 * cycle through the rooms in both directions (wrapping).
 *
 * Hovering a card lifts and straightens it and pushes the others away, opening a
 * clear gap on both sides (matching the reference card-fan). Built on the
 * project's Framer Motion — no new dependency.
 *
 * Each card is the existing RoomJourneyCard, so every detail (photo, badge,
 * name, type, description, features, CTA) is preserved and every room link stays
 * crawlable. Any card's "View room" opens its page on the first click; clicking
 * anywhere else on a side card brings it to the centre. Only the centred card is
 * in the keyboard tab order (keyboard users cycle with the arrows).
 *
 * The fan is a wide-screen interaction — six 300px cards fanned out stay readable
 * only on a wide screen once fitted to it. So below FAN_MIN_WIDTH (1200px), and
 * under reduced motion, we render a plain native scroll-snap row of the same cards
 * instead. That row is also the server-rendered / pre-hydration default, so the
 * content is always present and crawlable; the fan enhances in on wide screens.
 */

/**
 * Hydration-safe `min-width` media query. The server snapshot is `false`, so SSR
 * and the first client render agree on the scroll-row markup; after hydration the
 * real match applies and wide screens upgrade to the fan.
 */
function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Positions are driven by plain inline transforms + a CSS transition rather than
// a JS animation library: the transform is always in the DOM (nothing to "not
// fire"), which is both reliable and cheap. This easing is a smooth ease-out.
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DUR = 520; // ms for a slide; hover uses a snappier value below
const HOVER_DUR = 300; // ms

/** Shortest signed distance from `active` to card `i` on a ring of `n`. */
function ringDelta(i: number, active: number, n: number) {
  let d = (((i - active) % n) + n) % n; // 0..n-1
  if (d > n / 2) d -= n; // wrap to (-n/2, n/2]
  return d;
}

type Frame = { x: number; y: number; rotate: number; scale: number; zIndex: number; opacity: number };

const ROT_STEP = 7; // degrees of tilt per fan slot
const SCALE_STEP = 0.06; // shrink per slot toward the edges
const Y_ARC = 12; // px the cards drop along the arc (× slot²)

const CARD_W = 300; // fan card size at full scale (w-[300px] h-[520px])
const CARD_H = 520;
const STAGE_H = 640; // stage height at full scale: a card plus room to lift and drop
const STAGE_EDGE = 16; // px kept clear at the stage's left and right edges
// Distance between neighbouring cards: wide enough that each side card's centre
// line (its room number and "View room" button) clears the card in front of it.
const SLOT = CARD_W / 2 + 70;
// Below this width six cards would have to shrink too far to stay readable once
// fitted to the screen, so the plain scroll row is used instead.
const FAN_MIN_WIDTH = 1200;

/** Half the horizontal reach of a card once tilted and scaled. */
function halfWidth(f: Frame) {
  const r = (f.rotate * Math.PI) / 180;
  return ((CARD_W / 2) * Math.abs(Math.cos(r)) + (CARD_H / 2) * Math.abs(Math.sin(r))) * f.scale;
}

/**
 * Fan geometry keyed off `o` — the card's slot offset from the *visual* centre of
 * the deck. Offsets are symmetric around 0 (four cards sit at ±0.5 / ±1.5; a fifth
 * fills the centre; and so on), so the fan stays balanced and centred for any
 * number of cards and no card is ever buried behind another. `slot` sets the
 * horizontal spacing; `shape` scales the tilt, shrink and drop so a bigger deck
 * keeps the four-card deck's silhouette. The active card is the upright,
 * full-size hero and always sits on top of the stack.
 */
function fanTransform(o: number, slot: number, shape: number, isActive: boolean): Frame {
  const x = o * slot;
  if (isActive) {
    return { x, y: 0, rotate: 0, scale: 1, zIndex: 50, opacity: 1 };
  }
  const t = o * shape;
  const at = Math.abs(t);
  return {
    x,
    y: at * at * Y_ARC,
    rotate: t * ROT_STEP,
    scale: 1 - at * SCALE_STEP,
    zIndex: Math.round(40 - at * 8),
    opacity: 1,
  };
}

/**
 * Hover layout: lift and straighten the hovered card, and push every other card
 * away from it — opening a clear gap on both sides, as in the reference card-fan.
 * `oHover` is the hovered card's slot offset (null = nothing hovered).
 */
function hoverAdjust(base: Frame, isHovered: boolean, o: number, oHover: number | null, slot: number): Frame {
  if (oHover === null) return base;
  if (isHovered) {
    return { ...base, y: base.y - 28, rotate: base.rotate * 0.25, scale: base.scale + 0.05, zIndex: 60 };
  }
  const side = o < oHover ? -1 : 1; // sits left of the hovered card → slide left, and vice-versa
  const dist = Math.abs(o - oHover) || 1;
  // Nearer neighbours move furthest: far enough that the lifted card's whole
  // face clears them, whatever the current spacing.
  const push = Math.max(0, CARD_W * 1.05 + 24 - slot) / dist;
  return {
    ...base,
    x: base.x + side * push,
    rotate: base.rotate + side * (4 / (dist + 1)),
  };
}

const ARROW =
  "grid h-11 w-11 place-items-center rounded-full border hairline bg-pine/60 text-paper transition-colors hover:border-amber hover:text-amber focus-visible:border-amber focus-visible:text-amber";

export function RoomsFan({ rooms }: { rooms: Room[] }) {
  const reduce = useReducedMotion();
  const wide = useMinWidth(FAN_MIN_WIDTH);
  const n = rooms.length;
  // Shape factor: tilt, shrink and drop are scaled so a bigger deck keeps the
  // four-card deck's silhouette (1 for four cards or fewer).
  const shape = Math.min(1, 3 / Math.max(1, n - 1));
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [stageW, setStageW] = useState(1280);
  const pointerX = useRef<number | null>(null);

  // Responsive card spacing from the stage width — a ResizeObserver wired through a
  // callback ref, so it attaches exactly when the stage mounts (which only
  // happens once the fan, not the reduced/narrow row, is on screen).
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setStageW(el.clientWidth);
    measure();
    new ResizeObserver(measure).observe(el);
  }, []);

  const go = useCallback((dir: 1 | -1) => {
    setHovered(null);
    setActive((a) => (((a + dir) % n) + n) % n);
  }, [n]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    pointerX.current = e.clientX;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (pointerX.current === null) return;
    const dx = e.clientX - pointerX.current;
    pointerX.current = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); // drag left → next
  };

  // Narrow screens, reduced motion, and the pre-hydration render all get a
  // simple, fully-accessible native scroll of the same cards.
  if (reduce || !wide) {
    return (
      <ul className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

  // Shift every slot so the fan is centred on screen: for an even card count the
  // ring distances are lop-sided (e.g. {-1,0,1,2}), and subtracting their mean
  // re-balances them to symmetric slots ({-1.5,-0.5,0.5,1.5}).
  const centerShift = rooms.reduce((sum, _room, i) => sum + ringDelta(i, active, n), 0) / n;
  const oHover = hovered === null ? null : ringDelta(hovered, active, n) - centerShift;

  // Fit the whole fan to the stage: measure how far the resting fan reaches
  // (tilted cards included) and scale everything down uniformly when the stage
  // is narrower, so every card stays fully in frame. Scaling everything together
  // keeps each card's centre line clear of its neighbours.
  const resting = rooms.map((_r, i) => fanTransform(ringDelta(i, active, n) - centerShift, SLOT, shape, i === active));
  const reach = Math.max(1, ...resting.map((f) => Math.abs(f.x) + halfWidth(f)));
  const half = stageW / 2 - STAGE_EDGE;
  const fit = Math.min(1, half / reach);
  const limit = half / fit; // furthest a card edge may sit from the centre, before scaling

  return (
    <div className="mt-8 sm:mt-10">
      <div
        role="group"
        aria-roledescription="carousel"
        aria-label="Our rooms"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (pointerX.current = null)}
        onMouseLeave={() => setHovered(null)}
        // `isolate` scopes the cards' z-indexes to this stage so they can never
        // paint over the sticky site header; the extra height gives the hovered
        // card room to lift without the top being clipped by `overflow-hidden`.
        className="relative mx-auto flex w-full touch-pan-y select-none items-center justify-center overflow-hidden isolate"
        style={{ height: Math.round(STAGE_H * fit) }}
      >
        <div ref={stageRef} className="absolute inset-0" aria-hidden />
        {rooms.map((room, i) => {
          const o = ringDelta(i, active, n) - centerShift;
          const isActive = i === active;
          const isHovered = hovered === i;
          const f = hoverAdjust(resting[i], isHovered, o, oHover, SLOT);
          // A hover push never carries a card past the stage edge.
          const hw = halfWidth(f);
          const x = Math.max(hw - limit, Math.min(limit - hw, f.x));
          return (
            <div
              key={room.slug}
              className={`absolute left-1/2 top-1/2 h-[520px] w-[300px] [will-change:transform]${
                isActive ? "" : " cursor-pointer"
              }`}
              style={{
                transform: `translate(-50%, -50%) translateX(${x * fit}px) translateY(${f.y * fit}px) rotate(${f.rotate}deg) scale(${f.scale * fit})`,
                zIndex: f.zIndex,
                transition: `transform ${hovered !== null ? HOVER_DUR : DUR}ms ${EASE}`,
              }}
              aria-hidden={!isActive}
              onMouseEnter={() => setHovered(i)}
              // Click a fanned card to bring it to the centre, except on its
              // "View room" link, which opens the room straight away.
              onClick={
                isActive
                  ? undefined
                  : (e) => {
                      if ((e.target as Element).closest("a")) return;
                      setActive(i);
                    }
              }
            >
              <RoomJourneyCard room={room} interactive={isActive} />
            </div>
          );
        })}
      </div>

      {/* Live announcement for screen readers as the centred room changes. */}
      <p className="sr-only" aria-live="polite">
        {`Room ${active + 1} of ${n}: ${rooms[active].name}`}
      </p>

      <div className="mt-5 flex items-center justify-center gap-4 sm:mt-6">
        <button type="button" className={ARROW} aria-label="Previous room" onClick={() => go(-1)}>
          <ChevronLeft size={18} aria-hidden />
        </button>
        <div className="flex items-center gap-2" aria-hidden>
          {rooms.map((room, i) => (
            <span
              key={room.slug}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === active ? "w-5 bg-amber" : "w-1.5 bg-sage/30"
              }`}
            />
          ))}
        </div>
        <button type="button" className={ARROW} aria-label="Next room" onClick={() => go(1)}>
          <ChevronRight size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
