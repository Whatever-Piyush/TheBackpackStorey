# Website.md — Planned changes (for review)

> **Purpose:** this is a *proposal to review*, not done work. Nothing here is implemented yet.
> Once you approve (and answer the **Decisions** below), I'll build it all together.
> Prepared 2026-07-02.

---

## ⚠️ Decisions I need from you first

These change what I build, so please pick before I start:

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | **Booking payment** | **A)** Reserve now, **pay at property** (no gateway) · **B)** **Online payment** via Cashfree (needs a Cashfree account + keys + webhook) | **A** now — smallest correct system, works today; add B later |
| **D2** | **Room rates** (needed to show prices & totals — the DB has no price column today) | You give me the nightly ₹ for dorm-bed / deluxe / premium / family · **or** I set editable placeholders you fix in the PMS | You send real rates; I'll make them editable anyway |
| **D3** | **Attraction photos** | I source **free-license** stock (Unsplash/Pexels — free for commercial, no attribution) · **or** you provide real photos of each spot | I source stock now; swap for real later |
| **D4** | **Google Maps** | **Basic embed** (iframe, no API key) + "Get directions" link · **or** richer interactive map (needs a Maps API key) | Basic embed — free, no key, looks clean |

> **Note:** the booking system **reverses the earlier "Phase 4 dropped / stay on zotel" decision.** That's fine — just flagging it. I'll update the project notes when built.

---

## Scope at a glance

| # | Section (screenshot) | What changes | Type |
|---|---|---|---|
| 1 | Hero info bar (Check-in/out · coords) | Make it a prominent, aesthetic info strip | Design |
| 2 | Intro "Tiny on purpose" (`8cy9eG`) | Aesthetic + eye-catching, scroll/hover animation | Design |
| 3 | **Booking system** (`lDFjqa`) | **Direct on-site booking for rooms + dorms; remove zotel** | Feature |
| 4 | "Around Bir" (`lDFjqa`/`FpVtJK`) | Replace generic cards with **real nearby attractions + photos + distances + directions** | Content+Design |
| 5 | Gallery "Have a look around" (`IH0MKZ`) | Hover animations **+ a real lightbox** (open, next/prev, swipe, keyboard) | Feature+Design |
| 6 | Footer / "Visit" (`6gNuUD`) | More detail, **WhatsApp** (prefilled) + **Google Maps** embed, animations | Feature+Design |
| 7 | Global | Scroll-reveal animation helper; commit the already-done header/tag/café polish | Infra |

No new heavy dependencies — date pickers, lightbox and animations built in-house (native inputs + a tiny IntersectionObserver helper) to stay right-sized.

---

## 1. Hero info bar — make the key info prominent

**Now:** a thin, dim line at the bottom of the hero: `Check-in 2:00 PM · Check-out 11:00 AM · 32.0419°N · 76.7197°E` in small `sage` text.

**Plan:** turn it into a row of **icon info-chips** (Check-in, Check-out, Elevation, Coordinates), larger text, brighter, with the glassy `backdrop-blur` treatment and a subtle hover highlight (reusing the `.capsule` feel). Reads as "important facts," not fine print.

- **Files:** `src/app/(marketing)/page.tsx` (hero footer block).

---

## 2. Intro "Tiny on purpose" — aesthetic + eye-catching

**Now:** text left, two staggered images right; static.

**Plan:**
- **Reveal-on-scroll** animation (fade + rise) for the heading, paragraphs, and images (staggered).
- Images get **hover zoom + lift + shadow** and rounded framing consistent with the café strip; add a small floating **stat badge** (e.g. "6-bed dorm · a few private rooms · rooftop café").
- Tighten spacing/hierarchy so the headline pops.

- **Files:** `src/app/(marketing)/page.tsx`, new `src/components/reveal.tsx` (see §7).

---

## 3. Booking system — direct bookings (replaces zotel) 🚀

The biggest item. Goal: guests book **rooms and dorm beds** on the site; no zotel.

### What already exists (good news)
- Tables `bookings`, `guests`, `rooms`, `beds` with **anti-double-booking exclusion constraints** already enforced in Postgres.
- `bookings.source` supports `'website'`; `payments` table already models `cash/upi/card/cashfree`.

### What's missing → I'll add
- **Room rates.** The `rooms` table has **no price**. New migration `0004_rates.sql` adds `price_per_night_paise` to `rooms` (dorm row = per-bed price; private rows = per-room), seeded from **D2**. Editable later in the PMS.
- **Public write path.** Website visitors aren't staff, and RLS blocks writes. A **server-side booking action using the service-role key** (validates input, re-checks availability, then inserts) — the standard safe pattern for public forms.

### Flow (per D1 = "reserve, pay at property")
1. **Booking widget** (on `/rooms` and a new `/book`, plus the "Book a bed" CTAs):
   - pick **check-in / check-out** (native date inputs), **room type**, **guests**.
2. **Check availability** (server): for private rooms → no overlapping active booking; for dorm → free beds among the 6. Shows price = nights × rate.
3. **Guest details:** name, phone, email.
4. **Confirm** → server action creates `guests` + `bookings` row (`source='website'`, `status='reserved'`, dorm gets a real `bed_id`), protected by the DB exclusion constraints as a final guard.
5. **Confirmation screen** + a **WhatsApp "confirm my booking" deep link** and (optional) email. Booking then appears in the same `bookings` table the PMS (Phase 3) will manage.

