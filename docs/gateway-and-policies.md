# Gateway & Policies — Phase 9

> The payment gateway (Razorpay deposits + refunds) and the money/policy rules that sit
> around it: revenue visibility, a versioned cancellation policy, booking holds, and
> forfeiture accounting. This is the **design reference** the Phase 9 implementation
> prompts mean when they say "read the Phase 9 design docs first."
>
> Read alongside `docs/foundation.md` (schema of record) and
> `docs/reception-definitions.md` (roles, "Today", GST-registered-not-charged, occupancy).
> Everything here is **additive** — new numbered migrations only. Nothing in this document
> changes an existing migration, RLS policy, the allocations exclusion constraint, the
> reservation allocation logic, or the `reservations.status` enum.

---

## 0. What Phase 9 adds

1. **Revenue segregation** — owner/manager-only visibility of aggregate money; café sees
   operations, reception sees one guest's balance.
2. **A versioned cancellation policy** — snapshotted onto each reservation at booking time.
3. **Booking holds** — a 15-minute website hold with **lazy expiry**, no cron required.
4. **Razorpay deposit payments** — 20% online, webhook-authoritative.
5. **Refunds & forfeiture accounting** — reverse-never-delete, folio nets to zero on
   forfeiture.

Delivered in seven phases (§6). One phase per working session; each phase's tests gate the
next.

---

## 1. Frozen business rules (whole phase)

These do not change during Phase 9. If code seems to require changing one, **stop and ask** —
do not work around it.

- **Deposit:** 20% online to confirm; the remaining 80% at the property by cash or UPI.
- **Cancellation cutoff:** check-in is **2:00 PM IST**, so the standard cutoff is **2:00 PM
  the day before the arrival date** (i.e. `checkin@14:00 Asia/Kolkata − 24h`).
- **Forfeiture:** cancelling inside 24 hours, or not arriving (no-show), forfeits the deposit.
- **No GST anywhere in the booking flow.** No tax line, no split, no GST invoice. Keep
  `folio_items.tax_rate` and leave it at 0 — do **not** remove the column. (Consistent with
  `foundation.md` §6 and `reception-definitions.md` §4: registered, not charged.)
- **Money visibility:**
  - **Owner + Manager** — aggregate financial information.
  - **Reception** — an individual guest's balance only, **never** property totals.
  - **Café / Kitchen** — operational information only, no aggregate revenue.

---

## 2. Frozen technical invariants

The non-negotiables that keep the money model honest. Each is repeated in the phase that
enforces it; collected here so they are visible in one place.

| Invariant | Why |
|---|---|
| **Do not touch the `reservations.status` enum.** It stays `hold, confirmed, checked_in, checked_out, cancelled, no_show`. Payment state lives on the payment record, never on the reservation. | The enum's blast radius (policies, occupancy numerator, UI) is large. Payment lifecycle and reservation lifecycle are different clocks. |
| **One authorization predicate, not a matrix.** `can_view_money()` — the only money gate. No third role vocabulary, no permissions table. | Six people work here. A matrix is a maintenance liability with no upside at this size. |
| **Reverse, never delete, folio rows.** Cancellation posts *negative* lines; it does not delete the original charge. | Deleting loses the record that the charge ever existed and orphans the cancellation fee. Note: `stays_shorten` deletes unused room-nights — that is a *different* case and must **not** be copied here. |
| **Lazy expiry for holds.** `inventory_snapshot`/`pick_units` ignore allocations of an expired hold; the bed is sellable the instant the hold lapses, with no job running. | There is no reliable scheduled job runner (the channel outbox drain has never run). A cron failure must cost table bloat, not locked-up inventory in peak season. |
| **The webhook is the source of truth, not the browser.** A booking is confirmed only from the verified Razorpay webhook. | The client success handler may never fire — tab closed, phone dead, Bir internet dropped. |
| **Fail closed.** When a webhook secret is unset, signature verification returns false, never true. | We shipped exactly this bug once with the channel mock provider. Not again. |
| **Dedupe at a UNIQUE constraint, not an `exists()` check.** Razorpay *will* redeliver; the DB constraint is the only reliable idempotency boundary. Same pattern as `channel_inbox`. | An `exists()` check races; a unique index does not. |
| **`authenticated` is not authorization.** Every money RPC calls `can_view_money()` in its own body; anon is revoked. Hiding a nav link is not access control — anyone with a session can hit `/rest/v1/rpc/` directly. | The anon key is public (`foundation.md` §1). |

---

## 3. Authorization model

**Transactional vs aggregate** is the line that matters:

