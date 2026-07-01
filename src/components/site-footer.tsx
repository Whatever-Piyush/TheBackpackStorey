import Link from "next/link";
import { MapPin, MessageCircle, Navigation, Phone } from "lucide-react";
import { GETTING_HERE, MAPS, NAV, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";
import { Reveal } from "@/components/reveal";

const digits = (s: string) => s.replace(/[^\d]/g, "");

const waLink = `https://wa.me/${digits(SITE.whatsapp)}?text=${encodeURIComponent(
  "Hi Backpackers Storey! I'd like to ask about a booking.",
)}`;

export function SiteFooter() {
  return (
    <footer id="visit" className="border-t hairline bg-forest">
      {/* find us — map + directions */}
      <div className="border-b hairline">
        <Reveal className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-2 md:items-center">
          <div>
            <h3 className="font-data text-xs uppercase tracking-[0.18em] text-amber">Find us</h3>
            <p className="mt-3 font-display text-2xl font-extrabold tracking-tight text-paper">
              Bir, Himachal Pradesh
            </p>
            <p className="mt-3 flex items-start gap-2.5 text-sm text-sage">
              <MapPin size={18} strokeWidth={1.6} className="mt-0.5 shrink-0 text-sage/60" />
              {SITE.location.line}
            </p>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-sage">{GETTING_HERE}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={MAPS.directions}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
              >
                <Navigation size={16} /> Get directions
              </a>
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-paper/30 px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-amber hover:text-amber"
              >
                <MessageCircle size={16} /> WhatsApp us
              </a>
            </div>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-card border hairline shadow-2xl">
            <iframe
              src={MAPS.embed}
              title="Map — Backpackers Storey, Bir"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
              className="absolute inset-0 h-full w-full grayscale-[0.2] transition-all duration-500 hover:grayscale-0"
              style={{ border: 0 }}
            />
          </div>
        </Reveal>
      </div>

      {/* columns */}
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        {/* brand + book */}
        <div>
          <p className="font-display text-2xl font-extrabold tracking-tight text-paper">
            Backpackers <span className="text-amber">Storey</span>
          </p>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-sage">
            {SITE.tagline}. {SITE.location.area}, {SITE.location.region}.
          </p>
          <p className="font-data mt-4 text-xs text-sage/70">
            {SITE.coords.lat.toFixed(4)}°N · {SITE.coords.lng.toFixed(4)}°E · ↑{" "}
            {SITE.elevation.property.toLocaleString("en-IN")} m
          </p>
          <BookingButton className="mt-6" />
        </div>

        {/* visit */}
        <div>
          <h3 className="font-data text-xs uppercase tracking-[0.18em] text-amber">Visit</h3>
          <ul className="mt-4 space-y-3 text-sm text-sage">
            <li className="flex gap-2.5">
              <MapPin size={18} strokeWidth={1.6} className="mt-0.5 shrink-0 text-sage/60" />
              <span>{SITE.location.line}</span>
            </li>
            <li>
              Check-in <span className="text-paper">{SITE.checkIn}</span> · Check-out{" "}
              <span className="text-paper">{SITE.checkOut}</span>
            </li>
            <li>
              <a href={MAPS.directions} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 hover:text-paper">
                <Navigation size={16} className="text-sage/60" /> Get directions
              </a>
            </li>
          </ul>
        </div>

        {/* talk + explore */}
        <div>
          <h3 className="font-data text-xs uppercase tracking-[0.18em] text-amber">Talk to us</h3>
          <ul className="mt-4 space-y-3 text-sm text-sage">
            {SITE.phones.map((p) => (
              <li key={p}>
                <a href={`tel:${digits(p)}`} className="inline-flex items-center gap-2.5 hover:text-paper">
                  <Phone size={18} strokeWidth={1.6} className="text-sage/60" />
                  {p}
                </a>
              </li>
            ))}
            <li>
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2.5 hover:text-paper"
              >
                <MessageCircle size={18} strokeWidth={1.6} className="text-sage/60" />
                WhatsApp
              </a>
            </li>
          </ul>

          <h3 className="font-data mt-8 text-xs uppercase tracking-[0.18em] text-amber">Explore</h3>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-sage">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="hover:text-paper">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t hairline">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-5 text-xs text-sage/60 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>
            © {new Date().getFullYear()} {SITE.name}. {SITE.location.area}, {SITE.location.region}, India.
          </span>
          <span className="font-data">A hostel under the launch.</span>
        </div>
      </div>
    </footer>
  );
}
