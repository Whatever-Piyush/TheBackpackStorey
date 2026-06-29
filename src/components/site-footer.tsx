import Link from "next/link";
import { Phone, MessageCircle, MapPin } from "lucide-react";
import { NAV, SITE } from "@/lib/site";
import { BookingButton } from "@/components/booking-button";

const digits = (s: string) => s.replace(/[^\d]/g, "");

export function SiteFooter() {
  return (
    <footer id="visit" className="border-t hairline bg-forest">
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
                href={`https://wa.me/${digits(SITE.whatsapp)}`}
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
