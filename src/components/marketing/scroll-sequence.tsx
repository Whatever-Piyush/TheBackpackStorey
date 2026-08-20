"use client";

import { useEffect, useRef } from "react";
import { useMotionValueEvent, useReducedMotion, useScroll } from "framer-motion";

/**
 * ScrollSequence — a page-wide fixed background whose paragliding footage advances
 * frame-by-frame with document scroll. Fixed `inset-0 -z-10 pointer-events-none`
 * canvas + dark scrim, layered above <Atmosphere/> and behind content.
 *
 * The desktop set is a 537-frame, motion-compensated interpolation of the original
 * capture (3× the temporal density — ~14.5 px of scroll per frame instead of ~43),
 * so the paraglider has genuine intermediate positions to land on and the motion
 * reads as continuous even at very slow scroll. Because 537 frames decoded at
 * 1280×720 would need ~1.9 GB resident, the engine never decodes the whole set:
 *
 *   • Every frame's encoded WebP blob is prefetched once (the whole set is ~26 MB)
 *     into a persistent Map, so after preload scrubbing pays only the decode cost —
 *     no network round-trip mid-scroll.
 *   • Decoded ImageBitmaps live in a bounded, direction-aware sliding window; frames
 *     leaving the window are `.close()`d immediately (never left to GC).
 *   • Decoding is off-thread (createImageBitmap), concurrency-limited, and
 *     stale-protected: a decode that resolves for a frame no longer in the window is
 *     closed at once, so a fast jump never queues hundreds of live bitmaps.
 *   • Scroll only updates a target frame; a single rAF loop eases a smoothed visual
 *     playhead toward it and draws the nearest resident frame — never blocking,
 *     never synchronously decoding.
 *
 * Device tiers pick the asset set (resolution/frame-count), window size, DPR cap and
 * decode concurrency from feature-detected capability signals only — no
 * fingerprinting, nothing stored or transmitted, conservative when unknown. Reduced
 * motion and low-memory/saveData get a static fallback (Atmosphere shows through).
 */

const SETS = {
  desktop: { dir: "/scroll-interpolated/desktop", count: 537 },
  mobile: { dir: "/scroll-spike/mobile", count: 120 },
} as const;

type SetName = keyof typeof SETS;

type TierConfig = {
  set: SetName;
  ahead: number; // prefetch this many decoded frames ahead of the playhead
  behind: number; // …and this many behind (for scroll reversals)
  // Prefetch every frame's encoded blob up front so scrubbing never hits the
  // network (only the large desktop set — mobile leans on the HTTP cache).
  prefetchAll: boolean;
  dprCap: number;
  concurrency: number;
};

const TIERS = {
  // Desktop: 537 interpolated frames @1280×720. A generous window keeps slow/normal
  // scroll drawing the exact frame; fast scroll falls back to the nearest resident
  // frame (never blank, never a synchronous decode).
  desktopHigh: { set: "desktop", ahead: 56, behind: 18, prefetchAll: true, dprCap: 1.5, concurrency: 6 }, // 75 frames ≈ 276 MB
  desktopNormal: { set: "desktop", ahead: 40, behind: 14, prefetchAll: true, dprCap: 1.5, concurrency: 4 }, // 55 frames ≈ 203 MB
  // Mobile: small bounded window (a phone can't hold much decoded); HTTP-cache backed.
  mobileHigh: { set: "mobile", ahead: 9, behind: 3, prefetchAll: false, dprCap: 1, concurrency: 2 }, // 13 frames
  mobileNormal: { set: "mobile", ahead: 7, behind: 3, prefetchAll: false, dprCap: 1, concurrency: 2 }, // 11 frames
} satisfies Record<string, TierConfig>;

type TierName = keyof typeof TIERS;

// Static-fallback frame (low-memory / saveData): a scenic mid-flight still.
const STATIC_SET: SetName = "mobile";
const STATIC_FRAME = Math.round(SETS.mobile.count * 0.4);

