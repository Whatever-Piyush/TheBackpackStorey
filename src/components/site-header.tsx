"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { NAV, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex flex-col leading-none">
      <span className="font-display text-xl font-extrabold tracking-tight text-paper sm:text-2xl">
        Backpackers <span className="text-amber">Storey</span>
      </span>
      <span className="font-data mt-1 text-[0.7rem] uppercase tracking-[0.22em] text-sage transition-colors group-hover:text-amber">
        Bir · {SITE.coords.lat.toFixed(2)}°N
      </span>
    </Link>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    // The view-transition name anchors the header during page transitions —
    // content slides beneath it while the bar itself stays put (globals.css).
    <header
      style={{ viewTransitionName: "site-header" }}
      // Glass bar: same pine tint, just more translucent so the frosted blur
      // reads, with a faint top light-edge for the sheen. Colour is unchanged.
      className="sticky top-0 z-50 border-b hairline bg-pine/55 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] backdrop-blur-xl backdrop-saturate-150"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
        <Wordmark />

        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-base font-medium text-sage underline-offset-8 transition-colors hover:text-paper hover:underline hover:decoration-amber hover:decoration-2"
            >
              {item.label}
            </Link>
          ))}
          <BookingButton className="ml-1" />
        </nav>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-paper md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {open ? (
        <nav className="border-t hairline bg-pine/70 px-5 py-4 backdrop-blur-xl md:hidden">
          <ul className="flex flex-col gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2 py-3 text-lg font-medium text-paper hover:bg-moss"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <BookingButton className="mt-3 w-full justify-center" />
        </nav>
      ) : null}
    </header>
  );
}
