"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, LogOut, ReceiptIndianRupee, X } from "lucide-react";
import { checkOut, type CheckoutResult } from "@/lib/stays/checkout";
import { formatPaise, paiseToRupees } from "@/lib/money";
import type { Departure, Folio } from "@/lib/stays/departures";

/**
 * Departures and the checkout drawer.
 *
 * The statement is read out before any money is taken, so the folio comes down
 * with the list rather than being fetched when the drawer opens.
 */

const field =
  "w-full rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber";
const labelCls = "font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage";

const KIND_LABEL: Record<string, string> = {
  room_night: "Room",
  food: "Food",
  beverage: "Drinks",
  extra: "Extra",
  discount: "Discount",
  tax: "Tax",
};

export function DeparturesList({ departures }: { departures: Departure[] }) {
  const [open, setOpen] = useState<Departure | null>(null);

  if (departures.length === 0) {
    return (
      <p className="mt-6 rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
        Nobody due out. Anyone still in-house past their checkout date would show
        here too.
      </p>
    );
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {departures.map((d) => (
          <li key={d.reservationId}>
            <button
              type="button"
              onClick={() => setOpen(d)}
              className="flex w-full items-center justify-between gap-3 rounded-card border hairline bg-forest/40 p-4 text-left transition-colors hover:border-amber"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-base text-paper">{d.guestName}</span>
                  {d.overdue && (
                    <span className="font-data inline-flex items-center gap-1 rounded-full border border-amber/50 px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-amber">
                      <AlertTriangle size={10} aria-hidden /> due {d.checkout}
                    </span>
                  )}
                  {d.folio.openOrders.length > 0 && (
                    <span className="font-data rounded-full border border-amber/50 px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-amber">
                      café open
                    </span>
                  )}
                </div>
                <p className="font-data mt-1 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                  {d.code} · {d.rooms.join(", ")} · {d.guests} guest
                  {d.guests === 1 ? "" : "s"}
                </p>
              </div>
              <span
                className={`shrink-0 font-display text-base font-bold ${
                  d.folio.balancePaise > 0 ? "text-amber" : "text-emerald-400"
                }`}
              >
                {formatPaise(d.folio.balancePaise)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open && <CheckoutDrawer departure={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Statement({ folio }: { folio: Folio }) {
  return (
    <div className="mt-4 rounded-xl border hairline bg-pine/30 p-3">
      <p className={labelCls}>Statement</p>

      <ul className="mt-2 space-y-1.5">
        {folio.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 text-sage">
              <span className="font-data mr-2 text-[0.55rem] uppercase tracking-[0.12em] text-sage/60">
                {KIND_LABEL[i.kind] ?? i.kind}
              </span>
              {i.description}
            </span>
            <span
              className={`shrink-0 tabular-nums ${
                i.amountPaise < 0 ? "text-emerald-400" : "text-paper"
              }`}
            >
              {formatPaise(i.amountPaise)}
            </span>
          </li>
        ))}
        {folio.items.length === 0 && (
          <li className="py-2 text-sm text-sage/70">Nothing charged yet.</li>
        )}
      </ul>

      <dl className="mt-3 space-y-1 border-t hairline pt-3 text-sm">
        <Row label="Charges" value={formatPaise(folio.chargesPaise)} />
        {folio.payments.map((p) => (
          <Row
            key={p.id}
            label={`Paid · ${p.method}`}
            value={`− ${formatPaise(p.amountPaise)}`}
            muted
          />
        ))}
        <div className="flex justify-between gap-3 border-t hairline pt-2 font-display text-base font-bold">
          <dt className="text-paper">Balance</dt>
          <dd className={folio.balancePaise > 0 ? "text-amber" : "text-emerald-400"}>
            {formatPaise(folio.balancePaise)}
          </dd>
        </div>
      </dl>

      {/* No tax line: the GST slab treatment is deliberately deferred. */}
      <p className="mt-2 text-[0.65rem] text-sage/60">
        Not a tax invoice — GST treatment pending.
      </p>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className={muted ? "text-sage/70" : "text-sage"}>{label}</dt>
      <dd className={`tabular-nums ${muted ? "text-sage/70" : "text-paper"}`}>{value}</dd>
    </div>
  );
}

function CheckoutDrawer({
  departure,
  onClose,
}: {
  departure: Departure;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<CheckoutResult | null, FormData>(
    checkOut,
    null,
  );
  const [discount, setDiscount] = useState("");
  const blocked = departure.folio.openOrders.length > 0;
  const due = departure.folio.balancePaise;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-pine/70 backdrop-blur-sm"
      />
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto border-l hairline bg-forest p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-data text-[0.6rem] uppercase tracking-[0.16em] text-amber">
              {departure.code} · {departure.checkin} → {departure.checkout}
            </p>
            <h2 className="mt-1 font-display text-xl font-extrabold text-paper">
              {departure.guestName}
            </h2>
            <p className="mt-1 text-sm text-sage">{departure.rooms.join(", ")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border hairline p-2 text-sage hover:text-paper"
            aria-label="Close"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* Shown, not hidden — reception needs to know what to go and settle. */}
        {blocked && (
          <div className="mt-4 rounded-xl border border-amber/50 bg-amber/5 p-3">
            <p className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-amber">
              Café orders still open
            </p>
            <ul className="mt-2 space-y-1">
              {departure.folio.openOrders.map((o) => (
                <li key={o.id} className="flex justify-between gap-3 text-sm text-paper">
                  <span>
                    {o.where} · {o.ref}{" "}
                    <span className="text-sage">({o.status})</span>
                  </span>
                  <span className="tabular-nums">{formatPaise(o.totalPaise)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-sage">
              Settle or charge them to the room in the POS, then check out here.
            </p>
          </div>
        )}

        <Statement folio={departure.folio} />

        <form action={action} className="mt-5 space-y-4">
          <input type="hidden" name="reservation_id" value={departure.reservationId} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Money name="cash" label="Cash ₹" defaultValue={due > 0 ? paiseToRupees(due) : ""} />
            <Money name="upi" label="UPI ₹" />
            <Money name="card" label="Card ₹" />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Money
              name="discount"
              label="Discount ₹"
              value={discount}
              onChange={setDiscount}
            />
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="discount_reason">
                Reason {Number(discount) > 0 && <span className="text-amber">(required)</span>}
              </label>
              <input
                id="discount_reason"
                name="discount_reason"
                required={Number(discount) > 0}
                placeholder="Why is this being discounted?"
                className={`mt-1 ${field}`}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={pending || blocked}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber px-4 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut size={16} aria-hidden />
            {pending ? "Checking out…" : blocked ? "Settle the café first" : "Take payment & check out"}
          </button>

          {state && !state.ok && (
            <p className="rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-sm text-amber">
              {state.error}
              {state.balancePaise !== undefined && (
                <span className="mt-1 block font-display font-bold">
                  {formatPaise(state.balancePaise)} outstanding
                </span>
              )}
            </p>
          )}
          {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
        </form>

        <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-sage/70">
          <ReceiptIndianRupee size={13} aria-hidden />
          Checking out settles the folio and marks the rooms dirty.
        </p>
      </aside>
    </div>
  );
}

function Money({
  name,
  label,
  defaultValue,
  value,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <div>
      <label className={labelCls} htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        defaultValue={onChange ? undefined : defaultValue}
        value={onChange ? value : undefined}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className={`mt-1 ${field}`}
      />
    </div>
  );
}
