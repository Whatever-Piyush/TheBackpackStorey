# Backpackers Storey OS — Foundation Layer (corrected)

> Supersedes the earlier module list.

---

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Multi-property | **No.** No `property_id`. | You'll never run a second one from this codebase. A separate SaaS product later, built multi-tenant from day one. |
| Sellable unit | **Both beds and rooms**, via `sell_mode` on room type. | Dorm beds and private rooms are different inventory. This is the retrofit that actually hurts, not `property_id`. |
| Double-booking prevention | **Postgres exclusion constraint**, not application-level availability checks. | App-level checks lose races. The DB makes overlap impossible. |
| OTA availability | **Direct allotment + iCal import.** No channel manager. | Booking.com Connectivity needs partner certification; MMT/Goibibo have no open API for one property. |
| Content | Rooms, rates, availability, menu → DB. Marketing copy, amenities, attractions, gallery stay in `site.ts`. | No CMS. Revisit only if the owner actually asks to edit copy. |
| Pricing | **Rate calendar** (one row per type per date). Seasonal/weekend/festival rules are scripts that write rows. | Deletes the entire "AI pricing" module. |
| Auth | Supabase Auth, staff only. Guests identified by booking code + phone, no guest accounts in v1. | Guest logins add a whole account-recovery surface for zero booking uplift. |
| Writes | All operational writes go through server-side routes using the service role. RLS deny-by-default. | The anon key is public. Never let the browser write to `allocations` or `payments`. |

---

## 2. Inventory schema

```sql
create extension if not exists btree_gist;

-- What you sell
create table room_types (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,        -- 'MIXED_DORM_6', 'PRIVATE_DOUBLE', 'FAMILY'
  name          text not null,
  sell_mode     text not null check (sell_mode in ('per_bed','per_room')),
  gender_policy text not null default 'any'
                check (gender_policy in ('any','female_only','male_only')),
  base_occupancy int not null default 1,
  max_occupancy  int not null default 2,
  sort_order     int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Physical rooms. Exist for BOTH sell modes.
create table rooms (
  id            uuid primary key default gen_random_uuid(),
  room_type_id  uuid not null references room_types(id),
  number        text not null unique,        -- '101', 'Dorm A'
  floor         text,
  housekeeping  text not null default 'clean'
                check (housekeeping in ('clean','dirty','inspected','out_of_order')),
  active        boolean not null default true
);

-- Only for sell_mode = 'per_bed'
create table beds (
  id       uuid primary key default gen_random_uuid(),
  room_id  uuid not null references rooms(id),
  label    text not null,                    -- 'A-1'
  position text check (position in ('lower','upper','single')),
  active   boolean not null default true,
  unique (room_id, label)
);

-- The single thing availability and allocation work against.
-- One row per sellable unit: a whole private room, or one dorm bed.
create table units (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references room_types(id),
  room_id      uuid not null references rooms(id),
  bed_id       uuid references beds(id),     -- null => the whole room is the unit
  active       boolean not null default true,
  unique (room_id, bed_id)
);
```

`units` is populated by trigger when a room or bed is created. Every availability query, allocation, and occupancy report reads `units` and never branches on dorm-vs-private. If the property turns out to be private rooms only, drop `beds`, set every type to `per_room`, and nothing else in this document changes.

---

## 3. Reservations and the constraint that does the real work

```sql
create table reservations (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,          -- 'BS-4K7QP2', what the guest quotes
  guest_id    uuid references guests(id),
  status      text not null default 'confirmed'
              check (status in ('hold','confirmed','checked_in','checked_out','cancelled','no_show')),
  source      text not null                  -- 'website','walk_in','phone','ota_booking','ota_hostelworld',...
              check (source in ('website','walk_in','phone','ota_booking','ota_goibibo','ota_hostelworld','ota_airbnb','other')),
  checkin     date not null,
  checkout    date not null,
  adults      int not null default 1,
  children    int not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  check (checkout > checkin)
);

-- One row per (unit, stay). The constraint is the point.
create table allocations (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id),
  reservation_id uuid references reservations(id) on delete cascade,
  reason         text not null default 'booking'
                 check (reason in ('booking','maintenance','owner_use','hold')),
  stay           daterange not null,
  created_at     timestamptz not null default now(),
  exclude using gist (unit_id with =, stay with &&)
);
```

