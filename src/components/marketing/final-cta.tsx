import { SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { ElevationTag } from "@/components/elevation-tag";

export function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24 text-center sm:px-8">
      <ElevationTag label="Come up" elevation={SITE.elevation.property} className="mx-auto" />
      <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
        A bed, a bonfire and a valley to wake up to.
      </h2>
      <div className="mt-8 flex justify-center">
        <BookingButton>Book a bed</BookingButton>
      </div>
      <p className="font-data mt-5 text-sm text-sage">
        or call{" "}
        <a href={`tel:${SITE.phones[0].replace(/[^\d]/g, "")}`} className="text-amber hover:text-paper">
          {SITE.phones[0]}
        </a>
      </p>
    </section>
  );
}
