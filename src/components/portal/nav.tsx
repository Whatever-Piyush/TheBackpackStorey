"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";

/**
 * Portal top nav. Client-side only so it can read the active segment — the
 * segment one level below the portal layout is exactly "pos" | "stays".
 */
export function PortalNav({ items }: { items: { href: string; label: string }[] }) {
  const segment = useSelectedLayoutSegment();

  return (
    <nav className="flex items-center gap-1">
      {items.map((item) => {
        const active = item.href === `/${segment}`;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
              active
                ? "bg-amber/12 font-medium text-amber ring-1 ring-inset ring-amber/30"
                : "text-sage hover:bg-paper/5 hover:text-paper"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
