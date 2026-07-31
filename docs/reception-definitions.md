# Reception — definitions

> ⚠️ **These are proposals, not decisions you made.** The original brief referenced a
> `docs/reception-definitions.md` that never existed in the repo. Rather than block, the
> definitions below were chosen and implemented; correct anything that's wrong and the
> code follows. The occupancy denominator (§2) is the one most worth your attention.

---

## 1. Events

A **reception activity feed**, not an audit log. `docs/foundation.md` §7 explicitly cut
"audit logs beyond `created_by`/`created_at`", so this stays deliberately thin: enough to
answer "what just happened at the desk?" on the dashboard, and nothing more.

```sql
create table events (
  id             uuid primary key default gen_random_uuid(),
  at             timestamptz not null default now(),
  kind           text not null,          -- 'noun.verb', see vocabulary below
  actor_id       uuid,                   -- NOT an FK; see immutability note
  actor_label    text,                   -- snapshot, survives staff deletion
  reservation_id uuid,
  unit_id        uuid,
  folio_id       uuid,
  summary        text not null,          -- human sentence, rendered as-is
  payload        jsonb not null default '{}'
);
```

**Rules**

- **Exactly one event per mutating operation.** A group booking of four beds writes ONE
  `reservation.created`, not four. Event count tracks desk actions, not row writes.
- **Same transaction as the mutation.** A booking that rolls back leaves no event; an
  event in the feed is proof the thing actually happened.
- **`kind` has no CHECK constraint.** A new event type is an INSERT, not a migration —
  same reasoning as `room_types.code` in the foundation.
- **`actor_label` is a snapshot.** `actor_id` goes null if a staff account is deleted;
  the label keeps the feed readable.
- **Immutable, enforced by BEFORE UPDATE / BEFORE DELETE triggers** — a feed you
  can rewrite is not evidence of anything. This is why the id columns are NOT
  foreign keys: `on delete set null` is an UPDATE, which the trigger refuses, so
  one FK would make deleting a reservation impossible. History also has to
  outlive the rows it describes.
- **`summary` is written at log time**, not composed at render time, so the feed never
  needs joins to display and reads correctly even after the referenced row changes.

**Vocabulary** (current)

| kind | written by |
|---|---|
| `reservation.created` | `create_reservation` |
| `reservation.cancelled` | `cancel_reservation` |
| `allocation.moved` | `move_allocation` |
| `unit.blocked` | `block_unit` |
| `guest.checked_in` | check-in (not built yet) |
| `guest.checked_out` | check-out (not built yet) |

---

## 2. Occupancy — unit-nights

```
occupancy % = sold unit-nights / sellable unit-nights
```

Over a date range, for each night in `[from, to)`:

- **Sold unit-night** — a unit held by an allocation with `reason = 'booking'` whose
  reservation is in `hold`, `confirmed`, `checked_in` or `checked_out`. Cancelled and
  no-show reservations are not sold.
- **Sellable unit-night** — a unit that is `active`, in a room that is `active`, and
  **not** blocked that night by a non-booking allocation (`maintenance`, `owner_use`,
  `hold`), and whose room is not `out_of_order`.

**The judgement call:** blocked and out-of-order units are excluded from **both** the
numerator and the denominator. A dorm bed with a broken heater was never sellable, so
counting it as an unsold bed would drag the number down for something reception cannot
influence. This is the standard PMS treatment, but it means occupancy can read 100% while
beds sit empty — if you'd rather see the honest-but-harsher version, move blocked units
into the denominator only, and say so here.

Other notes:

- A **dorm bed is one unit**, so a six-bed dorm contributes six unit-nights per night —
  not one. This is why the foundation collapsed rooms and beds into `units`.
- Occupancy for a **single date** is that date's night, i.e. `[date, date+1)`.
- A stay of `[Mar 1, Mar 4)` is **three** sold unit-nights, not four. Checkout day is not
  a night.

---

## 3. "Today"

Always **Asia/Kolkata**, computed server-side (`(now() at time zone 'Asia/Kolkata')::date`).
Never the browser clock — a tablet with a wrong timezone must not change which arrivals
reception sees.

---

## 4. GST — registered, not charged

The property **is** GST-registered but is **not charging GST**, by decision. Every
`folio_items.tax_rate` is 0 and no tax line is rendered anywhere. Bills therefore carry
"Not a tax invoice" and **must not be handed to guests as tax invoices**.

The structure is already in place so switching it on is small. When the treatment is
confirmed, this is the whole job:

1. **Decide the slab per line kind.** Room nights depend on the nightly rate — post-Sept-2025
   the bands are exempt under ₹1,000, 5% from ₹1,001–₹7,500, 18% above. At the confirmed
   prices a ₹300 dorm bed is exempt and an ₹1,800 room is at 5%, *in the same booking* —
   which is exactly why `tax_rate` lives per line and not as a constant.
2. **Set `tax_rate` when posting.** Three places write folio lines:
   `ensure_room_charges` (room nights), `pos_post_lines` (café), `stays_add_charge` (extras).
   Each sets `tax_rate` instead of leaving the default.
3. **Show it.** Add a tax subtotal to the statement in
   `src/components/stays/departures-list.tsx` and drop the "Not a tax invoice" note.
4. **Invoice numbering.** A sequence plus a column on `folios`; not built, because an
   invoice number that isn't gapless-and-sequential is worse than none.

Nothing above changes a table definition. That is the point.

---

## 5. Prices

Set by `0022_confirmed_rates.sql`: dorm ₹300/bed, deluxe ₹1,800, premium ₹1,800,
family ₹2,000 — **flat for every date**.

Seasonal, weekend and off-season pricing is deliberately *not* a rules engine (foundation §4).
It is a script that writes `rates` rows for the dates concerned, plus a grid where the owner
overrides a single date. Adding it changes no schema.
