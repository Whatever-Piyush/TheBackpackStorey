import { SITE } from "@/lib/site";
import { formatPaise } from "@/lib/money";

/**
 * Booking confirmations.
 *
 * Email goes through Resend's REST API directly rather than its SDK — one fetch
 * against a documented endpoint doesn't justify a dependency.
 *
 * Email is BEST EFFORT and never blocks a booking: the reservation is already
 * committed by the time this runs, and a mail outage must not tell a guest their
 * booking failed. The WhatsApp link is built locally and always works.
 */

export type Confirmation = {
  ref: string;
  guestName: string;
  email?: string | null;
  roomName: string;
  units: number;
  unitNoun: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalPaise: number;
};

/** Prefilled WhatsApp message carrying the booking code. */
export function whatsappLink(c: Confirmation): string {
  const digits = SITE.whatsapp.replace(/[^\d]/g, "");
  const msg =
    `Hi Backpackers Storey! I've booked (ref ${c.ref}): ` +
    `${c.roomName} ×${c.units}, ${c.nights} night${c.nights === 1 ? "" : "s"}, ` +
    `${c.checkIn} → ${c.checkOut}. Name: ${c.guestName}. Please confirm.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function plain(c: Confirmation): string {
  return [
    `Hi ${c.guestName},`,
    ``,
    `You're booked at ${SITE.name}, Bir.`,
    ``,
    `Reference   ${c.ref}`,
    `Room        ${c.roomName} × ${c.units} ${c.unitNoun}${c.units === 1 ? "" : "s"}`,
    `Arrive      ${c.checkIn} (check-in from ${SITE.checkIn})`,
    `Leave       ${c.checkOut} (check-out by ${SITE.checkOut})`,
    `Nights      ${c.nights}`,
    `Total       ${formatPaise(c.totalPaise)} — payable when you arrive`,
    ``,
    `Nothing to pay now. Bring a photo ID; if you're travelling on a foreign`,
    `passport, please bring your passport and visa.`,
    ``,
    `Finding us: ${SITE.location.line}`,
    `Questions: ${SITE.phones.join(" or ")}`,
    ``,
    `See you under the launch.`,
  ].join("\n");
}

/**
 * Returns true when an email was actually accepted by Resend. A false is not an
 * error the guest should ever see.
 */
export async function sendConfirmationEmail(c: Confirmation): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_FROM_EMAIL;

  // Not configured yet — the WhatsApp link still carries the booking.
  if (!key || !from || !c.email) return false;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [c.email],
        subject: `Booking ${c.ref} — ${SITE.name}`,
        text: plain(c),
      }),
      // A slow mail provider must not hold the guest's browser open.
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
