import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Check, Phone } from "lucide-react";
import { ElevationTag } from "@/components/elevation-tag";
import { BookingLookup } from "@/components/booking/booking-lookup";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Your booking",
  // A booking reference is not something search engines should hold.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Booking lookup (ROADMAP M4 item 4).
 *
 * The code alone is short enough to guess, and a stay tells you who is in the
 * building — so the phone number the booking was made with is required too. The
 * page itself never reveals whether a code exists; only a matching pair does.
 */
export default async function BookingPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return (
    <section className="mx-auto max-w-xl px-5 py-16 sm:px-8 sm:py-20">
      <ElevationTag label="Your booking" elevation={SITE.elevation.property} />
      <h1 className="mt-5 font-display text-3xl font-extrabold leading-tight tracking-tight text-paper sm:text-4xl">
        Find your stay
      </h1>
      <p className="mt-4 text-base leading-relaxed text-sage">
        Enter the phone number you booked with. We ask for both so nobody else
        can look up your stay with just the reference.
      </p>

      <div className="mt-8">
        <BookingLookup code={decodeURIComponent(code)} />
      </div>

      <div className="mt-10 space-y-3 border-t hairline pt-6 text-sm text-sage">
        <p className="flex items-center gap-2">
          <CalendarDays size={15} className="text-amber" aria-hidden />
          Check-in from {SITE.checkIn} · check-out by {SITE.checkOut}
        </p>
        <p className="flex items-center gap-2">
          <Check size={15} className="text-amber" aria-hidden />
          Nothing to pay online — settle it when you arrive.
        </p>
        <p className="flex items-center gap-2">
          <Phone size={15} className="text-amber" aria-hidden />
          Can&apos;t find it?{" "}
          <a href={`tel:${SITE.phones[0].replace(/[^\d]/g, "")}`} className="hover:text-paper">
            {SITE.phones[0]}
          </a>
        </p>
        <p>
          <Link href="/book" className="text-amber hover:underline">
            Book another stay
          </Link>
        </p>
      </div>
    </section>
  );
}
