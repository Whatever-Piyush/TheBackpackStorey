# Inventory & OTA integration — codebase audit

**Date:** 2026-08-05
**Scope:** `supabase/migrations/` (0001–0037) and `src/` in full
**Method:** read every migration touching inventory/reservations/channels, read every
`src/lib/channel/*`, `src/lib/inventory/*`, `src/lib/booking/*` and the three API routes,
ran the full test suite, and probed the local shadow database for live state.

**Verification status:** `npm test` — **157 tests, 157 pass, 0 fail** against the local
shadow DB (`postgres://localhost:55432/app`). Live-state figures below were read from that
same database; production was not reachable from this audit and is flagged wherever it
matters.

---

## PART 1 — What exists

### 1. Tables touching inventory, bookings or OTAs

#### Core inventory

| Table | Migration | Key columns | Foreign keys | Constraints |
|---|---|---|---|---|
| `room_types` | `0004`, extended `0005` | `id`, `code` (unique), `name`, `base_rate_paise`, `sell_mode`, `gender_policy`, `base_occupancy`, `active`, `is_dorm` (deprecated) | — | `sell_mode in ('per_bed','per_room')`; `gender_policy in ('any','female_only','male_only')`; `base_occupancy > 0` |
| `rooms` | `0001`, extended `0005` | `id`, `number` (unique, NOT NULL), `room_type_id` (NOT NULL), `housekeeping`, `active`, `floor` | `room_type_id → room_types(id)` | `housekeeping in ('clean','dirty','inspected','out_of_order')` |
| `beds` | `0001`, extended `0005` | `id`, `room_id`, `label`, `position`, `active` | `room_id → rooms(id)` | `position in ('lower','upper','single')` or NULL |
| **`units`** | `0005` | `id`, `room_type_id`, `room_id`, `bed_id` (nullable), `active` | `room_type_id → room_types`, `room_id → rooms ON DELETE CASCADE`, `bed_id → beds ON DELETE CASCADE` | **`units_room_bed_key unique nulls not distinct (room_id, bed_id)`** |

`units` is the single sellable-thing table — one row per private room, or one row per dorm
bed. Kept in sync by triggers `units_sync_on_room` / `units_sync_on_bed` /
`units_sync_on_type`, all calling `sync_units_for_room()`.

The `nulls not distinct` on `units_room_bed_key` is deliberate and load-bearing: plain
`unique (room_id, bed_id)` treats NULLs as distinct in Postgres, which would permit
unlimited duplicate `(room_id, NULL)` rows — one private room sprouting ten units, and
availability silently overselling it.

**Live unit count (shadow DB):**

| room type | sell_mode | active units |
|---|---|---|
| `dorm` | `per_bed` | 6 |
| `deluxe` | `per_room` | 1 |
| `premium` | `per_room` | 1 |
| `family` | `per_room` | 1 |
| | | **9 total** |

#### Reservations and allocations

| Table | Migration | Key columns | Foreign keys | Constraints |
|---|---|---|---|---|
| `reservations` | `0006`, + `0025`, + `0026` | `id`, `code` (unique, `BS-XXXXXX`), `guest_id`, `status`, `source`, `checkin`, `checkout`, `adults`, `children`, `notes`, `external_ref` | `guest_id → guests(id)`, `created_by → auth.users(id)`, **`source → channels(code) ON UPDATE CASCADE`** | `status in ('hold','confirmed','checked_in','checked_out','cancelled','no_show')`; `adults > 0`; `children >= 0`; `checkout > checkin`; **partial unique index `reservations_external_ref_key (source, external_ref) where external_ref is not null`** |
| **`allocations`** | `0006` | `id`, `unit_id`, `reservation_id`, `reason`, `stay` (daterange), `created_at`, `created_by` | `unit_id → units(id)`, `reservation_id → reservations(id) ON DELETE CASCADE`, `created_by → auth.users(id)` | see below |

`allocations` constraints, read live from `pg_constraint`:

```
allocations_pkey                      PRIMARY KEY (id)
allocations_no_overlap                EXCLUDE USING gist (unit_id WITH =, stay WITH &&)
allocations_stay_half_open            CHECK (lower_inc(stay) AND NOT upper_inc(stay) AND NOT isempty(stay))
allocations_reason_check              CHECK (reason IN ('booking','maintenance','owner_use','hold'))
allocations_reason_reservation_check  CHECK ((reason = 'booking'  AND reservation_id IS NOT NULL)
                                          OR (reason <> 'booking' AND reservation_id IS NULL))
allocations_unit_id_fkey              FOREIGN KEY (unit_id) REFERENCES units(id)
allocations_reservation_id_fkey       FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
allocations_created_by_fkey           FOREIGN KEY (created_by) REFERENCES auth.users(id)
```