- **Transactional** — one order, or one guest's bill/balance. Reception and café reach the
  surfaces they already reach today. *Unchanged by Phase 9.*
- **Aggregate** — totals, revenue, day-close, by-method splits. Gated by `can_view_money()`,
  reachable by owner/manager only.

`can_view_money()` — SECURITY DEFINER, `search_path` pinned, returns true only for the two
money-visible roles. Every aggregate-money RPC **RAISES** for everyone else — it does not
return an empty set (an empty result is indistinguishable from a quiet day and teaches
nobody that they lack access).

> **PENDING PHASE 0 — the five `profiles.role` values.** Phase 1 cannot be finalised until
> the read-only audit reports the exact `profiles.role` vocabulary and which values map to
> owner / manager / reception / café / housekeeping. **Do not invent or infer these.** The
> two money-visible roles feed directly into `can_view_money()`.
>
> `profiles.role` values: **`<ROLES — fill from Phase 0 §A>`**
> Money-visible: **`<OWNER_ROLE>`, `<MANAGER_ROLE>`**

`pos_can_operate` is **out of scope and frozen.** Whatever café-POS access reception has
today, it keeps — Phase 0 records the current state, Phase 1 does not change it.

---

## 4. Data-model additions (all additive)

New numbered migrations only. Column/table shapes below are the design intent; Phase 0
confirms what already exists before anything is written.

**Already scaffolded in `foundation.md` — verify in Phase 0, do not re-add blindly:**
- `reservations.status` already includes `hold`.
- `payments.method` already includes `razorpay`.
- `folio_items.tax_rate` already defaults 0; refund is already "a negative payment".

**Policy & deposit (Phase 2)** — two tables, different lifecycles, kept separate:
- `deposit_config` — `version, percent, min_amount_paise (nullable), effective_from, effective_to`.
- `cancellation_policies` — `version`, **two independent date pairs**:
  `effective_from/effective_to` (which version is offered to *new bookings*) and
  `stay_from/stay_to` (which *arrival dates* it governs, null = all), plus
  `cutoff_hours (24)`, `refund_percent (100 of deposit)`, `group_threshold_units (nullable)`,
  `group_cutoff_hours (nullable)`, `body_text`.
  > The two date pairs must not be merged: a booking made in September for a December stay
  > resolves to the **December** rule using the version **live in September**. One pair
  > cannot express that.

**Reservation snapshot (Phase 2)** — added to `reservations`:
`policy_version_id`, `policy_text_snapshot`, `cancellation_cutoff_at` (the **computed**
timestamp, stored — never recomputed later), `deposit_percent_snapshot`, `deposit_amount_paise`,
plus a recorded policy-acceptance timestamp.

**Holds (Phase 3, implemented)** — `reservations.hold_expires_at timestamptz` (null for
confirmed/walk-in/OTA and once a hold is promoted) and `reservations.cancellation_reason`
(`guest, hold_expired, no_show, staff, payment_failed`; only `hold_expired` is set in Phase 3).
Both additive, **not** changes to the `status` enum.

**Payments (Phase 4)**:
- `payment_intents` — `reservation_id, provider('razorpay'), provider_order_id UNIQUE,
  provider_payment_id UNIQUE NULL, amount_paise, currency, status, created_at, captured_at,
  failure_reason`.
- `payment_events` — the raw inbound ledger / dedupe boundary:
  `provider, provider_event_id UNIQUE, event_type, payload jsonb, status(pending/applied/
  duplicate/failed), reservation_id, received_at, processed_at, error`.

**Accounting (Phase 5)**:
- `folio_items.kind` gains `cancellation_fee` (CHECK).
- Partial unique index `(folio_id) WHERE kind = 'cancellation_fee'` — **one** cancellation
  fee per folio, enforced by Postgres.

---

## 5. Amounts & time — house conventions

- **Money is integer paise everywhere** — including the existing folio/payment tables.
  `folio_items.unit_price_paise/amount_paise` and `payments.amount_paise` are `integer`
  paise (`0007_rates_folio.sql`), not `numeric(10,2)` (the Phase 0 audit corrected this:
  `foundation.md` §4/§6 wrote `numeric`, but the migrations implemented paise, per
  `supabase/README.md`). New gateway/deposit fields (`amount_paise`,
  `deposit_amount_paise`, `min_amount_paise`) follow suit. **No rupee↔paise conversion
  anywhere in the folio path.**
- **All "today"/cutoff computation is server-side in `Asia/Kolkata`** (per
  `reception-definitions.md` §3). The cutoff is `(checkin at 14:00 Asia/Kolkata) − cutoff_hours`,
  computed once and stored, so a guest cancelling at 14:05 the day before gets the same
  answer in Bir, Berlin, or with a wrong system clock.