> If you pick **D1 = B (Cashfree)**, I add: a Cashfree order route, a hosted-checkout redirect, a `payments` row, and a webhook Route Handler to mark paid → booking `reserved`→confirmed. Requires your Cashfree keys.

### Removing zotel
- `SITE.bookingUrl` (zotel) retired; `BookingButton` routes to the on-site booking. Phone/WhatsApp kept as fallback.

- **Files:** `supabase/migrations/0004_rates.sql`; `src/lib/booking/{availability,actions,types}.ts`; `src/components/booking/*` (widget, date fields, summary, confirmation); `src/app/book/page.tsx`; edits to `src/components/booking-button.tsx`, `src/lib/site.ts`, `src/app/(marketing)/rooms/*`.

---

## 4. "Around Bir" → real nearby attractions

**Now:** three generic cards (Paragliding / Monasteries / Bonfire), no images.

**Plan:** a **Nearby attractions** grid — each card has a **photo, name, one-liner, distance, and a "Directions" (Google Maps) link**, with hover lift/zoom + scroll reveal.

Proposed data (`ATTRACTIONS` in `site.ts`):

| Place | Distance | Blurb |
|---|---|---|
| **Gunehar Waterfall** | 1.5 km | Scenic waterfall hidden in the forest, reached by a short trek — a refreshing nature escape. |
| **Bir Landing Site** | 2 km | The famous paragliding landing field, ringed by mountains with breathtaking sunset views. |
| **Bir Billing Paragliding (Takeoff, Billing)** | 2.1 km | World-famous takeoff; tandem flights and schools over scenic valleys. |
| **Bungee Jumping** | ~2 km | A 50 m jump with full safety gear (₹≈3,300, video included). |
| **Sky Cycling** | ~2 km | A 500 m sky-cycle ride across the valley (₹≈2,500, video included). |

- Photos sourced per **D3**, stored in `public/photos/nearby/`.
- Adventure details from live sources ([travelbirbilling](https://www.travelbirbilling.com/tours/activities-birbilling/), [Paramountains — 7 Activities in Bir Billing](https://paramountains.in/activities-in-bir-billing/)); I'll re-verify distances/prices at build time.
- **Files:** `src/lib/site.ts` (new `ATTRACTIONS`), `src/app/(marketing)/page.tsx`, `public/photos/nearby/*`.

---

## 5. Gallery "Have a look around" → animated + real lightbox

**Now:** a static grid; images only scale slightly on hover.

**Plan:**
- **Hover polish:** lift, zoom, a soft caption overlay; scroll-reveal as the grid enters.
- **Lightbox** (`src/components/lightbox.tsx`, client): click any photo → full-screen viewer with **next/prev arrows**, **keyboard** (← → Esc), **touch swipe**, **caption + counter (e.g. 4/13)**, animated fade/zoom open, background scroll lock.
- **Files:** `src/components/lightbox.tsx`, `src/app/(marketing)/page.tsx` (gallery wired to lightbox).

---

## 6. Footer / "Visit" — WhatsApp + Google Maps + detail

**Now:** address text, check-in/out, phone links, a plain "WhatsApp" text link.

**Plan:**
- **WhatsApp:** prominent branded button with a **prefilled message** ("Hi Backpackers Storey, I'd like to book…") → `wa.me` deep link.
- **Google Maps:** an **embedded interactive map** of the property (D4 = keyless iframe) + a **"Get directions"** button.
- **More detail:** a short **"Getting here"** note (nearest airport Gaggal/Dharamshala, bus/taxi), hours, socials if you have them.
- **Animations:** columns fade/slide in on scroll; hover states on every link; map subtly reveals.
- **Files:** `src/components/site-footer.tsx`, `src/lib/site.ts` (map URL, getting-here text).

---

## 7. Global — animation helper + housekeeping

- **`src/components/reveal.tsx`** — a tiny client wrapper using IntersectionObserver that fades/rises children in on scroll (respects `prefers-reduced-motion`). Reused across §1–§6. Keeps animations consistent and dependency-free.
- **Commit the current uncommitted polish** (bigger header, enlarged section tags, café redesign) either first or alongside this batch.
- **Update project memory** to record the zotel→direct-booking reversal and the new booking module.

---

## Build order (once approved)

1. `reveal.tsx` helper + commit pending polish
2. Migration `0004_rates.sql` + rates → booking availability + actions → booking widget + `/book` → retire zotel  *(depends on D1, D2)*
3. Nearby attractions (data + photos + cards)  *(depends on D3)*
4. Gallery lightbox + hover polish
5. Footer WhatsApp + Maps + detail  *(depends on D4)*
6. Hero info bar + intro polish
7. Full `npm run build`, verify each on localhost, then commit + push

---

## Open questions recap
- **D1** payment: reserve-at-property (rec.) or Cashfree online?
- **D2** rates: send me dorm/deluxe/premium/family nightly ₹, or placeholders?
- **D3** attraction images: I source free stock, or you provide?
- **D4** maps: keyless embed (rec.) or API-key map?

Reply with D1–D4 (and any tweaks to the above) and I'll implement the whole thing.
