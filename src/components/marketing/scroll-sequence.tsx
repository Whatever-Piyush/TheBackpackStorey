"use client";

import { useCallback, useEffect, useRef } from "react";
import { useMotionValueEvent, useReducedMotion, useScroll } from "framer-motion";

/**
 * ScrollSequence — a page-wide fixed background whose paragliding footage advances
 * frame-by-frame with overall document scroll. It is NOT a section: it renders a
 * `fixed inset-0 -z-10 pointer-events-none` canvas (plus a dark scrim) from the
 * marketing layout, so it stays put behind every marketing route while the real
 * content scrolls normally above it. The <Atmosphere/> beneath it shows through
 * while frames load and under reduced motion.
 *
 * Frame selection is driven by Framer Motion's document `useScroll()` →
 * `scrollYProgress` (0 at the top, 1 near the bottom) via `useMotionValueEvent`,
 * so there is no manual scroll listener and no rAF loop. The canvas is redrawn
 * only when the integer frame index actually changes, and nothing here calls
 * setState on scroll — frames live in a ref, not React state.
 *
 * Strategy is isolated per device:
 *   • desktop (fine pointer, motion on): preload all frames, scrub 1…300.
 *   • mobile  (coarse pointer):          one static frame, no bulk preload.
 *   • reduced motion:                    draw nothing → the Atmosphere is the
 *                                        background (no memory-heavy footage).
 */

const FRAME_COUNT = 300;
// Frame shown as the still on touch devices — a scenic mid-flight frame. Tunable;
// the mobile branch loads only this one image, never the full sequence.
const MOBILE_STATIC_FRAME = 120;
const framePath = (i: number) => `/scroll/frame-${String(i + 1).padStart(3, "0")}.jpg`;

export function ScrollSequence() {
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<(HTMLImageElement | undefined)[]>([]);
  const frameRef = useRef(-1);
  const scrubRef = useRef(false); // true only for the desktop full sequence
  const { scrollYProgress } = useScroll();

  // Draw a frame scaled to cover the canvas (center-cropped), in device pixels.
  const draw = useCallback((index: number) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[index];
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = cw / ch;
    let dw: number, dh: number, dx: number, dy: number;
    if (cr > ir) {
      dw = cw;
      dh = cw / ir;
      dx = 0;
      dy = (ch - dh) / 2;
    } else {
      dh = ch;
      dw = ch * ir;
      dy = 0;
      dx = (cw - dw) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
  }, []);

  // Size the canvas to the viewport (DPR-capped) and redraw the current frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      if (frameRef.current >= 0) draw(frameRef.current);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draw]);

  const frameFor = (progress: number) =>
    Math.min(FRAME_COUNT - 1, Math.max(0, Math.round(progress * (FRAME_COUNT - 1))));

  // Load strategy (per device). Frames are kept in a ref, never React state.
  useEffect(() => {
    scrubRef.current = false;
    if (reduce) return; // reduced motion → Atmosphere is the background

    const mobile = window.matchMedia("(pointer: coarse)").matches;
    let cancelled = false;

    if (mobile) {
      const idx = MOBILE_STATIC_FRAME;
      const img = new window.Image();
      img.onload = () => {
        if (!cancelled) draw(idx);
      };
      img.src = framePath(idx);
      imagesRef.current[idx] = img;
      frameRef.current = idx;
      return () => {
        cancelled = true;
      };
    }

    // Desktop: preload every frame; each draws itself if it is the current target.
    scrubRef.current = true;
    const imgs: (HTMLImageElement | undefined)[] = new Array(FRAME_COUNT);
    for (let i = 0; i < FRAME_COUNT; i += 1) {
      const img = new window.Image();
      img.onload = () => {
        if (!cancelled && i === frameRef.current) draw(i);
      };
      img.src = framePath(i);
      imgs[i] = img;
    }
    imagesRef.current = imgs;
    frameRef.current = frameFor(scrollYProgress.get());
    draw(frameRef.current); // no-op until that frame's image is ready
    return () => {
      cancelled = true;
    };
  }, [reduce, draw, scrollYProgress]);

  // Document scroll → frame index. Redraw only when the index changes.
  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    if (!scrubRef.current) return;
    const next = frameFor(progress);
    if (next !== frameRef.current) {
      frameRef.current = next;
      draw(next);
    }
  });

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <canvas ref={canvasRef} className="h-full w-full" />
      {/* Moderate scrim so the footage reads as ambient and text stays legible. */}
      <div className="absolute inset-0 bg-pine/62" />
    </div>
  );
}
