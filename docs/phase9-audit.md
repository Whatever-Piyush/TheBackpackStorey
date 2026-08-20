# Phase 9 — Phase 0 read-only audit

> The authoritative record of the **current** authorization / money / booking state,
> from primary sources (migrations + app code), gathered before any Phase 9 code.
> Read with `docs/gateway-and-policies.md` (the design) and `docs/foundation.md`
> (schema of record). Evidence is cited as `file:line`.

## A. The five `profiles.role` values — and what each can do today

`profiles.role ∈ ('owner','manager','reception','kitchen','housekeeping')`, default
`'reception'` (`0001_schema.sql:12-13`). `user_role()` returns it (`0001_schema.sql:19`).
**This is the vocabulary `can_view_money()` reads** — the only place `manager` exists.

| Role | Portal (POS+Stays) today | Money today |
|---|---|---|
| **owner** | everything, incl. `/pos/today`, day close, form-C | all aggregate + transactional |
| **manager** | everything except the UI locked `/pos/today` + close-day to owner-only | RPC `pos_today` admits manager, but the **UI page was owner-only** — the bug Phase 1 fixes |
| **reception** | POS till, charge-to-room, stays, departures, checkout | **transactional only** (one order / one guest folio); `pos_can_operate()` includes reception (`0015:43`) |
| **kitchen** | `/pos/kitchen` only | none |
| **housekeeping** | `/stays/board` only | none |

**Second, separate vocabulary:** `staff.role ∈ ('owner','staff')` (`0013_staff.sql:14`),
gating the **`(reception)` console** via `is_staff()`/`isOwner` (`src/lib/reception/staff.ts:57`),
deliberately separate (`0013:6-9`). **`manager` does not exist here.** Two role systems
already exist → the money predicate must reuse `profiles.role`, never invent a third, and
never use `staff.role` for portal financial authorization.

## B. Aggregate-money surfaces and their gate

| Surface | Gate today | Notes |
|---|---|---|
| `pos_today(date)` `0015:258` | RPC raises unless `user_role() in (owner,manager)` `0015:270` | `byMethod`, `grossPaise`, `openPaise`, `toRoomPaise` — the aggregate screen |
| `pos_close_day(date)` `0015:346` | raises unless `user_role()='owner'` `0015:362` | snapshots `pos_today.summary` into `pos_day_closes.totals`; rejects on open orders; **no cash-count step exists** |
| `pos_day_closes` table `0015:18` | `revoke all … from anon, authenticated` `0015:30` | definer-only |
| `/pos/today` UI | was `requireRole(["owner"])` | owner-only in UI — **tighter than the RPC (bug)** |

No manager-reachable aggregate UI existed before Phase 1 (the one page was owner-only).

## C. Transactional-money surfaces and their gate

| Surface | Gate | Money |
|---|---|---|
| `pos_settle_order` `0015:130` | `pos_can_operate()` (owner/manager/reception) | one order total |
| `pos_charge_to_room` `0015:179` | same | one order → guest folio |
| `stays_folio(res_id)` `0019:139` | owner/manager/reception `0019:149` | **one guest's `balancePaise`** + openOrders |
| `stays_departures` `0019:202` | same | embeds each guest's folio |
| `stays_checkout` `0019:267` | same | `balance = folio_items − payments`; blocks on `BALANCE_DUE`; **accepts `method='razorpay'`** `0019:340` |
| `public_booking_lookup(code,phone)` `0024:147` | anon (rate-limited) | that booking's `totalPaise/paidPaise` |

→ Reception's guest-balance surface is **`stays_folio`**. A pre-existing deposit payment row
already reduces the checkout balance with **zero changes**.

## D. The `reservations.status` blast radius

Enum (FROZEN): `hold, confirmed, checked_in, checked_out, cancelled, no_show` (`0006:41`),
default `confirmed`.

- **Writers:** create_reservation inserts `confirmed` (`0028:84`, 0010/0012); checkout→`checked_out`
  (`0019:363`); no_show (`0020:436`); cancel (`0010:186`, `0012:275`); check-in→`checked_in` (0017).
- **Readers (~10 migrations + UI):** availability (`0010`,`0025`,`0028`), check-in eligibility
  (`0017:160,206`), in-house (`0020:185,282,429`), guest mgmt (`0018:225,277`), dashboard
  (`0014:48,89`), charge-to-room needs `checked_in` (`0015:218`).
