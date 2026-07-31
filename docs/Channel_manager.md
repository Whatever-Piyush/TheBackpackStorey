# Channel-Manager Architecture — proposal for approval

> **Status: APPROVED — being implemented.** Supersedes ROADMAP M5.
>
> Approved with one correction, which is now the design: there is **no
> `inventory_mode`**. Inventory is *always* pooled and always derived from
> physical units and allocations. Only `distribution_mode` varies — see §9b.

---

## 1. The one idea

The PMS owns inventory, rates, availability and reservations. A Channel Manager
is a **transport**. It carries numbers outward and reservations inward, and it
has no authority over either.

Concretely, that means one rule the whole design serves:

> **The reservation engine must be unable to tell where a reservation came from,
> and unable to tell which Channel Manager is installed.**

"Unable", not "careful not to". If `create_reservation()` can import a STAAH
type, someone eventually will. The boundary has to be structural.

---

## 2. Architecture

```
                    ┌──────────────────────────────────────┐
   Website ────────►│                                      │
   Reception ──────►│        RESERVATION ENGINE            │
   Integration ────►│        create_reservation()          │
        ▲           │   (knows: room types, dates, units)  │
        │           │   (knows nothing about channels)     │
        │           └──────────────────┬───────────────────┘
        │                              │ same transaction
        │                              ▼
        │                     ┌──────────────────┐
        │                     │ channel_outbox   │  transactional outbox
        │                     └────────┬─────────┘
        │                              │
        │           ┌──────────────────▼───────────────────┐
        └───────────┤        INTEGRATION LAYER             │
                    │  registry → ChannelProvider          │
                    │  (the ONLY place that knows STAAH)   │
                    └──────────────────┬───────────────────┘
                                       │
                    ┌──────────────────▼───────────────────┐
                    │   MockProvider / STAAHProvider / …   │
                    └──────────────────┬───────────────────┘
                                       │
                              Channel Manager
                                       │
              Booking.com · MMT · Agoda · Hostelworld · Expedia · Airbnb
```

**Three layers, one direction of dependency:**

| Layer | Knows about | Never knows about |
|---|---|---|
| Reservation engine (SQL) | room types, units, dates, sources-as-data | providers, payloads, HTTP |
| Integration layer (TS) | our normalised DTOs, the outbox, the registry | STAAH's field names |
| Provider (TS) | one vendor's API, auth and payload shape | our tables, our SQL |

A provider never touches the database. The integration layer never imports a
provider directly — only through the registry. That is what makes the vendor
swappable.

---

## 3. Event flow

### 3a. Any reservation is created (website, reception, or OTA)

```
create_reservation()
  ├─ allocations inserted            ← exclusion constraint decides
  ├─ folio + charges posted
  ├─ log_event()                     ← human feed (unchanged)
  └─ enqueue_channel_sync()          ← SAME TRANSACTION
                │
                ▼
        channel_outbox row  {kind: 'availability', scope: type+dates}
                │
                ▼  (drained by worker, out of band)
        Integration Layer
                │
                ▼
        provider.syncAvailability(snapshot)
                │
                ▼
        Channel Manager → every OTA updated
```

The enqueue is a **trigger on `allocations`**, not a call inside
`create_reservation`. A trigger cannot be forgotten by a future code path —
extend-stay, move-allocation, block-unit and cancel all mutate `allocations`, so
all of them sync for free.

### 3b. A reservation arrives from an OTA

```
Channel Manager  ──HTTP──►  /api/channel/[provider]/webhook
                                    │
                                    ▼
                      provider.verify(request)        ← signature
                                    ▼
                      provider.receiveReservation(raw)
                                    │  translates vendor payload → our DTO
                                    ▼
                        channel_inbox (dedupe by external id)
                                    │
                                    ▼
                          create_reservation()        ← the SAME engine
                                    │
                          allocations → outbox → sync
                                    ▼
                      every other OTA closed automatically
```

The engine is handed `{roomTypeId, checkin, checkout, units, source, externalRef,
prepaidAmount}`. It cannot tell that came from Agoda.

### 3c. Rates change

```
rates UPDATE ──trigger──► outbox {kind:'rates'} ──► provider.syncRates()
```

### 3d. Cancellation / modification — both directions

Outbound: `allocations` DELETE or `stay` UPDATE → outbox → `reservationCancelled()` / `reservationModified()`.
Inbound: webhook → `receiveCancellation()` / `receiveModification()` → `cancel_reservation()` / `stays_extend`/`stays_shorten`.

---

## 4. Why a transactional outbox, and not a direct call

This is the load-bearing decision, so it is worth stating plainly.

