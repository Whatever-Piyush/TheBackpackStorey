# Backpackers Storey — Roadmap to Launch

Save as `docs/ROADMAP.md`. Milestones ship in order; each has a Claude Code prompt at the end
of its section. Nothing here changes the frozen foundation.

---

## 0. Where you actually are

From the screenshots and the live site:

| Piece | State |
|---|---|
| Marketing site (localhost) | Done, and good. Home, rooms, café, attractions, amenities, gallery, map. |
| Room detail pages | Done. |
| Booking page | 3-step shell (Dates → Room → Details). Native date inputs, no availability, no submit path. |
| Café POS — menu management | Done, real prices, station routing, availability toggles. |
| Café POS — new order | Done. |
| Café POS — KOT, Today | Placeholder. |
| Stays / PMS | Placeholder page only. |
| Auth + owner/staff gating | Live. |
| `backpackerstorey.in` | **Still running Zotel.** Every "Book Now" on the live domain points at `zotel.ai`. |

That last row is the real launch task. You are not launching a website; you are **replacing a
paid vendor** that currently owns the domain's booking flow. Check what the owner is paying
Zotel and when it renews — that's the deadline that matters, and the number that justifies
this whole project to him.

### The property, in numbers

**9 sellable units.** 6 dorm beds + 3 private rooms. Three staff, all doing everything.

Nine units is small enough that several things you'd normally build become unnecessary. A
14-day board is a 9×14 grid — it fits on one screen with no virtualisation, no paging, no
drag-and-drop library. Manual OTA entry is 30 seconds a booking. Say no to anything that only
pays off at 40+ rooms.

---

## 1. Blockers — resolve these with the owner before writing code

**1. How many private rooms, and do they have attached bathrooms?**
Your new site lists Deluxe, Premium, Family. The live site's FAQ says *"a 6-bed dormitory and
2 private classic rooms, both without attached washrooms"* — while your Premium Room page
promises "Attached bathroom". One of these is wrong. A guest who books on that promise and
finds a shared bathroom leaves a one-star review and asks for a refund. Get it in writing.

**2. Real rates per room type, and the dorm bed rate.**
Everything downstream — the rate calendar seed, the GST slab, the quote — needs these.

**3. GST registration status.**
Post-22 Sept 2025 the slabs are: <cite index="14-1">rooms under ₹1,000/night are exempt, ₹1,001–₹7,500 attract 5% without input tax credit, and above ₹7,500 is 18% with full ITC</cite>. So a ₹600 dorm bed and a ₹1,800 private room are on **different slabs in the same booking** — which is exactly why `tax_rate` lives per folio line, not as a constant.
But first: **if they are not GST-registered, they must not charge or show GST at all.** Collecting tax without registration is an offence, not a rounding error. Ask before building any tax line.

**4. Pay-on-arrival, or take a deposit?**
Your booking page currently says *"you pay when you arrive."* That is a legitimate choice and
it keeps Razorpay KYC off the critical path — recommend keeping it for launch. But at 9 units
in peak season, one no-show on a Saturday is a real loss. Mitigation without a gateway:
confirmation on WhatsApp with a reply-to-confirm, and reception releases unconfirmed peak-date
bookings 48h out. Add prepay later, only for peak dates.

**5. Bugs to fix while you're in there.**
- Premium Room page renders `Private · sleeps 2-3 · sleeps 3` — duplicated field.
- Nav CTA says "Book a bed" but you also sell private rooms.
- Live site's Dormitory Room description says "Private Room" and "Private Entrance". Copy-paste from a private room.

---

## 2. The availability design (your headline requirement)

You want: *the room is always visible, bookable only on free dates, and if an MMT booking took
it, the site says "you just missed it."*

### What is not possible

You cannot build the channel manager yourself. MMT/Goibibo's extranet requires you to **pick a
certified channel manager from a dropdown** — there's no open API for a single property to
self-connect. And calendar/iCal sync on Booking.com, MMT and Goibibo is offered for
apartments, homestays and vacation rentals, not hotel/hostel property types. Anyone who tells
you otherwise is selling you a channel manager.

So there are two honest options, and at 9 units the free one is genuinely correct:

**Option A — allotment + manual OTA entry (free, do this).**
Carve out a fixed slice of inventory that only the website may sell, and close those units in
every OTA extranet. The website can never oversell, because it can never touch OTA inventory.
Then every OTA booking gets typed into the PMS by whoever reads the email — 30 seconds, and
with 3 staff and 9 units it is completely tractable. The board then shows true occupancy.

**Option B — subscribe to a channel manager (₹1–2.5k/month).**
Only worth it when they're regularly running near-full and losing revenue to the allotment
split. Most affordable Indian CMs don't expose an API your PMS could read, so this likely
means the CM becomes the master and your PMS reads its email/report output. Revisit after a
season of real data — not now.

### What you build

```
public_availability(p_room_type, p_from, p_to)
  → per date: free_units, is_bookable, price
```

`free_units` = physical units with no allocation covering that date, capped by
`direct_allotment` for that date. The room page always renders; the calendar marks each date
available / full / closed. Guests see the room year-round, book only green dates — exactly
what you asked for.