Three things follow from this:

1. **Half-open ranges.** Always insert `daterange(checkin, checkout, '[)')`. Checkout day is free for the next guest — exactly hotel semantics, and `&&` then behaves correctly with no off-by-one.
2. **Concurrent bookings can't collide.** Two people hitting Reserve on the last bed at the same instant: one insert succeeds, the other raises `23P01`. Catch it and return "just taken" rather than checking availability first and hoping.
3. **Maintenance blocks need no separate mechanism.** A broken AC is an `allocations` row with `reason='maintenance'` and no reservation. Owner blocking a weekend, same. The "Maintenance module" becomes one button.

**Allocate eagerly.** Auto-assign a specific unit at booking time and let reception move it later. The alternative — unassigned bookings counted separately from allocated ones — means maintaining a second availability path. Not worth it at this size.

Availability for a type over a date range:

```sql
select u.id
from units u
where u.room_type_id = $1
  and u.active
  and not exists (
    select 1 from allocations a
    where a.unit_id = u.id
      and a.stay && daterange($2::date, $3::date, '[)')
  );
```

---

## 4. Rates

```sql
create table rate_plans (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references room_types(id),
  name         text not null,                -- 'Direct Flex', 'Non-refundable', 'Long Stay 7+'
  min_nights   int not null default 1,
  refundable   boolean not null default true,
  cancel_hours int not null default 24,
  active       boolean not null default true
);

create table rates (
  room_type_id uuid not null references room_types(id),
  rate_plan_id uuid not null references rate_plans(id),
  stay_date    date not null,
  price        numeric(10,2) not null,
  closed       boolean not null default false,
  primary key (room_type_id, rate_plan_id, stay_date)
);
```

Rate for a stay = sum of `rates` rows for each night. No rule engine at read time. Weekend pricing, the March–June Bir season, Diwali — all of it is a seeded script that writes rows for the next 400 days, plus one grid screen where the owner overrides a date.

---

## 5. The OTA fix — direct allotment

```sql
create table direct_allotment (
  room_type_id     uuid not null references room_types(id),
  stay_date        date not null,
  units_for_direct int not null default 0,
  primary key (room_type_id, stay_date)
);
```

Public booking engine availability for a type on a date:

```
min( physical units free , units_for_direct − direct reservations already holding that date )
```

Reception sees one grid: type × date, editable number.

**This only works if the allotted units are closed in the OTA extranets.** Pick, say, 2 of 6 dorm beds and 1 private room as direct-only, block them on Booking.com / Goibibo / Hostelworld, and never sell them there. Otherwise you've sold the same bed twice and the constraint won't save you, because the OTA booking arrives by email, not by insert.

Then, for OTAs that expose a calendar feed (Airbnb, and Booking.com for some property types), run a nightly iCal import that writes `allocations` rows with `reason='booking'` and `source='ota_*'`. That covers the rest of the inventory well enough to keep the occupancy board honest.

---

## 6. Folio — the whole of "unified billing"

```sql
create table folios (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid references reservations(id),   -- null for a café walk-in tab
  table_no       text,
  status         text not null default 'open' check (status in ('open','settled','void')),
  created_at     timestamptz not null default now()
);

create table folio_items (
  id          uuid primary key default gen_random_uuid(),
  folio_id    uuid not null references folios(id) on delete cascade,
  kind        text not null check (kind in ('room_night','food','beverage','extra','discount','tax')),
  description text not null,
  qty         numeric(10,2) not null default 1,
  unit_price  numeric(10,2) not null,
  amount      numeric(10,2) not null,
  tax_rate    numeric(5,2) not null default 0,
  source      text,                                  -- 'pos','booking','reception'
  posted_at   timestamptz not null default now(),
  posted_by   uuid references auth.users(id)
);

create table payments (
  id          uuid primary key default gen_random_uuid(),
  folio_id    uuid not null references folios(id),
  method      text not null check (method in ('cash','upi','card','razorpay','ota_prepaid')),
  amount      numeric(10,2) not null,
  reference   text,
  received_at timestamptz not null default now(),
  received_by uuid references auth.users(id)
);
```

