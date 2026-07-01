"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Photo } from "@/lib/site";

export function GalleryLightbox({ photos }: { photos: Photo[] }) {
  const [index, setIndex] = useState<number | null>(null);
  const open = index !== null;
  const touchX = useRef<number | null>(null);

  const close = useCallback(() => setIndex(null), []);
  const go = useCallback(
    (dir: number) =>
      setIndex((i) => (i === null ? i : (i + dir + photos.length) % photos.length)),
    [photos.length],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close, go]);

  return (
    <>
      {/* grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((p, i) => (
          <button
            key={p.src}
            type="button"
            onClick={() => setIndex(i)}
            className="group relative aspect-[3/4] overflow-hidden rounded-xl border hairline"
            aria-label={`Open photo ${i + 1}`}
          >
            <Image
              src={p.src}
              alt={p.alt}
              fill
              sizes="(min-width:1024px) 24vw, (min-width:640px) 33vw, 50vw"
              className="object-cover transition-transform duration-500 ease-out group-hover:scale-110"
            />
            <span className="pointer-events-none absolute inset-0 bg-pine/0 transition-colors duration-300 group-hover:bg-pine/25" />
          </button>
        ))}
      </div>

      {/* lightbox */}
      {open ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-pine/95 p-4 backdrop-blur-sm sm:p-8"
          onClick={close}
          role="dialog"
          aria-modal="true"
          onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
            touchX.current = null;
          }}
        >
          <button
            type="button"
            onClick={close}
            className="absolute right-4 top-4 rounded-full border hairline bg-pine/60 p-2 text-paper transition-colors hover:border-amber hover:text-amber"
            aria-label="Close"
          >
            <X size={20} />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border hairline bg-pine/60 p-2 text-paper transition-colors hover:border-amber hover:text-amber sm:left-6"
            aria-label="Previous"
          >
            <ChevronLeft size={24} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); go(1); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border hairline bg-pine/60 p-2 text-paper transition-colors hover:border-amber hover:text-amber sm:right-6"
            aria-label="Next"
          >
            <ChevronRight size={24} />
          </button>

          <figure
            key={index}
            className="animate-[fadeZoom_.25s_ease-out] flex max-h-full max-w-5xl flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative h-[74vh] w-[92vw] max-w-5xl">
              <Image
                src={photos[index].src}
                alt={photos[index].alt}
                fill
                sizes="92vw"
                className="object-contain"
                priority
              />
            </div>
            <figcaption className="mt-3 flex items-center gap-3 text-center text-sm text-sage">
              <span className="font-data text-amber">
                {index + 1}/{photos.length}
              </span>
              <span className="max-w-xl">{photos[index].alt}</span>
            </figcaption>
          </figure>
        </div>
      ) : null}
    </>
  );
}