- **Secrets:** `RAZORPAY_KEY_ID` is public (client). `RAZORPAY_KEY_SECRET` and
  `RAZORPAY_WEBHOOK_SECRET` are server-only and must **never** sit behind `NEXT_PUBLIC_`.
  All three go into the security probe's secret-leak grep.

---

## 6. The phases

Sequencing: **0 blocks 1.** 2 and 3 are independent of Razorpay and can proceed while KYC
is pending. **4 blocks 5. 5 blocks 6.** One phase per session; verify each phase's tests
and diff before starting the next.

### Phase 0 — Read-only audit *(blocks everything)*
Report facts only, change nothing. Produces: (A) the five `profiles.role` values and what
each can do today; (B) every aggregate-money surface + its gate; (C) every transactional-money
surface + its gate; (D) the `reservations.status` blast radius; (E) what's reusable for
Razorpay vs must be built; (F) anything contradicting this doc; (G) unanticipated risk.
Also settles: does reception have café POS access *per `pos_can_operate`* (record, don't
change); does anything expire/sweep reservations today; is a scheduled job runner actually
running anywhere.

### Phase 1 — Revenue segregation
`can_view_money()` (one predicate). Split café "Today" into `pos_shift_status()` (café-callable,
**no** money) and `pos_revenue_today()` (**raises** unless `can_view_money()`). Day-close with
a **blind cash count** — café enters counted cash without seeing expected; owner/manager see
counted, expected, variance. Owner/manager section (route proposed first, sits *within* the
existing nav, not a fourth console) leads with **CASH ACTUALLY COLLECTED** as the largest
number. Revoke anon; every money RPC checks the predicate internally. **Do not change
`pos_can_operate`.** Tests assert the *raise*, not a hidden button; reception refused revenue
but still reads a guest folio balance; `pos_shift_status()` returns no monetary field.

### Phase 2 — Cancellation policy & deposit config *(no Razorpay)*
The two tables + reservation snapshot columns from §4. `resolve_cancellation_policy(booked_at,
checkin)` selects the version whose *effective* window contains `booked_at` **and** whose
*stay* window covers `checkin`; deterministic tiebreak (most specific stay window, then
latest `effective_from`) — stated in a comment and tested. Store the computed cutoff; editing
the policy must **not** move an existing reservation's `cancellation_cutoff_at`. Guest-facing:
published `/policies/cancellation`, checkout acceptance step recorded with a timestamp,
confirmation shows the **actual** deadline ("Free cancellation until 2:00 PM, 11 October"),
never "24 hours". Seed v1 (24h, 100% of deposit, stay null, group null) and deposit_config v1
(20%, min null).

### Phase 3 — Booking holds & lazy expiry *(no Razorpay — implemented)*
A **hold is an inventory claim, not a financial event**: creating one reserves units but posts
**no folio, no room charge, no payment**. `hold_expires_at`; `create_reservation` gains a
**server-controlled** `p_hold_minutes` — when set (the website path passes **15 min**) the
reservation is a `hold` expiring `now()+15min`; when null (walk-in/phone/OTA) it is `confirmed`
immediately (unchanged). Allocations are still created at hold time; the frozen exclusion
constraint arbitrates the race *before* money. The client never supplies an `expires_at`.

**Lazy expiry, no sweep.** Correctness never depends on a background job:
- `inventory_snapshot` and `free_units_for_stay` (→ `pick_units`) **ignore** expired-hold
  allocations, so a lapsed hold's bed reads free at once, in both the availability display and
  the allocation picker;
- `create_reservation` calls `release_expired_holds` in its write path **before** it inserts the
  new allocation — inside the **same transaction** — which removes the dead hold's allocation
  rows so the frozen exclusion constraint no longer blocks the unit (the blocking *row* is
  removed; the constraint itself is never touched).
An expired hold that is never revisited simply stays `status='hold'` but inert. When a new
booking **reclaims** its slot, `release_expired_holds` also records the terminal state:
`status='cancelled', cancellation_reason='hold_expired'`. The reservation is kept as history and
**no financial record** is created for the hold or its cleanup (a hold never had a folio, charge,
or payment). There is no cron, worker, or sweep.

**`ensure_room_charges` runs on `hold → confirmed`, never at hold creation.** `confirm_hold(id)`
is the atomic, idempotent promotion primitive Phase 4 will call after a deposit is captured: it
verifies a still-valid, non-expired hold that still owns its inventory, flips `hold → confirmed`,
snapshots the Phase-2 policy/deposit, then posts room charges **exactly once** (guarded by the
`folio_items` room-night unique index). Re-calling it is a no-op success.