`allocations_no_overlap` is the entire double-booking story at the storage layer. Two
concurrent inserts for the same unit over overlapping dates: one commits, the other raises
`23P01`. A maintenance block or owner hold is the same row with `reservation_id = NULL` —
which is why there is no separate maintenance table.

`stay` is always built as `daterange(checkin, checkout, '[)')`, so the checkout day is free
for the next guest and `&&` has no off-by-one.

Indexes: `reservations_dates_idx`, `reservations_status_idx`, `reservations_guest_idx`,
`reservations_code_idx`, `reservations_source_idx`, `allocations_reservation_idx`,
`allocations_stay_idx` (gist).

#### OTA / channel

| Table | Migration | Key columns | Foreign keys | Constraints |
|---|---|---|---|---|
| `channels` | `0026` | `code` (PK), `name`, `kind`, `active`, `sort_order` | — | `kind in ('direct','ota','manual')` |
| `property_settings` | `0026` | `id` (=1), `distribution_mode` | — | `id = 1`; `distribution_mode in ('manual','channel_manager')`, default `manual` |
| `channel_providers` | `0026` | `id`, `provider_id` (unique), `label`, `config` jsonb, `active` | — | **unique index `channel_providers_one_active ((true)) where active`** — at most one active provider, because two would fight over the same inventory |
| `channel_outbox` | `0027` | `id`, `kind`, `room_type_id`, `from_date`, `to_date`, `reservation_id`, `sequence` (bigint from `channel_outbox_seq`), `status`, `attempts`, `next_attempt_at`, `last_error`, `requires_ack`, `acknowledged_at`, `acknowledged_by`, `provider_id`, `sent_at` | `room_type_id → room_types ON DELETE CASCADE`, `acknowledged_by → auth.users`. **`reservation_id` carries NO foreign key** | `kind in ('availability','rates','reservation_created','reservation_modified','reservation_cancelled')`; `status in ('pending','sent','failed','superseded')` |
| `channel_inbox` | `0029` | `id`, `provider_id`, `external_id`, `kind`, `channel`, `payload` jsonb, `status`, `reservation_id`, `error`, `received_at`, `resolved_at`, `resolved_by`, `resolution` | `channel → channels(code)`, `reservation_id → reservations ON DELETE SET NULL`, `resolved_by → auth.users` | **unique index `channel_inbox_external_key (provider_id, external_id)`**; `kind in ('reservation','cancellation','modification')`; `status in ('pending','applied','duplicate','failed')` |
| `direct_allotment` | `0006` | PK `(room_type_id, stay_date)`, `units_for_direct` | `room_type_id → room_types ON DELETE CASCADE` | `units_for_direct >= 0`. **DEPRECATED by `0028`** |

`channels` seeded rows: `website`, `walk_in`, `phone` (kind `direct`); `ota_booking`,
`ota_goibibo`, `ota_hostelworld`, `ota_airbnb`, `ota_agoda`, `ota_expedia` (kind `ota`);
`other` (kind `manual`).

`direct_allotment` carries a table comment stating *"DEPRECATED (0028): inventory is pooled;
nothing reads this. Kept for its data pending removal."* `0037` revoked the anon grant.
There is **no reader anywhere in the schema or in `src/`**.

#### Adjacent tables

`rate_plans` and `rates` (`0007`; `rates` PK `(room_type_id, rate_plan_id, stay_date)`),
`folios` / `folio_items` / `payments` (`0007`), `booking_idempotency` and `rate_limit_hits`
(`0024`), `reservation_guests` (`0018`), `guest_documents` (`0017`), `events` (`0012`,
append-only, enforced by `events_immutable()`).

#### Legacy, still present, fully disconnected

`bookings` (`0001`) with its own exclusion constraints:

```
no_double_book_bed   EXCLUDE USING gist (bed_id  WITH =, daterange(check_in, check_out, '[)') WITH &&)
                     WHERE (bed_id IS NOT NULL AND status IN ('reserved','checked_in'))
no_double_book_room  EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
                     WHERE (bed_id IS NULL AND status IN ('reserved','checked_in'))
```

`0009` was a **one-shot backfill** into `reservations`/`allocations`, leaving a
`migrated_reservation_id` breadcrumb on each row. There is **no ongoing sync trigger**, and
nothing in `src/` reads or writes `bookings` any more. It is dead data with live
constraints.

---

### 2. Functions and files handling bookings, availability and channel sync

#### SQL — reservation engine