Room nights post to the folio on confirmation. A café order with "charge to room" posts `folio_items` against the guest's open folio. Balance = items − payments. That's it — three tables instead of the Payments/Invoices/Refunds/GST/Partial-Payments module cluster. Refund = a negative payment. Partial payment = two rows.

**GST:** store `tax_rate` per line, don't hardcode a constant anywhere. The room-tariff slab was changed recently, so confirm the current rate before seeding, and confirm the hostel is even GST-registered. If it isn't, set every `tax_rate` to 0 and don't build invoice numbering yet.

---

## 7. Scope

**v1 — ship this, then stop and let them run it**

- Publish the existing site; rooms, rates, availability, menu read from DB
- Booking engine on allotment → Razorpay → confirmation email + WhatsApp deep link
- Reception console: today's arrivals/departures, month occupancy grid, walk-in booking, assign/move unit, block unit, check-in, check-out
- Café POS finished: menu, take order, bill, charge-to-room
- Folio + payments + daily cash close

**v2 — only after a month of real use**

Housekeeping status board · guest reviews with owner moderation · offers and coupons · guest portal and QR ordering · reports beyond daily close

**Cut. Do not build.**

AI pricing (it's the rate calendar) · channel manager (allotment + iCal) · inventory with bill-of-materials — nobody will maintain a burger recipe; a low-stock checklist at most · CRM campaigns · document vault · audit logs beyond `created_by`/`created_at` · table floor plans — a text `table_no` on the order is enough · multi-currency · multi-property · RevPAR and forecasting

---

## 8. Claude Code task prompt

Send after your existing context prompt, replacing the earlier foundation task:

```text
Foundation layer. Read docs/foundation.md first — it supersedes the earlier module list.

Scope of this task: database schema and data access only. No UI, no booking flow,
no POS changes yet.

Do, in order:

1. Report what already exists: current Supabase tables, the shape of the bookings
   table the website currently writes to, and everything currently read from site.ts.
   Do not change anything yet.

2. Write the migration for section 2-6 of docs/foundation.md, as numbered SQL files
   under supabase/migrations/. Include:
   - btree_gist extension
   - the units trigger that keeps units in sync with rooms and beds
   - the exclusion constraint on allocations
   - RLS: deny-by-default on every table in this migration; public anon SELECT only
     on room_types, rooms (id/number/type), rates, direct_allotment
   Flag anything in the existing bookings table that needs migrating into
   reservations/allocations, and write that migration separately.

3. Seed script: room types and units matching the real property, one Direct Flex
   rate plan per type, 400 days of rates, and a default allotment. Use placeholder
   numbers where I haven't given you real ones and list every placeholder you used.

4. A typed data layer in lib/inventory/ with exactly these functions:
   availableUnits, directAvailability, quoteStay, createReservation,
   moveAllocation, blockUnit, cancelReservation.
   createReservation must catch Postgres 23P01 and return a typed
   UNIT_TAKEN result rather than throwing.

5. One test file proving: two concurrent createReservation calls for the last unit
   produce exactly one success and one UNIT_TAKEN; and that a booking ending on the
   4th does not collide with one starting on the 4th.

Stop after step 5 and show me the migration diff plus the test output.
Do not touch existing website pages or POS code in this task.
```

---

## 9. Start these today — they have lead time

1. **Razorpay KYC on the hostel's entity**, not yours. Their PAN, bank account, and GST if registered. Takes days, and guest money must never land in your account.
2. **Real content from the owner:** photos per room type, actual room-type names and occupancies, current rates, cancellation policy, check-in/out times, exact dorm bed count. This is what delays launches, not code.
3. **Which units become direct-only**, and block them in every OTA extranet before the booking engine goes live.