**The "you just missed it" path already exists.** It's the `23P01` from the exclusion
constraint in the foundation. Two guests hit Reserve on the last bed; one wins, the other gets
a typed `UNIT_TAKEN`, and the UI shows *"Someone just booked that — here's what's still free
for your dates."* Never a stack trace, never a silent failure.

---

## 3. Milestones

### M1 — Finish the Café POS (start here)

It's the closest thing to done, it needs no DNS change, no gateway, no OTA decisions, and it
can be in real hands in the café this week. That gets the system into daily use and gives you
feedback from the three people who'll actually run it, before you build eight more screens on
assumptions.

```text
Read docs/foundation.md, docs/reception-definitions.md and docs/ROADMAP.md first.
Foundation is frozen; schema changes are additive from the next migration number.

Finish the Café POS. Menu management and New order are already built — do not rebuild them.

1. Kitchen display (KOT) at /pos/kitchen
   Live ticket board, one card per order, items grouped by station (Coffee / Kitchen / Bar)
   using the station field that already exists on menu items. Tap an item to advance it:
   queued → preparing → ready. Order auto-advances to ready when all items are ready.
   Realtime via Supabase channel, with a 20s polling fallback — the café is on hill internet
   and the socket will drop. Big touch targets; this runs on a phone propped in a kitchen.
   No prices anywhere on this screen.

2. Charge to room
   On an open order, "charge to room" lists currently checked-in guests and posts the order
   total to that guest's open folio as folio_items with kind='food' and source='pos'.
   If no guest is checked in, the option is hidden, not disabled-with-a-tooltip.

3. Today at /pos/today
   Orders today, totals by payment method, open vs settled, and a "close day" action that
   snapshots the totals. Owner role only.

Every screen: empty, loading, error, retry. Tablet and phone first.
Stop after this. Show the diff and how to test.
```

---

### M2 — Stays console

The 9×14 board, check-in, check-out, folio settlement. Right-sized: no drag-and-drop library,
no virtualisation. Click a cell, act on it.

```text
Build the Stays console at /stays. Foundation is frozen.

1. Board — /stays/board
   Grid: 9 units down the side (dorm beds nested under the dorm room), 14 days across.
   Cells show booking / maintenance block / free, guest name spanning the stay.
   Click a booking → reservation drawer. Click empty cells → block, or create a booking.
   Move a booking to another unit of the same type via a drawer action, not drag —
   at 9 rows a select is faster and works on a phone.
   All moves go through moveAllocation. On 23P01, show which reservation is in the way.
   One query for the whole visible range.

2. Arrivals & check-in — /stays/arrivals
   Today's expected arrivals plus anyone unarrived from earlier. Search name/phone/code.
   Check-in drawer: confirm or change unit, capture guest details, ID upload to a PRIVATE
   Supabase bucket (signed URLs only, never public), set checked_in, log event.
   Foreign nationals: capture nationality, passport no./issue/expiry, visa no./type/expiry,
   date of arrival in India, arrived from, next destination. Show these fields only when
   nationality is not India. Bir gets heavy international paragliding traffic and
   accommodation providers must report foreign guests to the Bureau of Immigration —
   capture now, CSV export, no automated submission until we confirm the current process.
   A multi-unit reservation checks in as one action.

3. Departures & checkout — /stays/departures
   Folio statement: items, total, paid, balance. No invoice number and no tax line yet —
   GST status is unconfirmed. Collect cash/UPI/card, allow a discount line with a required
   reason, settle folio, set checked_out, mark units dirty, log events.
   Block checkout if a café order is still open against the folio — show it, don't hide it.

4. In-house & extend stay — /stays/in-house
   Extend: attempt to widen the allocation's daterange. On 23P01, find same-type units free
   for the extra nights and offer a move, or a split stay with an explicit warning that the
   guest changes beds. Post extra nights at current calendar rates.
   Also: shorten stay, cancel, no-show, add a manual charge.

5. Housekeeping
   Not a module. A filter on the board plus a clean/dirty toggle, using the housekeeping
   column already on rooms.

Stop after each numbered item for review.
```

---

### M3 — Real-time public availability

```text
Make the public site sell real inventory.

1. public_availability(p_room_type uuid, p_from date, p_to date) returns json
   Per date: free_units (physical free, capped by direct_allotment), is_bookable, price
   from the rate calendar. SECURITY DEFINER, search_path pinned, execute granted to anon.
   Returns NO guest data, NO unit ids, NO reservation info — a public endpoint returns
   counts and prices and nothing else.

2. Room pages
   Always render, regardless of availability. Add a month calendar: green available,
   grey full, struck-through closed. Nightly price on hover. Page forward 12 months.

3. Booking flow — replace the native date inputs
   Date range picker driven by the same availability data, so unavailable dates cannot be
   selected in the first place. Separate the guest count control: for a dorm it's number of
   beds, for a private room it's occupancy. The current single "Guests" spinner conflates
   these and will produce wrong quotes.
   Quote from the rate calendar with a per-night breakdown.

4. Fix while you're here: Premium Room renders "sleeps 2-3 · sleeps 3" — duplicated field.

Stop.
```