**Rejected: call the provider inside `create_reservation`.**
An HTTP call cannot be rolled back. If the booking then fails, the OTAs have
already been told about a reservation that does not exist. If the call is slow,
it holds a database transaction open across the internet. If the Channel Manager
is down — and this property is on hill internet — bookings stop.

**Chosen: write an outbox row in the same transaction, drain it separately.**

- The booking and the intent-to-sync commit or fail together. A sync can never be *missed*.
- The Channel Manager being down delays a sync; it never blocks a booking.
- Retries are ordinary: a row with `attempts` and `next_attempt_at`.
- The website is unaffected either way, because it reads availability **from the PMS**, never from the Channel Manager.

**Staleness.** Each outbox row carries a monotonic `sequence`. When the worker
finds several rows for the same scope it sends only the newest and discards the
rest — an old availability number must never land after a new one.

---

## 5. Components

### 5a. Database (new migrations)

| Object | Purpose |
|---|---|
| `channels` | Reference table: `website`, `reception`, `phone`, `booking_com`, `mmt`, `agoda`, `hostelworld`, `expedia`, `airbnb`, … Adding an OTA becomes an INSERT. |
| `channel_providers` | Which provider is installed, its config, enabled flag. Zero or one active. |
| `property_settings.distribution_mode` | `manual` or `channel_manager`. Changes **how availability is published**, never how it is calculated. |
| `channel_outbox` | id, kind, scope, payload, sequence, status, attempts, next_attempt_at, last_error |
| `channel_inbox` | provider, external_id, kind, payload, status (`applied`/`duplicate`/`failed`), error. **Unique on (provider, external_id)** — a webhook retry cannot book twice. |
| `enqueue_channel_sync()` | Trigger function; writes one coalesced outbox row per scope. |
| triggers on `allocations`, `rates`, `direct_allotment`, `units` | So no code path can forget to sync. |
| `inventory_snapshot(from, to)` | The canonical availability payload the PMS publishes. One function, provider-neutral. |
| `create_channel_reservation()` | Generalised `create_ota_booking` — takes a channel code and an optional prepaid amount. Knows nothing of vendors. |

### 5b. Integration layer (TypeScript, `src/lib/channel/`)

| File | Purpose |
|---|---|
| `types.ts` | Normalised DTOs: `AvailabilitySnapshot`, `RateSnapshot`, `ReservationSnapshot`, `InboundReservation`, `InboundCancellation`, `InboundModification`, `SyncResult` |
| `provider.ts` | The `ChannelProvider` interface — the contract, and nothing else |
| `registry.ts` | `getActiveProvider()`. The only file that maps an id to an implementation |
| `outbox.ts` | Claim → send → mark done/failed, with backoff and stale-coalescing |
| `ingest.ts` | Inbound: dedupe, call the engine, record the result |
| `providers/mock.ts` | `MockProvider` — records calls, returns success. Runs in tests and before a contract is signed |
| `providers/staah.ts` *(later)* | One vendor. ~200 lines. Nothing else changes |

### 5c. The interface

```ts
interface ChannelProvider {
  readonly id: string;

  // outbound — PMS tells the world
  syncAvailability(s: AvailabilitySnapshot): Promise<SyncResult>;
  syncRates(s: RateSnapshot): Promise<SyncResult>;
  reservationCreated(r: ReservationSnapshot): Promise<SyncResult>;
  reservationModified(r: ReservationSnapshot): Promise<SyncResult>;
  reservationCancelled(r: ReservationSnapshot): Promise<SyncResult>;

  // inbound — the world tells the PMS. Pure translation: no database access.
  verify(req: IncomingRequest): boolean;
  receiveReservation(raw: unknown): InboundReservation;
  receiveCancellation(raw: unknown): InboundCancellation;
  receiveModification(raw: unknown): InboundModification;
}
```

Inbound methods are **pure functions**. They translate and validate; they do not
write. That keeps a vendor bug from becoming a data-integrity bug, and makes them
trivially testable against recorded fixtures.

### 5d. Routes and screens

| Route | Purpose |
|---|---|
| `POST /api/channel/[provider]/webhook` | Inbound. Verifies, translates, ingests |
| `POST /api/channel/sync` | Drains the outbox. Cron-invoked, plus a best-effort nudge after a booking |
| `/stays/channel` | Queue depth, last successful sync per kind, failures, **the overbooking queue** |

---

## 6. Files and migrations affected

**New migrations** — `0026` channels + settings · `0027` outbox + triggers + snapshot ·
`0028` inbox + `create_channel_reservation` · `0029` availability respects inventory mode.

**New files** — `src/lib/channel/*` (7 files) · `src/app/api/channel/*` (2 routes) ·
`src/app/(portal)/stays/channel/page.tsx` · `tests/channel.test.mts` ·
`tests/provider-contract.test.mts`.