| Function | Signature | What it does |
|---|---|---|
| `create_reservation` | `(p_guest jsonb, p_checkin date, p_checkout date, p_lines jsonb, p_source text, p_unit_ids uuid[], p_actor_id uuid, p_actor_label text) → jsonb` | `0028`. Guest + reservation + N allocations in one transaction; inserts and catches `23P01` as `UNITS_TAKEN`; validates `p_source` against `channels`. SECURITY **INVOKER**, granted to `service_role` only |
| `pick_units` | `(p_room_type_id uuid, p_checkin date, p_checkout date, p_qty integer) → uuid[]` | `0011`. Picks N free units, preferring a single room so a group stays together |
| `free_units_for_stay` | `(uuid, date, date) → table(unit_id, room_id, room_number, is_clean)` | `0011`. Units with no overlapping allocation, ordered clean-first then room number then id |
| `inventory_snapshot` | `(p_room_type uuid, p_from date, p_to date) → table(stay_date, total_units, free_units, price_paise, closed)` | `0027`. **THE availability calculation** — physical active units minus every overlapping allocation, whatever put it there. Does not consult `direct_allotment` |
| `public_availability` | `(p_room_type uuid, p_from date, p_to date) → jsonb` | `0028`. Per-night `free` / `bookable` / `pricePaise` from `inventory_snapshot`. SECURITY DEFINER, anon-callable |
| `public_quote` | `(p_room_type uuid, p_checkin date, p_checkout date, p_units integer) → jsonb` | `0028`. Sums the rate calendar; refuses with `NO_RATE` / `NOT_AVAILABLE` rather than guessing. SECURITY DEFINER, anon-callable |
| `public_booking_lookup` | `(text, text) → jsonb` | `0024`. Code + phone guest lookup, read-only, returns no internal identifiers |
| `cancel_reservation` | `(uuid, uuid, text) → jsonb` | `0012`. **Deletes** the allocations, sets status `cancelled`, logs one event |
| `stays_mark_no_show` | `(uuid, uuid, text) → jsonb` | `0020`. Also **deletes** the allocations — inventory is released |
| `move_allocation` | `(uuid, uuid, uuid, text) → jsonb` | `0012`/`0016`. Catches `23P01` as `UNIT_TAKEN` |
| `block_unit` | `(uuid, date, date, text, uuid, text) → jsonb` | `0012`. Maintenance/owner-use block as an allocation with no reservation |
| `stays_extend` / `stays_shorten` | `0020` | Extend can be refused by the exclusion constraint; shorten cannot |
| `ensure_room_charges` | `(p_reservation_id uuid) → jsonb` | `0028`. Posts room nights to the folio; **skips when `is_ota_channel(source)`** so a marketplace booking isn't billed twice |
| `gen_reservation_code` | `() → text` | `0006`. `BS-XXXXXX` from a 32-char alphabet excluding I/O/0/1 |

Because `cancel_reservation` and `stays_mark_no_show` both **delete** allocations,
`inventory_snapshot` and `free_units_for_stay` are correct without filtering on reservation
status — a cancelled or no-show reservation holds no inventory.

#### SQL — channel

| Function | Signature | What it does |
|---|---|---|
| `create_channel_reservation` | `(p_channel text, p_guest_name text, p_phone text, p_checkin date, p_checkout date, p_room_type_id uuid, p_units integer, p_external_ref text, p_amount_paise integer, p_source text, p_actor_id uuid, p_actor_label text) → jsonb` | `0034` (third revision, after `0029` and `0033`). Delegates to `create_reservation`, sets `external_ref`, opens a folio, posts the OTA amount plus a matching `ota_prepaid` payment. All writes inside a subtransaction; `unique_violation` converts to `DUPLICATE_REFERENCE` carrying the existing `reservationId` and `reservationCode` |
| `is_ota_channel` | `(text) → boolean` | `0026`. Replaces the `source like 'ota\_%'` string matching |
| `distribution_mode` | `() → text` | `0026`. Reads `property_settings`, defaults `manual` |
| `enqueue_channel_sync` | `(text, uuid, date, date, uuid) → void` | `0030`. **INSERT only** — `0027`'s in-transaction supersede was removed because it locked rows another in-flight booking could hold |
| `allocations_enqueue_sync` / `rates_enqueue_sync` / `units_enqueue_sync` | trigger functions | `0027`. Attached to the **tables**, so every path that touches allocations syncs without having to remember to |
| `claim_channel_sync` | `(integer) → setof channel_outbox` | `0027`. `FOR UPDATE SKIP LOCKED`, ordered by `sequence`, increments `attempts` |
| `complete_channel_sync` | `(uuid, boolean, text, text) → void` | `0027`. Exponential backoff capped at 1h; gives up as `failed` after 8 attempts rather than retrying forever in silence |
| `supersede_channel_sync` | `(uuid) → void` | `0030`. Stands down a row the worker found stale. Never called from a booking |
| `acknowledge_channel_sync` | `(uuid, uuid) → jsonb` | `0027`. Staff confirming they typed the numbers into the extranets |
| `claim_channel_inbound` | `(text, text, text, text, jsonb) → jsonb` | `0029`. `INSERT … ON CONFLICT DO NOTHING` + `FOUND`; returns `{fresh:false}` on a replay |
| `complete_channel_inbound` | `(text, text, text, uuid, text) → void` | `0029` |
| `resolve_channel_inbound` | `(uuid, text, uuid) → jsonb` | `0029`. Staff dismissing an inbound message they handled by hand |
| `channel_status` | `(integer) → jsonb` | `0029`. Everything `/stays/channel` needs in one call: mode, provider, queue counts, last-sent per kind, the attention list, and inbound failures |