- **`'hold'` is fully plumbed as a READ but never WRITTEN** — availability counts it as
  occupying, and check-in/in-house/guest-mgmt/dashboard **treat `hold` ≈ `confirmed`**. Making
  holds real (unpaid, expiring) in Phase 3 means those readers currently accept an unpaid hold
  as a bookable/checkin-able confirmed booking.

## E. Reusable for Razorpay vs must-build

**Reuse (direct):** `check_rate_limit(bucket,limit,window)` generic + self-sweeping (`0024:26`);
the channel webhook route shape (`api/channel/webhook/route.ts`) — size cap (declared + actual),
per-IP rate limit, **raw body via `request.text()`, verify-before-parse, fails closed on unset
secret** (`:90`) — the exact "mock accepted unsigned" bug, fixed in 0033; `channel_inbox` dedupe
(`0029:8-31`) — `status in (pending,applied,duplicate,failed)`, **unique `(provider_id, external_id)`,
`on conflict do nothing`** → `payment_events` is a faithful mirror; `log_event(...,folio_id,payload)`
(`0012:69`) logs money actions unchanged; folio math (`balance = folio_items − payments`, negative
payments allowed, razorpay already a method `0007:109`).

**Must build:** Razorpay HMAC verify + provider; `payment_intents`/`payment_events`; server order-create
(amount from stored `deposit_amount_paise`); capture→`hold→confirmed`→post payment; refunds. **Zero
Razorpay code exists in the app today.**

**Scheduled runner:** the **only** scheduler is `.github/workflows/backup.yml` (nightly `pg_dump`,
self-warns GitHub disables it after ~60 days idle). Nothing drains the outbox; nothing could sweep
holds → validates Phase 3 lazy-expiry. Secrets are server-only via `process.env`; nothing sensitive
behind `NEXT_PUBLIC_`; Razorpay vars absent (add in Phase 4).

## F. Contradictions with the design docs

1. **Money is integer paise, not `numeric(10,2)`** (`0007:74-75,111`; `supabase/README.md`). Corrected
   in `docs/gateway-and-policies.md` §5.
2. `payments.method` **already includes `razorpay`** (`0007:109`) — Phase 4's "add razorpay" is a no-op.
3. `payments` **has no `status` column** — Phase 5's "negative payment, status pending" cannot be stored
   as written (see G4).
4. **Room charges post at BOOKING for website** (`/api/book` calls `ensure_room_charges`, `route.ts:228`),
   at check-in for others, and are **skipped for OTA** (`0028:300`). So a website reservation carries full
   room charges + folio pre-arrival; Phase 5's reverse-charge example applies pre-arrival for website.

## G. Genuinely risky / unanticipated

1. **Two owners; `manager` only in `profiles`.** Build the owner/manager money section in the `(portal)`
   group (profiles.role), not the reception console (staff.role), where managers have no identity.
2. **Real holds mutate every `hold≈confirmed` reader.** Phase 3 must patch **both** `inventory_snapshot`
   (`0027:57`) and `free_units_for_stay` (`0011:37`, under `pick_units`) to skip expired-hold allocations
   — status is currently never consulted for blocking — and check-in/in-house must not treat an unpaid
   hold as confirmed.
3. **Expired-hold folios linger.** `/api/book` opens a folio + posts room-night lines at booking; if Phase 3
   makes website a hold, the sweep must also **void that folio** (it only cancels the reservation + deletes
   allocations today).
4. **Refund timing vs a status-less `payments` table.** Inserting a negative `payments` row at refund
   *initiation* would show money returned 5–7 days early with no "pending" state and need reversal on
   `refund.failed`. Resolve before Phase 5: add `payments.status` / a `refunds` table, or insert the negative
   row only on `refund.processed`. **Decision not in the docs.**
5. **Don't copy the channel route's mode-gate.** That webhook 404s unless `distribution_mode='channel_manager'`
   (`route.ts:47`); a Razorpay webhook is always-on.
6. **`profiles` RLS is safe (Phase 1 §4).** `profiles_write` is `for all` with `using (user_role() in
   ('owner','manager'))` (`0002:32-34`); for UPDATE the `using` clause is the caller's *current* role, so
   reception/kitchen/housekeeping cannot update any profiles row — no self-promotion. Only owner/manager
   change roles (intended). Table-GRANT (`0036:61`) is gated by this RLS (enabled `0002:14`).
