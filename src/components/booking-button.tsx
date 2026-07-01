import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { RoomType } from "@/lib/site";

type Variant = "primary" | "outline";

const STYLES: Record<Variant, string> = {
  primary: "bg-amber text-pine hover:bg-amber/90 border border-transparent",
  outline: "border border-paper/30 text-paper hover:border-amber hover:text-amber bg-transparent",
};

/**
 * Every "Book" CTA routes to the on-site booking flow (/book). Optionally
 * preselects a room type. Centralised so the destination is a one-line change.
 */
export function BookingButton({
  variant = "primary",
  className = "",
  children = "Book a bed",
  type,
}: {
  variant?: Variant;
  className?: string;
  children?: React.ReactNode;
  type?: RoomType;
}) {
  return (
    <Link
      href={type ? `/book?type=${type}` : "/book"}
      className={`inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium transition-colors ${STYLES[variant]} ${className}`}
    >
      {children}
      <ArrowUpRight size={16} strokeWidth={2} aria-hidden />
    </Link>
  );
}