**`/api/book` is intentionally unchanged in Phase 3** (still creates a confirmed booking): a hold
only becomes meaningful once there is a deposit to pay, so switching the booking endpoint to holds
belongs with the Razorpay payment step in **Phase 4**. Payment state stays out of
`reservations.status`. Tests: two concurrent holds on the last bed → one `OK`, one `UNITS_TAKEN`;
an expired hold's bed is bookable **without any sweep**; walk-in still confirmed; an expired hold
cannot be confirmed; promotion posts charges exactly once and is idempotent.

### Phase 4 — Razorpay deposit + hold confirmation *(implemented)*
Tables `payment_intents`, `payment_events` (dedupe ledger, `unique(provider, event id)`), and
`refunds` (`0041`); **no** `payments.status`, no new `reservations.status`. No SDK —
`src/lib/payments/razorpay.ts` uses `fetch` + `node:crypto`. Secrets are server-only:
`RAZORPAY_KEY_ID` (publishable) is returned in the `/api/book` response, `RAZORPAY_KEY_SECRET`
and `RAZORPAY_WEBHOOK_SECRET` never leave the server.

**Amount authority (decision B).** `/api/book` creates the 15-min hold, then `deposit_for_reservation`
prices the stay from the same rate calendar `confirm_hold` will bill and applies the active
`deposit_config` %; that amount is stored on `payment_intents.amount_paise` and is *exactly* the
Razorpay order amount. `confirm_hold` still snapshots `reservations.deposit_amount_paise` at
promotion — Phase 3 is unchanged; `confirm_hold` is not modified.

**Webhook is the source of truth** (`/api/payments/razorpay/webhook`): size cap → DB rate limit →
raw body → verify `X-Razorpay-Signature` (**fail closed** on unset secret) → parse. `apply_razorpay_capture`
writes the `payment_events` row (the dedupe boundary) first, verifies order/amount/currency against
the stored intent, then delegates to **`confirm_paid_hold`** (the Phase-4 wrapper: valid/revive-if-still-held
→ `confirm_hold`; cancelled/reclaimed → `INVENTORY_LOST`). On confirm it posts the deposit to the folio
once (payments `unique(reference)` for razorpay); folio arithmetic is unchanged. The browser Checkout
callback is UX only ("Payment received — confirming").

**INVENTORY_LOST + refunds.** If the paid hold was reclaimed, the capture records the deposit and opens a
`refunds` row (`requested`); the route calls Razorpay's refund API and moves it to `processing`. A refund
API 200 is **not** completion — only the `refund.processed` webhook posts the single **negative** folio
payment (`apply_razorpay_refund_result`); `refund.failed` stays visible in `refunds`. Duplicate capture or
refund events are inert (event + reference uniqueness).

### Phase 5 — Cancellation, refunds, forfeiture accounting *(implemented)*
**Reverse, never delete** (`0042`). `folio_items.kind` gains `reversal` and `cancellation_fee`.
A cancellation posts **one consolidated `reversal` line = −(Σ room_night)** — the original
room-night rows stay visible — guarded by a partial unique index `(folio_id) WHERE kind='reversal'`;
the `cancellation_fee` line is guarded by `(folio_id) WHERE kind='cancellation_fee'` (one each per
folio). **Refundable (before the stored cutoff):** reverse charges; `cancelled`/reason `guest`;
allocations deleted (bed resellable at once); a `refunds(requested)` row opens — the negative
payment appears only on `refund.processed` (Phase 4), never on the request. **Forfeited (after
cutoff / no-show):** reverse charges + `cancellation_fee == retained deposit`; folio nets to **zero**;
no refund:

```
room charges          +₹6,000   (kept)
deposit paid          −₹1,200
charge reversal       −₹6,000
cancellation fee      +₹1,200
────────────────────────────
balance                    ₹0
```

`cancel_reservation_with_policy()` runs it in **one transaction** (row-locked eligibility from the
**snapshot**, not the live policy; reversal; fee or refund row; allocation release; audit). The
Razorpay refund HTTP call happens **outside** that transaction (the route, via Phase 4's
`initiateRefund`+`attach_refund_provider`). **Inventory releases immediately; money settles
asynchronously.** A **terminal-status trigger** makes `cancelled`/`checked_out`/`no_show` immutable,
so a concurrent unguarded check-in cannot overwrite a cancellation (DB-level, not check-then-act);
the cancel/no-show functions also lock `FOR UPDATE`. `stays_mark_no_show` gains the same forfeiture
accounting for deposit-bearing bookings (redefined in `0042`; `0020` untouched); a no-deposit no-show
keeps its old behaviour. Guest cancel at `/booking/[code]` requires code **and** phone, is
rate-limited, and shows the server-computed refund/forfeiture before confirming (the client sends no
amounts). Staff cancel uses the same primitive (`stays_cancel`, role-gated); a fee waiver requires a
reason and is audited. `confirm_hold`, `0040`, `0041`, `payments` structure, `payments.status`, the
exclusion constraint, `can_view_money`, and `pos_can_operate` are all untouched.

