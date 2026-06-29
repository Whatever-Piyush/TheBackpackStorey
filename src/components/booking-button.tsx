import { ArrowUpRight } from "lucide-react";
import { SITE } from "@/lib/site";

type Variant = "primary" | "outline";

const STYLES: Record<Variant, string> = {
  primary:
    "bg-amber text-pine hover:bg-amber/90 border border-transparent",
  outline:
    "border border-paper/30 text-paper hover:border-amber hover:text-amber bg-transparent",
};

/**
 * Phase 1: every "Book" CTA points at the existing zotel link.
 * Centralised here so Phase 4 is a one-line swap.
 */
export function BookingButton({
  variant = "primary",
  className = "",
  children = "Book a bed",
}: {
  variant?: Variant;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={SITE.bookingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium transition-colors ${STYLES[variant]} ${className}`}
    >
      {children}
      <ArrowUpRight size={16} strokeWidth={2} aria-hidden />
    </a>
  );
}