**Modified** — `public_availability` (mode-aware) · `/stays/ota` (becomes the manual
provider path) · `/stays/allotment` (warns when pooled) · `stays` index page.

**Deleted** — nothing. `create_ota_booking` is superseded but left in place until
the new path has run in production for a while.

---

## 7. How this replaces M5

M5 exists because the roadmap assumed **no channel manager** and said so
explicitly: MMT and Goibibo have no open API for a single property, so it chose
"Option A — allotment + manual OTA entry (free, do this)". You are now choosing
Option B, and that changes the inventory model.

| M5 today | After |
|---|---|
| Inventory **split**: N units for the website, the rest for OTAs | Inventory **pooled**, always: physical units minus allocations |
| `direct_allotment` caps what the website may sell | No longer consulted. Table kept, unread, pending removal |
| `direct_availability()` — allotment-capped | `inventory_snapshot()` — pooled |
| `create_reservation(p_respect_allotment)` | Parameter dropped; there is nothing to respect |
| A human reads OTA email and types it in | Provider webhook does it; manual entry stays as fallback |
| `create_ota_booking()` — knows OTA sources | `create_channel_reservation()` — knows channels-as-data |
| Source CHECK lists specific OTAs | `channels` table + FK; adding Agoda is an INSERT |
| `/stays/allotment` | Superseded by `/stays/channel` |

**M5 is not wasted.** Manual OTA entry stays as the fallback for a channel the CM
doesn't carry, and for the hours after a CM outage.

---

## 8. Adding a provider in under a day

1. **Write `providers/<vendor>.ts`** — auth, three outbound mappers, three inbound parsers, one signature check. ~200 lines against the vendor's docs.
2. **Register it** — one line in `registry.ts`.
3. **Insert a row** in `channel_providers` with credentials, flip it active.
4. **Run the contract suite** — `tests/provider-contract.test.mts` runs *every* registered provider against the same normalised fixtures and asserts the same behaviour: a snapshot round-trips, a duplicate inbound reservation is idempotent, a malformed payload is rejected rather than partially applied.

No schema change. No change to `create_reservation`. No change to the website.
The contract suite is what makes the estimate real — without it, "swappable" is a
claim rather than a property.

---

## 9. Two decisions I need from you

### 9a. This touches the frozen foundation

`0006_reservations.sql` constrains the source column:

```sql
check (source in ('website','walk_in','phone','ota_booking','ota_goibibo',
                  'ota_hostelworld','ota_airbnb','other'))
```

Agoda and Expedia are **not in that list**, and your requirement is explicitly
"future OTAs". A hardcoded list means every new OTA needs a migration — the exact
thing this redesign exists to prevent.

**Proposed:** drop that CHECK in a new migration and validate against the
`channels` table instead. The foundation is frozen and you asked to be told
rather than worked around, so: **I need your yes.**

### 9b. RESOLVED — `distribution_mode`, not `inventory_mode`

My original proposal was an `inventory_mode` that switched availability between
allotment-capped and pooled. **Rejected, correctly.** It would have given the
most important number in the system two code paths, and "which formula is live
today?" is not a question anyone should have to ask about availability.

**The approved design:**

> Inventory is **always** pooled, and always derived from physical units and
> allocations. `distribution_mode` changes only how the result is *published*.

| `distribution_mode` | Inventory calculation | What happens after a change |
|---|---|---|
| `manual` | physical units − allocations | Outbox row → **ManualProvider** → a task on `/stays/channel` telling staff exactly which numbers changed, to be entered in each extranet and acknowledged |
| `channel_manager` | **identical** | Outbox row → configured provider → `syncAvailability()` → every OTA |

The elegance is that manual distribution is not a special case: **staff are a
provider**. Same outbox, same retry visibility, same acknowledgement, same page.
Switching to a real Channel Manager changes which implementation the registry
returns and nothing else.

The oversell risk in manual mode is real and is managed by making the reminder
loud and acknowledgeable, not by quietly capping what the website may sell.

---

## 10. Honest limits

- **A CM is not instant.** Propagation is seconds to minutes. Pooled inventory means a genuine overbooking window exists. The design handles it by recording a failed inbound in the **overbooking queue** for staff, never by silently dropping a reservation.
- **Nothing here is testable end-to-end without a vendor account.** MockProvider proves the architecture; it does not prove STAAH works. Budget a day of real integration when the contract is signed.
- **Cost.** A CM is ₹1–2.5k/month. The roadmap's judgement was that at 9 units this only pays for itself when you are regularly near-full. That judgement is yours to overrule; this document assumes you have.