### Step 5B — Refund reconciliation *(implemented)*
The refund HTTP call lives outside the DB transaction, so it can fail or (worse) *succeed
with a lost response* — leaving a `refunds` row stuck `requested` with a NULL
`provider_refund_id` while money moved at Razorpay. `0043` closes this **additively** (two
operational columns `attempts`, `last_reconciled_at`; no accounting change).

**Provider correlation.** Every initiated refund now carries **our `refunds.id`** as the
Razorpay `receipt` *and* `notes.refund_id`. `receipt` is Razorpay's **per-payment idempotency
key** (verified: reusing it returns HTTP 400 *"Duplicate receipt found for this refund
request"*), so a resubmit can never create a second refund; `notes` is echoed on the entity and
the webhook, giving deterministic correlation.

**Webhook self-heal** (`apply_razorpay_refund_result`, redefined in `0043`). When a
`refund.processed` arrives whose `provider_refund_id` matches no local row (the lost-response
case), it correlates on `notes.refund_id` — **only** for an open row, unbound (or bound to this
same id), with a **matching amount** — attaches, and settles. Any mismatch stays observable
(`REFUND_NOT_FOUND`); it never guesses.

**Reconciler.** `POST /api/payments/razorpay/reconcile` — server-only, gated by a dedicated
`REFUND_RECONCILE_SECRET` (fail-closed), method-restricted, rate-limited, **bounded batch**,
driven by cron like `/api/channel/sync` (no pg_cron, no worker). `claim_refunds_for_reconcile`
leases open (`requested`/`processing`) rows with **`FOR UPDATE SKIP LOCKED`** (concurrent runs
take disjoint work) and stamps `last_reconciled_at` (spacing). Per row it asks Razorpay
(`GET /payments/:id/refunds`) for **our** refund (matched by receipt / `notes.refund_id`): if
found → attach, and on a provider-confirmed `processed`/`failed` drive the existing lifecycle;
if genuinely absent and still `requested` → submit exactly one (same correlation); anything
ambiguous is left for the next pass. **Money rule preserved:** the negative payment is posted
only on a **provider-confirmed** `processed` state (webhook or authenticated fetch) — never on an
API 200 — and `refunds.provider_refund_id` / `payment_events` / `payments(reference)` UNIQUE keep
every effect exactly-once. `0040`–`0042` accounting, `confirm_hold`, `payments` structure, and
the Phase-4 amount invariant are untouched.

### Phase 6 — Go live *(report first, change nothing until approved)*
Enumerate every test key/URL/assumption; checklist of what must change for live keys and what
**cannot** be tested in test mode; confirm webhook registered for exactly the handled events
(unhandled → logged, not dropped); confirm refunds enabled + live refund flow; add a payments
panel to the owner/manager section (today's payments, pending settlements, failed, refunds in
flight); confirm nothing guest-facing displays or implies GST. Then, by hand before opening to
guests: one real ₹1 booking end-to-end on a real phone; one real refund followed to the bank;
settlement (T+2) matches; both staff walk a console cancellation; watch the first three real
bookings through.

---

## 7. Still open with the owner

None block Phases 0–1; all are needed before **Phase 2 ships**.

1. **Peak-season rule** — different from the standard 24h, or the same all year?
2. **Group bookings** — 72h for 4+ units, or one rule for everyone? (`group_*` columns are
   nullable/undecided until this lands.)
3. **Early departure** — charge the remaining nights or not? *(Proposed: not.)*
4. **Who physically counts the café cash** — decides whether the Phase 1 blind cash drop is
   worth building.

---

## 8. Discipline

- **One phase per session. Never two.** Verify each phase yourself before the next — run the
  tests, read the diff. Not the summary — the output.
- **Every phase prepends the same preamble** (frozen rules + "list files you'll touch first" +
  "if a decision isn't in the design docs, STOP and ask — don't infer").
- **Watch for three red flags in generated code** and re-read the relevant phase if any appear:
  touching `reservations.status`; deleting folio rows instead of reversing them; a third role
  vocabulary.
