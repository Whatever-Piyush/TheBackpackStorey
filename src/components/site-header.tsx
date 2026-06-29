"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { NAV, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex flex-col leading-none">
      <span className="font-display text-lg font-extrabold tracking-tight text-paper">
        Backpackers <span className="text-amber">Storey</span>
      </span>
      <span className="font-data text-[0.6rem] uppercase tracking-[0.2em] text-sage/70 transition-colors group-hover:text-sage">
        Bir · {SITE.coords.lat.toFixed(2)}°N
      </span>
    </Link>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b hairline bg-pine/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 sm:px-8">
        <Wordmark />

        <nav className="hidden items-center gap-7 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-sage transition-colors hover:text-paper"
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
        <nav className="border-t hairline bg-forest px-5 py-4 md:hidden">
          <ul className="flex flex-col gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2 py-2.5 text-base text-paper hover:bg-moss"
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
