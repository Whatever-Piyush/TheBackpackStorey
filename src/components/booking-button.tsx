import Link from "next/link";
import { ArrowUpRight, MessageCircle } from "lucide-react";
import { BOOKING_PAUSED } from "@/lib/launch";
import { getRoom, whatsappEnquiryLink, type RoomType } from "@/lib/site";

type Variant = "primary" | "outline";

const STYLES: Record<Variant, string> = {
  primary: "bg-amber text-pine hover:bg-amber/90 border border-transparent",
  outline: "border border-paper/30 text-paper hover:border-amber hover:text-amber bg-transparent",
};

const BASE =
  "inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium transition-colors";

/**
 * Every "Book" CTA routes to the on-site booking flow (/book). Optionally
 * preselects a room type. Centralised so the destination is a one-line change.
 *
 * While BOOKING_PAUSED (the portfolio launch) the same button is a WhatsApp
 * enquiry instead: `children` is ignored in favour of a fixed enquiry label, and
 * the prefilled message names the room when `type` is given. Call sites keep
 * their original labels, so un-pausing restores them untouched.
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
  if (BOOKING_PAUSED) {
    const room = type ? getRoom(type) : undefined;
    const message = room
      ? `Hi Backpackers Storey! I'd like to ask about the ${room.name}.`
      : undefined;
    return (
      <a
        href={whatsappEnquiryLink(message)}
        target="_blank"
        rel="noopener noreferrer"
        className={`${BASE} ${STYLES[variant]} ${className}`}
      >
        Enquire on WhatsApp
        <MessageCircle size={16} strokeWidth={2} aria-hidden />
      </a>
    );
  }

  return (
    <Link
      href={type ? `/book?type=${type}` : "/book"}
      className={`${BASE} ${STYLES[variant]} ${className}`}
    >
      {children}
      <ArrowUpRight size={16} strokeWidth={2} aria-hidden />
    </Link>
  );
}