#### TypeScript

| File | Export | Signature | What it does |
|---|---|---|---|
| `src/app/api/book/route.ts` | `POST` | `(Request) → Response` | Public booking endpoint. Zod validation → rate limit (8 per 10 min per IP) → idempotency claim (uuid key + sha256 fingerprint of the booking's defining fields) → `create_reservation` → `ensure_room_charges` → email + WhatsApp link. Runs on the service role |
| `src/app/api/channel/webhook/route.ts` | `POST` | `(Request) → Response` | Inbound from a Channel Manager. 404s unless `distribution_mode = 'channel_manager'`; 64 KB body cap checked against both `content-length` and actual bytes; 120/min rate limit; `provider.verify()` **before** parsing; dispatches by `?kind=` |
| `src/app/api/channel/sync/route.ts` | `POST` | `(Request) → Response` | Drains the outbox. Guarded by `Bearer $CHANNEL_SYNC_SECRET`; **refuses outright when the secret is unset** |
| `src/lib/channel/ingest.ts` | `ingestReservation` | `(providerId: string, message: InboundReservation) → Promise<IngestOutcome>` | Claim inbox → resolve room type and channel → `create_channel_reservation(p_source:'webhook')` → record applied / duplicate / failed. **`UNITS_TAKEN` becomes a `failed` inbox row reading "Overbooking: …"** |
| | `ingestCancellation` | `(string, InboundCancellation) → Promise<IngestOutcome>` | Finds by `external_ref` or by our code → `cancel_reservation`; `ALREADY_CLOSED` counts as success |
| | `ingestModification` | `(string, InboundModification) → Promise<IngestOutcome>` | Chooses `stays_extend` vs `stays_shorten` by comparing the new checkout to the current one |
| `src/lib/channel/outbox.ts` | `drainOutbox` | `(limit = 20) → Promise<DrainSummary>` | Claims a batch, computes newest-per-scope, supersedes the stale, dispatches to the provider, records each outcome. A provider that throws is caught, not fatal |
| `src/lib/channel/registry.ts` | `getActiveDistribution` | `() → Promise<{mode, provider}>` | Reads `property_settings` and `channel_providers`; **falls back to `manual` on anything unconfigured or unknown** |
| `src/lib/channel/providers/index.ts` | `PROVIDERS` | `Record<string, ChannelProvider>` | `{ manual }` — plus `mock`, only when `NODE_ENV !== 'production'` |
| `src/lib/channel/providers/manual.ts` | `ManualProvider` | class | Staff-as-transport. `syncAvailability` / `syncRates` return `requiresAck: true` with the numbers to type. **`verify()` returns `false`** and all three `receive*` throw |
| `src/lib/channel/providers/mock.ts` | `MockProvider` | class | HMAC-SHA256 + ±5 min timestamp window, `timingSafeEqual`, fails closed with no secret. Test-only |
| `src/lib/channel/status.ts` | `getChannelStatus`, `acknowledgeSync`, `resolveInbound` | server actions | `/stays/channel` data and actions, all `requireRole(['owner','manager','reception'])` |
| `src/lib/inventory/index.ts` | `createReservation` | `(CreateReservationInput) → Promise<CreateReservationResult>` | Thin wrapper on the RPC |
| | `poolAvailability` | `({roomTypeId, checkIn, checkOut}) → Promise<NightAvailability[]>` | Wraps `inventory_snapshot` |
| | `availableUnits` | `({roomTypeId, checkIn, checkOut}) → Promise<Unit[]>` | Free units for reception's unit picker |
| | `quoteStay` | `({roomTypeId, checkIn, checkOut, ratePlanId?}) → Promise<QuoteResult>` | Sums the rate calendar; refuses on missing or closed nights |
| | `cancelReservation` / `moveAllocation` / `blockUnit` | | RPC wrappers |
| `src/lib/booking/availability.ts` | `getAvailability`, `getQuote`, `roomTypeIdForCode` | | **The only file in `src/` that uses the anon client.** Degrades to `null` rather than throwing, and never invents a price |
| `src/lib/booking/lookup.ts` | | | Guest-facing booking lookup by code + phone, read-only |
| `src/lib/stays/ota.ts` | `createOtaBooking` | `(prev, FormData) → Promise<OtaResult>` | Manual OTA entry from `/stays/ota` → `create_channel_reservation(p_source:'reception')` |
| | `listBookableChannels` | `() → Promise<{value,label}[]>` | Channels where `kind in ('ota','manual')` — a new marketplace is an INSERT, not a migration |

#### Double-booking prevention — where it actually lives

1. **`allocations_no_overlap`** (`0006`) — the only real guarantee. Everything else is
   ergonomics on top of it.
2. **`create_reservation`** — inserts and catches `23P01`; never checks-then-hopes. On
   failure it re-counts free units so the caller can say what *is* still available.
3. **`reservations_external_ref_key`** — one OTA reference produces one reservation, even
   under simultaneous delivery. `0034` made the refusal constraint-backed rather than an
   `exists()` pre-check.
4. **`channel_inbox_external_key`** — a replayed webhook cannot book twice. A valid
   signature replays fine inside the ±5 min window; only the database can stop it.
5. **`booking_idempotency`** (`0024`) — a double-click, or a retry after the connection
   drops on hill internet, cannot book twice.
6. **`units_room_bed_key … nulls not distinct`** (`0005`) — a private room cannot sprout
   duplicate units and silently oversell itself.

---

### 3. RLS policies on `reservations` and `allocations`

```
$ grep -r "create policy" supabase/migrations/ | grep -E "(reservation|allocation)"
supabase/migrations/0006_reservations.sql:131:
    create policy direct_allotment_anon_read on direct_allotment for select to anon
```

**There are none, and that is deliberate.**

`0006` enables RLS on `reservations`, `allocations` and `direct_allotment`, then creates no
policy for either of the first two — deny-by-default. `0036` explicitly lists both among the
tables *not* granted to `authenticated`, with the reasoning: those tables are reached only
through SECURITY DEFINER functions that check the caller's role first, so the browser needs
no privilege on the table and a compromised session cannot read one guest's data by guessing
another's id.

Every operational read and write goes through service-role routes or role-checking SQL
functions. **Reservations and allocations are never readable or writable from a browser, on
any key.**

The single grep hit is the `direct_allotment` anon-read policy from `0006` — and `0037`
revoked the underlying table grant, so that policy is now unreachable.

Policies that do exist and matter for this area:

| Policy | Migration | Rule |
|---|---|---|
| `room_types_anon_read` | `0005` | `for select to anon using (active)` |
| `rooms_anon_read` | `0005` | `for select to anon using (active)`, column-level grant `(id, number, room_type_id, type)` |
| `rates_anon_read` | `0007` | `for select to anon` |
| `channels_read` | `0026` | `for select to authenticated using (active)` |

`beds`, `units`, `channel_outbox`, `channel_inbox`, `channel_providers` and
`property_settings` have RLS on and no policy at all — fully private.

Function-level grants were hardened in `0032` (revoking the default PUBLIC EXECUTE that
`0028`'s new signature had silently reacquired), `0036` (explicit table grants so a fresh
restore isn't locked) and `0037` (removing Supabase's permissive bootstrap grants from
`anon` on nine tables).

---

### 4. `src/lib/` inventory and channel logic

```
$ grep -r "direct_allotment\|channel\|booking" src/lib/ --include="*.ts" | head -30
```

40 hits total. The substance:

- **`src/lib/channel/`** — 7 modules: `ingest.ts`, `outbox.ts`, `registry.ts`, `status.ts`,
  `provider.ts`, `types.ts`, plus `providers/{index,manual,mock}.ts`.
- **`src/lib/inventory/`** — `index.ts` and `types.ts`.
- **`src/lib/booking/`** — `availability.ts`, `lookup.ts`, `notify.ts`, `types.ts`.
  **There is no `actions.ts`**, despite `0005`'s header comment referring to
  `src/lib/booking/actions.ts` as a live reader — the legacy booking path is gone from the
  codebase.
- **`direct_allotment` appears zero times in `src/`.**
- **`src/lib/site.ts:18`** still carries
  `bookingUrl: "https://www.zotel.ai/hotels/backpackers-storey-bir"` with the comment
  *"Phase 1 fallback: bookings stay on zotel until Phase 4."* — **dead config.**
  `BookingButton` routes to `/book`, and nothing anywhere reads `bookingUrl`.

---

### 5. Allotment, pooled, or something else?

> **Pooled.** Unambiguously — and the transition is documented inside the migration that
> performed it.

The allotment model *was* built, then deliberately removed:

| Built (allotment) | Removed by |
|---|---|
| `direct_allotment` table (`0006`) | kept, but commented DEPRECATED; no readers |
| `direct_availability(uuid, date, date)` (`0010`) | `drop function` in `0028` |
| `stays_allotment(date, integer)` (`0025`) | `drop function` in `0028` |
| `set_allotment(uuid, date, date, integer, uuid, text)` (`0025`) | `drop function` in `0028` |
| `create_reservation(… p_respect_allotment boolean …)` (`0012`) | signature dropped in `0028`; the parameter no longer exists |
| `/stays/allotment` screen | superseded by `/stays/channel` |

`0028`'s own header states it plainly:

> *"This REMOVES the allotment cap. The website may now sell every free unit. In `manual`
> distribution mode the protection against double-selling is the outbox reminder on
> /stays/channel, not an artificial cap on the website."*

`public_availability`, `public_quote` and `create_reservation` were all rewritten onto
`inventory_snapshot()`. `0027`'s header: *"Pooled and always pooled: physical units minus
allocations. `direct_allotment` is NOT consulted — distribution_mode changes how this number
is published, never how it is derived."*

**Verified against the live shadow DB — exactly one overload survives:**

```
create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text)
```

Each migration cleanly dropped its predecessor (`0011` dropped `0010`'s, `0012` dropped
`0011`'s, `0028` dropped `0012`'s). **No stale allotment-respecting overload exists.**

One stale comment remains: `src/app/(marketing)/book/page.tsx:47` says *"The allotment caps
this again server-side"*. It does not.

---

## PART 2 — What's missing

### 1. How does the website prevent overselling when an OTA booking arrives?

**It doesn't prevent it. It detects it afterwards — and only on one of the two paths.**

There is **no `channel_reservations` table.** The nearest equivalent is **`channel_inbox`**,
but it exists for deduplication and failure recording, not as a staging area holding OTA
bookings before allocation. An inbound reservation goes straight through:

```
webhook → claim_channel_inbound → create_channel_reservation → create_reservation → allocations
```

Two ways an OTA booking reaches the database:

**(a) Manual entry — the only path live today.**
`/stays/ota` → `createOtaBooking` → `create_channel_reservation(p_source:'reception')`.
Owner or reception reads the OTA email and types it in. The form is deliberately flat — no
search, no availability step — targeting under thirty seconds, with the exclusion constraint
as the safety net.

**(b) Webhook — built, wired, tested, and unreachable in production.**

| Gate | State |
|---|---|
| `property_settings.distribution_mode` | `manual` (verified). The webhook route returns **404** in manual mode |
| `channel_providers` | **empty** (verified). Flipping the mode still falls back to `manual` in `getActiveDistribution()` |
| `PROVIDERS` in production | **only `manual`** — `mock` is excluded when `NODE_ENV === 'production'` |
| `ManualProvider.verify()` | returns `false` — every webhook would 401 |
| Real vendor providers | none. `registry.ts` has commented placeholders for `staah` and `siteminder` |

So: **(b) in code, (a) in practice.** The owner manually enters OTA bookings, and each OTA's
own extranet is the only thing stopping that OTA from selling a unit the website already
sold — because with pooled inventory, nothing is held back for the OTAs to sell safely.

### 2. What happens when…

#### An OTA booking arrives via webhook for a unit that's now taken

The path is complete and correct, and does what the design intends:

1. `create_reservation` → `pick_units` returns fewer units than requested → `raise 23P01`
2. → `UNITS_TAKEN` with a freshly counted `available` figure
3. → `ingest.ts:102` converts it to a **`failed` `channel_inbox` row** reading
   *"Overbooking: the channel sold N unit(s) we no longer have (M free)."*
4. → the webhook returns **422**
5. → the row surfaces in `channel_status().inboundFailures`
6. → `/stays/channel` renders it in the overbooking queue
7. → staff clear it via `resolve_channel_inbound` with a written resolution

**The reservation is refused, never partially applied, and never silently dropped.** The
guest holds an OTA confirmation for a bed that does not exist, and a human resolves it. That
is the documented and accepted limit — `Channel_manager.md` §10: *"A CM is not instant…
Pooled inventory means a genuine overbooking window exists."*

**The gap is on the manual path.** `createOtaBooking` handles the same `UNITS_TAKEN` by
returning a string to the form — *"Not enough beds free for those dates. Check the board."*
No `channel_inbox` row, no queue entry, no event, no record anywhere that an OTA booking
exists which could not be placed. If reception clicks away, the overbooking lives only in
the OTA's extranet and in that person's memory.

**The path that isn't live records the failure. The path that is live doesn't.**

#### The website and an OTA both book the last dorm bed at the same second

**Nothing prevents this, and it is not a race the database can see.**

The exclusion constraint arbitrates only writes that reach `allocations`. In manual mode the
OTA's sale happens entirely inside Booking.com's or MMT's systems — it becomes an email.

```
t = 0          website POST /api/book → allocation on the last bed → committed
               guest receives a confirmation
t = 0          Booking.com sells the same bed from its own cached inventory
               guest receives a confirmation
t + minutes    reception types the OTA booking into /stays/ota → UNITS_TAKEN → error toast
```

Two confirmed guests, one bed, discovered whenever someone opens the inbox.

If both writes **do** reach the database at the same instant — website + webhook, or website
+ reception typing — the constraint is genuinely airtight. Verified by
`tests/inventory.test.mts`:

- *"two concurrent reservations for the last unit: exactly one wins"* (line 364)
- *"a 4-bed group and a 1-bed booking racing for the last bed: one wins, one UNITS_TAKEN"* (line 420)
- *"a group booking that fails on its third unit leaves ZERO allocations"* (line 461)
- *"a stay ending on the 4th does not collide with one starting on the 4th"* (line 396)

### 3. Is there a `channel_outbox` / sync queue, and is it working?

**The queue exists and is being filled correctly. It is never drained.**

**Working:**

- Triggers on `allocations`, `rates` and `units` enqueue on every mutation, with nobody
  calling anything. Verified by `tests/channel.test.mts` (*"the trigger did it, not the
  caller"*) and by the data below.
- `sequence` gives monotonic ordering so a stale availability number can never land after a
  fresh one.
- `0030` removed the enqueue-time `UPDATE` that could deadlock two concurrent bookings — the
  booking path now only ever INSERTs.
- Backoff, 8-attempt give-up, acknowledgement flow and `/stays/channel` visibility are all
  built and tested.

**Not working — nothing invokes the drain:**

```
$ grep -rn "CHANNEL_SYNC_SECRET\|drainOutbox\|api/channel/sync" . --exclude-dir=node_modules
docs/Channel_manager.md:219       (a doc line)
src/app/api/channel/sync/route.ts (its own definition)
src/lib/channel/outbox.ts:43      (the export)
```

- **No cron.** `vercel.json` does not exist. `.github/workflows/` contains only
  `backup.yml`.
- **No post-booking nudge.** `Channel_manager.md` §5d promises *"plus a best-effort nudge
  after a booking"* — `/api/book` does not do this.
- **`CHANNEL_SYNC_SECRET` is absent from `.env.example`**, and the route refuses without it.

**Measured state of the shadow database:**

```
 status  | requires_ack | count
---------+--------------+-------
 pending | true         |  3773
```

Every row ever enqueued, still pending. **None sent, none superseded, none failed.** Since
coalescing moved to drain time in `0030`, nothing ever collapses ten bookings into one push.

*(The count is inflated by the test suite runs; what matters is that no row has ever
transitioned out of `pending`.)*

**Partial mitigation:** `channel_status()` reads `channel_outbox` directly for
`requires_ack AND acknowledged_at IS NULL AND status <> 'superseded'`, so `/stays/channel`
**does** show the manual to-do list without the worker running, and
`acknowledge_channel_sync` clears rows one at a time (setting `status = 'sent'`). But:

- the list is uncoalesced and capped at **25 of 3,773**;
- the "which numbers to type" detail composed by `ManualProvider.syncAvailability()` is only
  produced inside `drainOutbox`, so it is never stored and never shown.

Staff see `Availability · Six-Bed Dormitory · 2026-08-10 → 2026-08-12` and must derive the
number themselves from the board.

---

## PART 3 — The decision

> ### Right now, the codebase implements: **pooled inventory with manual distribution.**

One pool of **9 physical units**. Every channel — website, walk-in, phone, and every OTA —
competes for the same units, and `allocations_no_overlap` arbitrates every write that
reaches the database. Nothing is held back for the OTAs. The allotment model was fully built
and then deliberately removed by `0028`; the table remains with its data but has no reader
in schema or application code.

The channel-manager architecture — outbox, inbox, provider interface, webhook, replay
defence, authorization guard — is built to a high standard and well tested. But **no
provider is installed, so in practice the OTA side is entirely human**: the owner reads
emails and types bookings into `/stays/ota`.

### What is blocking launch

#### 🔴 Blocking — the website can oversell against the OTAs and nothing stops it

This is structural, not a bug. Pooled inventory means the website sells all 9 units while
every OTA also sells from its own copy of those same 9. Nothing reconciles the two: not a
channel manager (none installed), not an allotment cap (removed by `0028`).

The only defence shipped is the `/stays/channel` reminder telling staff to go retype numbers
into six extranets by hand — and that reminder is currently 3,773 uncoalesced rows deep,
capped at 25 on screen, with no instruction text.

**Until either a channel manager is connected or the OTA listings are closed/capped, "sell
to real guests" and "OTA listings stay open" cannot both be true.**

#### 🔴 Blocking — the outbox drain has no invoker

No cron, no Vercel config, no GitHub Action, no post-booking nudge, and
`CHANNEL_SYNC_SECRET` isn't even in `.env.example`.

Today this degrades gracefully, because manual-mode tasks are visible without the worker.
**The moment a real provider is installed, availability pushes silently stop reaching the
OTAs.** Needs to be wired and verified before that, not after.

#### 🔴 Blocking — the manual OTA path drops overbookings on the floor

The webhook path records `UNITS_TAKEN` as a `failed` `channel_inbox` row in the visible
overbooking queue. `createOtaBooking` returns a toast string and nothing else.

#### 🔴 Blocking — the rate calendar is a flat placeholder with a hard cliff and no way to edit it

`0008` seeded one flat price per type for 400 days from whenever it ran.

- Shadow DB window: **`2026-07-31` → `2027-09-03`** (1,600 rows).
- **Production's window ends 400 days after *its* migration date — not visible from this
  audit, and needs checking.**

Past that date `public_quote` returns `NO_RATE` and every room becomes unbookable, with no
warning.

There is **no rate-management screen anywhere in `src/`**. Dorm ₹600, deluxe ₹1,800, premium
₹2,500, family ₹3,200 — flat, no weekend uplift, no March–June Bir season, no Diwali.
`0008`'s header flags all of these as owner-unconfirmed placeholders. Changing a price today
requires SQL.

#### 🟡 Verify before launch — the seed placeholders

From `0008`'s own header, every one a guess that reaches a guest:

1. Room numbers — `Dorm A`, `101`, `102`, `103`. The property's real identifiers are unknown.
2. Dorm bed layout — assumed 3 bunks, D1–D6 alternating lower/upper. *"Could equally be 6 singles."*
3. `gender_policy: 'any'` for the dorm — mixed vs female-only unconfirmed.
4. Rate plan — one "Direct Flex", refundable, 24h cancellation, min 1 night. Real policy unconfirmed.
5. `tax_rate = 0` on folio lines — assumes the property is **not** GST-registered.
6. Floors — left NULL.

#### 🟡 Verify before launch — production migration state and grants

All 157 tests pass locally, including the concurrency, replay and authorization-matrix
suites. That proves the shadow DB.

`0036` and `0037` state in their own headers that production carries Supabase's permissive
bootstrap grants, and that the two migrations behave *differently* on production versus a
fresh restore. So:

- confirm `0032`, `0036` and `0037` are applied against the live project;
- re-run the anon probe there.

#### ⚪ Not blocking, but worth knowing before you take money

- **No payment collection at booking.** No Cashfree, Razorpay or Stripe anywhere in `src/`.
  A guest books free and pays at the property; nothing stops a no-show costing you the
  night.
- **No guest-facing cancel.** `public_booking_lookup` is read-only, so an unwanted booking
  holds a unit until staff cancel it.

#### ⚪ Stale artefacts — no functional impact

| Artefact | Says | Reality |
|---|---|---|
| `codebase.md` (dated 2026-07-30) | *"Bookings outsourced to zotel"*, Phase 4 dropped | The opposite of what shipped — a full booking engine is live |
| `src/lib/site.ts:18` | `bookingUrl` → zotel | Dead config; `BookingButton` routes to `/book` |
| `0005` header comment | references `src/lib/booking/actions.ts` | File no longer exists |
| `src/app/(marketing)/book/page.tsx:47` | *"The allotment caps this again server-side"* | It doesn't — removed by `0028` |
| `docs/Channel_manager.md:218` | `POST /api/channel/[provider]/webhook` | Route is now `/api/channel/webhook`; the provider comes from config, not the URL |
