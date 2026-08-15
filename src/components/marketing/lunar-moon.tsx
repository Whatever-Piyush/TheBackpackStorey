"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useReducedMotion } from "framer-motion";

/**
 * LunarMoon — the interactive WebGL moon for the Intro, in place of the photo
 * stack. All of three/r3f is isolated in lunar-scene.tsx and loaded with a
 * client-only dynamic import (`ssr: false`), so the server never touches WebGL.
 * Under reduced motion — and before hydration / while the scene loads — a plain
 * CSS "moon" sphere stands in, so there is always something to see and the heavy
 * scene never runs for people who asked for less motion.
 *
 * The scene stays mounted (so its state survives), but an IntersectionObserver
 * feeds `active` into it: in view → `frameloop="always"`; out of view →
 * `frameloop="never"`, which stops all rendering / useFrame work. A rootMargin
 * warms it up just before it scrolls into view.
 *
 * Tap the moon to release its gravity ring.
 */

const noopSubscribe = () => () => {};

/** Lightweight CSS moon — the SSR / reduced-motion / loading stand-in. */
function MoonStill() {
  return (
    <div
      aria-hidden
      className="aspect-square w-full rounded-full shadow-[0_0_80px_-10px_rgba(180,190,220,0.25)]"
      style={{
        background:
          "radial-gradient(circle at 34% 30%, #e2e2e8 0%, #b7b7c0 34%, #7c7c86 62%, #33333c 84%, #16161c 100%)",
      }}
    />
  );
}

const LunarScene = dynamic(() => import("@/components/marketing/lunar-scene"), {
  ssr: false,
  loading: () => <MoonStill />,
});

export function LunarMoon() {
  const reduce = useReducedMotion();
  // false on the server + first client render, true once mounted (no setState).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  // Pause the WebGL render loop whenever the moon is off-screen. Only observes
  // once the interactive scene is in play (mounted + motion allowed).
  const still = !mounted || reduce;
  useEffect(() => {
    if (still) return;
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[entries.length - 1]?.isIntersecting ?? false),
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [still]);

  return (
    <div ref={containerRef} className="relative mx-auto aspect-square w-full max-w-[30rem]">
      {still ? <MoonStill /> : <LunarScene active={inView} />}
      {!still ? (
        <p className="font-data pointer-events-none absolute inset-x-0 bottom-1 text-center text-[0.7rem] uppercase tracking-[0.2em] text-sage/70">
          Tap the moon
        </p>
      ) : null}
    </div>
  );
}