const framePath = (set: SetName, i: number) =>
  `${SETS[set].dir}/frame-${String(i + 1).padStart(3, "0")}.webp`;

type RequestIdleCallback = (cb: () => void, opts?: { timeout?: number }) => number;

/** Pick a tier from feature-detected signals; conservative when a signal is absent. */
function detectTier(): "static" | TierName {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const dm = nav.deviceMemory; // Chromium only
  const hc = nav.hardwareConcurrency || 0;
  const conn = nav.connection;
  const saveData = conn?.saveData === true;
  const eff = conn?.effectiveType ?? "";
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  if (saveData || (dm !== undefined && dm <= 2) || /(^|-)2g$/.test(eff)) return "static";
  if (coarse) return (dm !== undefined ? dm >= 6 : hc >= 8) ? "mobileHigh" : "mobileNormal";
  return (dm !== undefined ? dm >= 8 && hc >= 8 : hc >= 12) ? "desktopHigh" : "desktopNormal";
}

export function ScrollSequence() {
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { scrollYProgress } = useScroll();
  // Bridge from the scroll hook / resize listener to the imperative engine.
  const engineRef = useRef<{ onProgress: (p: number) => void; resize: () => void } | null>(null);

  // The whole render/decode engine lives in one effect, closing over per-run
  // locals (no React state → no rerenders on scroll, no stale closures).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduce) return; // reduced motion → Atmosphere is the background
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tierName = detectTier();
    let setName: SetName;
    let ahead = 0;
    let behind = 0;
    let prefetchAll = false;
    let dprCap: number;
    let concurrency = 1;
    let scrub: boolean;
    if (tierName === "static") {
      setName = STATIC_SET;
      dprCap = 1;
      scrub = false;
    } else {
      const t = TIERS[tierName];
      setName = t.set;
      ahead = t.ahead;
      behind = t.behind;
      prefetchAll = t.prefetchAll;
      dprCap = t.dprCap;
      concurrency = t.concurrency;
      scrub = true;
    }
    const count = SETS[setName].count;

    const cache = new Map<number, ImageBitmap>(); // decoded, windowed
    const blobs = new Map<number, Blob>(); // encoded, persistent (cheap)
    const inflight = new Set<number>();
    let target = 0; // round(currentFrame) — drives window management / nearest lookup
    let targetFrame = 0; // raw scroll-derived fractional frame (the goal)
    let currentFrame = 0; // smoothed visual playhead (what is actually rendered)
    let drawn = -1;
    let dir = 1; // +1 forward (scrolling down), -1 backward
    let lastProgress = 0;
    let lastT = 0; // previous rAF timestamp, for delta-time smoothing
    let raf = 0;
    let cancelled = false;

    // Smoothed visual playhead. Instead of mapping raw scroll straight to the visible
    // frame (which quantizes hard), the playhead `currentFrame` eases toward the
    // scroll-derived `targetFrame` every rAF with a time-normalized (refresh-rate-
    // independent) factor, and the renderer draws the nearest frame at that smoothed
    // position. The loop runs until the playhead converges — no idle snap, one head.
    const TAU = 110; // ms — playhead smoothing time constant
    const EPS = 0.004; // frames — convergence threshold to stop the loop

    // Play the sequence across a scoped scroll RANGE — from the bottom of the hero
    // (the check-in/out stats bar) to the "Find us" block at the top of the footer —
    // instead of over the whole document. Anchors are measured in document
    // coordinates and re-measured on reflow/resize.
    let startY = 0;
    let endY = 1;
    const measureRange = () => {
      const vh = window.innerHeight;
      const main = document.querySelector("main");
      const hero = main ? main.querySelector("section") : null;
      const footer = document.querySelector("footer");
      if (hero && footer) {
        const heroBottom = hero.getBoundingClientRect().bottom + window.scrollY;
        const findUs = footer.getBoundingClientRect().top + window.scrollY;
        // frame 0 when the stats bar (hero bottom) passes the viewport centre;
        // last frame when the "Find us" block passes the viewport centre.
        startY = Math.max(0, heroBottom - vh * 0.5);
        endY = Math.max(startY + 1, findUs - vh * 0.5);
      } else {
        startY = 0;
        endY = Math.max(1, document.documentElement.scrollHeight - vh);
      }
    };
    const progressFor = () => {
      const p = (window.scrollY - startY) / (endY - startY);
      return p < 0 ? 0 : p > 1 ? 1 : p;
    };

    const drawBitmap = (bmp: ImageBitmap) => {
      const cw = canvas.width;
      const ch = canvas.height;
      const ir = bmp.width / bmp.height;
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
      ctx.drawImage(bmp, dx, dy, dw, dh);
    };

    // Closest cached frame to a target (or -1 if the cache is empty).
    const nearest = (t: number) => {
      if (cache.has(t)) return t;
      let best = -1;
      let bestDist = Infinity;
      for (const k of cache.keys()) {
        const d = Math.abs(k - t);
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      return best;
    };

    const bounds = (): [number, number] => {
      const a = dir >= 0 ? ahead : behind;
      const b = dir >= 0 ? behind : ahead;
      return [Math.max(0, target - b), Math.min(count - 1, target + a)];
    };
    const inWindow = (i: number) => {
      const [lo, hi] = bounds();
      return i >= lo && i <= hi;
    };

    function schedule() {
      if (!raf && !cancelled) raf = requestAnimationFrame(tick);
    }

    // Encoded-blob fetch, memoised: decode reads from here so a frame is only ever
    // pulled over the network once (then held as a cheap compressed blob).
    const fetchBlob = (i: number): Promise<Blob> => {
      const have = blobs.get(i);
      if (have) return Promise.resolve(have);
      return fetch(framePath(setName, i))
        .then((r) => r.blob())
        .then((b) => {
          if (!cancelled) blobs.set(i, b);
          return b;
        });
    };

    const decode = (i: number) => {
      if (cancelled || cache.has(i) || inflight.has(i)) return;
      inflight.add(i);
      fetchBlob(i)
        .then((b) => createImageBitmap(b))
        .then((bmp) => {
          inflight.delete(i);
          if (cancelled) {
            bmp.close();
            return;
          }
          if (!inWindow(i)) {
            bmp.close(); // stale — user scrolled away before this resolved
            return;
          }
          cache.set(i, bmp);
          schedule(); // draw it if it's now the target; keep the window filling
        })
        .catch(() => {
          inflight.delete(i);
        });
    };

    // Background prefetch of every encoded blob (desktop only) so that, once warm,
    // scrubbing never touches the network. Concurrency-limited and idle-scheduled so
    // it never competes with first paint or the visible window's decodes.
    let blobIdx = 0;
    let blobWorkers = 0;
    const PREFETCH_CONCURRENCY = 4;
    const pumpPrefetch = () => {
      if (cancelled) return;
      while (blobWorkers < PREFETCH_CONCURRENCY && blobIdx < count) {
        const i = blobIdx++;
        if (blobs.has(i)) continue;
        blobWorkers += 1;
        fetchBlob(i)
          .catch(() => {})
          .finally(() => {
            blobWorkers -= 1;
            pumpPrefetch();
          });
      }
    };

    // Evict frames outside the window; decode the missing ones, target-first then
    // outward in the scroll direction, bounded by concurrency.
    const manageWindow = () => {
      const [lo, hi] = bounds();
      for (const [idx, bmp] of cache) {
        if (idx < lo || idx > hi) {
          bmp.close();
          cache.delete(idx);
        }
      }
      if (inflight.size >= concurrency) return;
      if (!cache.has(target) && !inflight.has(target)) decode(target);
      const maxOut = Math.max(hi - target, target - lo);
      for (let d = 1; d <= maxOut && inflight.size < concurrency; d += 1) {
        const fwd = dir >= 0 ? target + d : target - d;
        const bwd = dir >= 0 ? target - d : target + d;
        if (fwd >= lo && fwd <= hi) decode(fwd);
        if (inflight.size < concurrency && bwd >= lo && bwd <= hi) decode(bwd);
      }
    };

    function tick(now: number) {
      raf = 0;
      if (cancelled) return;
      const dt = lastT ? Math.min(now - lastT, 64) : 16; // clamp big gaps (tab wake)
      lastT = now;

      // Ease the playhead toward the target — time-normalized so the motion is the
      // same at 60Hz or 120Hz.
      const k = 1 - Math.exp(-dt / TAU);
      currentFrame += (targetFrame - currentFrame) * k;
      if (Math.abs(targetFrame - currentFrame) < EPS) currentFrame = targetFrame;
      target = Math.round(currentFrame);

      // Nearest-frame render: with 537 genuine interpolated frames the playhead has
      // real intermediate positions to land on, so a single crisp frame per tick
      // reads as travel — no cross-fade (which looked like a dissolve, not motion).
      const want = target < 0 ? 0 : target > count - 1 ? count - 1 : target;
      const exact = cache.get(want);
      if (exact) {
        if (drawn !== want) {
          drawBitmap(exact);
          drawn = want;
        }
      } else {
        const n = nearest(want);
        if (n >= 0 && drawn !== n) {
          const bmp = cache.get(n);
          if (bmp) {
            drawBitmap(bmp);
            drawn = n;
          }
        }
      }

      if (scrub) manageWindow();

      // Keep animating while the playhead is still converging, or frames are still
      // decoding. When settled, stop — no snap (currentFrame is already the target).
      if (Math.abs(targetFrame - currentFrame) > EPS || inflight.size > 0) {
        schedule();
      } else {
        lastT = 0;
      }
    }

    const resize = () => {
      measureRange();
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      drawn = -1; // force a redraw at the new size
      schedule();
    };

    const onProgress = () => {
      if (!scrub) return;
      const lp = progressFor();
      dir = lp >= lastProgress ? 1 : -1;
      lastProgress = lp;
      targetFrame = lp * (count - 1);
      schedule(); // wake the playhead loop; it eases currentFrame toward targetFrame
    };

    engineRef.current = { onProgress, resize };
    resize(); // also measures the scroll range
    if (scrub) {
      lastProgress = progressFor();
      targetFrame = lastProgress * (count - 1);
      currentFrame = targetFrame; // start settled — no ease-in on load
      target = Math.round(currentFrame);
    } else {
      target = STATIC_FRAME < count ? STATIC_FRAME : Math.floor(count / 2);
      currentFrame = target;
      targetFrame = target;
      decode(target);
    }
    schedule();

    // Warm the encoded-blob cache in the background (desktop only), off the critical
    // path so it never delays first paint.
    if (prefetchAll) {
      const ric = (window as Window & { requestIdleCallback?: RequestIdleCallback })
        .requestIdleCallback;
      if (ric) ric(pumpPrefetch, { timeout: 1500 });
      else setTimeout(pumpPrefetch, 600);
    }

    // Re-measure the range when content reflows (e.g. images finish loading and push
    // the footer down), so the end anchor stays on the "Find us" block.
    let ro: ResizeObserver | null = null;
    if (scrub && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        measureRange();
        schedule();
      });
      ro.observe(document.body);
    }

    return () => {
      cancelled = true;
      if (ro) ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      for (const bmp of cache.values()) bmp.close();
      cache.clear();
      blobs.clear();
      inflight.clear();
      engineRef.current = null;
    };
  }, [reduce]);

  // Resize is a window event, kept out of the engine effect so it isn't torn down.
  useEffect(() => {
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Scroll only ever updates the target frame — the rAF loop does the drawing.
  useMotionValueEvent(scrollYProgress, "change", (p) => {
    engineRef.current?.onProgress(p);
  });

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <canvas ref={canvasRef} className="h-full w-full" />
      {/* Moderate scrim so the footage reads as ambient and text stays legible. */}
      <div className="absolute inset-0 bg-pine/62" />
    </div>
  );
}