---

### M4 — Booking submission

```text
1. POST /api/book — server route, service role, never called from the browser with the
   anon key. Zod-validate everything. Rate limit by IP. Idempotency key so a double-click
   or a retry on flaky hill internet cannot create two reservations.

2. Calls create_reservation. On UNITS_TAKEN return a typed error and render:
   "Someone just booked that — here's what's still free for your dates", with the
   re-queried availability inline. Never a stack trace, never a silent failure.

3. Confirmation: email via Resend, plus a WhatsApp deep link with the booking code.
   Pay-on-arrival, so no gateway in this milestone.

4. Booking lookup at /booking/[code] — requires code AND the phone number used to book.
   Code alone is enumerable.

Stop.
```

---

### M5 — OTA control

```text
1. Allotment grid — /stays/allotment, owner only. Room type × date, editable number,
   bulk-set a date range. This is the only thing the public booking engine may sell from.

2. OTA booking entry — /stays/ota. One fast form: source (Booking / MMT / Goibibo /
   Airbnb / Hostelworld), guest name, dates, room type, units, OTA reference, amount.
   Creates a reservation with source='ota_*' and a paid-at-OTA marker so it never shows
   a balance at checkout. Target: under 30 seconds per booking.

3. A visible banner on the allotment grid stating which units are direct-only and must
   stay closed in the OTA extranets. The database cannot protect you from an OTA booking
   that arrives as an email.

Stop.
```

---

### M6 — Launch

Not a coding task. See §5.

---

### M7 — Guest ordering (after a month of real use)

QR at the tables and in the rooms → `/order?table=T3` or `/order?room=204` → menu → order →
same kitchen queue as the counter, with `source` set. Room QR posts to the guest's folio.
No guest login. Build this once you know the café actually wants it.

---

## 4. Security checklist

Run this as its own Claude Code pass before launch.

```text
Security review before go-live. Report findings first; fix only what I approve.

1. Grep the entire repo for the service role key. It must appear in server-only code and
   never behind a NEXT_PUBLIC_ prefix. Confirm it is absent from the client bundle by
   building and searching .next/static.

2. For every table, confirm RLS is enabled and there is no permissive policy that lets anon
   or authenticated read guest data. Write a script that connects with the ANON key only and
   attempts to select from guests, reservations, allocations, folios, folio_items, payments
   and events. Every one must return zero rows or an error. Paste the output.

3. Every SECURITY DEFINER function: search_path pinned, execute revoked from public AND
   anon, granted only to the roles that need it, and a staff check inside any function that
   returns guest data. Revoking from anon alone does not remove the default PUBLIC grant.

4. ID documents: private bucket, no public URLs, signed URLs with a short TTL, storage
   policies restricted to staff. Confirm an unauthenticated request to a stored object 404s.

5. Every public endpoint: Zod validation, rate limiting, idempotency on anything that writes.

6. Confirm no PII appears in event summaries that a guest could ever read.

7. Nightly backup: a scheduled pg_dump to storage outside Supabase, with a documented
   restore procedure that you have actually tested once. The free tier has no
   point-in-time recovery — if the database is lost, every booking is lost with it.
   This is the single largest operational risk in the project.

8. .env.example committed with placeholder values; real .env in .gitignore; confirm no
   secret has ever been committed (check history, not just the working tree).
```

---

## 5. Launch checklist

**Before DNS cutover**
- Real photos, room names, rates, occupancies, cancellation policy from the owner — seeded, not placeholders
- Attached-bathroom claim resolved and corrected on every page
- GST status confirmed; if unregistered, no tax line anywhere
- Allotment set, and those units closed in every OTA extranet
- Security pass above completed
- Backup script running and one restore rehearsed
- All three staff have logins and have each done a walkthrough: take a booking, check someone in, run a café order, check someone out
- Legal pages: cancellation policy, privacy policy, terms. A booking site without a stated cancellation policy invites chargebacks.

**Cutover**
- Confirm Zotel's notice period and renewal date before you touch DNS
- Deploy to Vercel, verify on the preview URL
- Point `backpackerstorey.in` at Vercel; keep the Zotel booking URL live for 48 hours as a fallback
- Update the booking link on Google Business Profile and every OTA listing that points at the old site
- Watch the first three real bookings end to end before you stop watching

**Costs**
Domain (owned). Vercel free. Supabase free → Pro ($25/mo) when they can afford it, mainly for
backups. Resend free tier covers this volume. Razorpay only if you add prepay — no monthly fee,
per-transaction only. Total at launch: effectively zero beyond the domain, versus whatever
Zotel is charging.

---

## 6. What not to build

AI pricing (it's the rate calendar) · channel manager (see §2) · CRM campaigns · loyalty ·
inventory with recipe-level stock — nobody at a 9-unit hostel will maintain a bill of
materials · multi-property · multi-currency · RevPAR and forecasting · a document vault ·
table floor plans — a text table number is enough · guest accounts — booking code + phone is
enough.

Each of these is schema you keep alive on every migration, forever, for a property with nine
beds and three staff.