"use client";

import { useActionState, useState } from "react";
import { CalendarPlus, CalendarMinus, PlusCircle, TriangleAlert, X } from "lucide-react";
import {
  addCharge,
  extendStay,
  shortenStay,
  type StayResult,
} from "@/lib/stays/stay-actions";
import { formatPaise } from "@/lib/money";
import type { BlockedAllocation, InHouseStay } from "@/lib/stays/in-house";

/**
 * In-house guests: extend, shorten, post a charge.
 *
 * When an extension is refused the drawer shows the choices the database gave
 * back. A split is offered plainly and labelled as a bed change, because that
 * is what the guest experiences.
 */

const field =
  "w-full rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber";
const labelCls = "font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage";

export function InHouseList({ stays }: { stays: InHouseStay[] }) {
  const [open, setOpen] = useState<InHouseStay | null>(null);

  if (stays.length === 0) {
    return (
      <p className="mt-6 rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
        Nobody in-house right now.
      </p>
    );
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {stays.map((s) => (
          <li key={s.reservationId}>
            <button
              type="button"
              onClick={() => setOpen(s)}
              className="flex w-full items-center justify-between gap-3 rounded-card border hairline bg-forest/40 p-4 text-left transition-colors hover:border-amber"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-base text-paper">{s.guestName}</span>
                  {s.dueOutToday && (
                    <span className="font-data rounded-full border border-amber/50 px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-amber">
                      out today
                    </span>
                  )}
                  {s.units.length > 1 && (
                    <span className="font-data rounded-full border hairline px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-sage">
                      {s.units.length} beds
                    </span>
                  )}
                </div>
                <p className="font-data mt-1 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                  {s.code} · {s.units.map((u) => `${u.room}${u.bed ? ` ${u.bed}` : ""}`).join(", ")} ·{" "}
                  {s.nightsLeft} night{s.nightsLeft === 1 ? "" : "s"} left
                </p>
              </div>
              <span
                className={`shrink-0 font-display text-base font-bold ${
                  s.folio.balancePaise > 0 ? "text-paper" : "text-emerald-400"
                }`}
              >
                {formatPaise(s.folio.balancePaise)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open && <StayDrawer stay={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function StayDrawer({ stay, onClose }: { stay: InHouseStay; onClose: () => void }) {
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
              {stay.code} · {stay.checkin} → {stay.checkout}
            </p>
            <h2 className="mt-1 font-display text-xl font-extrabold text-paper">
              {stay.guestName}
            </h2>
            <p className="mt-1 text-sm text-sage">
              {stay.units
                .map((u) => `${u.room}${u.bed ? ` · ${u.bed}` : ""}`)
                .join(" | ")}
            </p>
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

        <dl className="mt-4 flex gap-4 rounded-xl border hairline bg-pine/30 p-3 text-sm">
          <div>
            <dt className={labelCls}>Charges</dt>
            <dd className="text-paper">{formatPaise(stay.folio.chargesPaise)}</dd>
          </div>
          <div>
            <dt className={labelCls}>Paid</dt>
            <dd className="text-paper">{formatPaise(stay.folio.paidPaise)}</dd>
          </div>
          <div>
            <dt className={labelCls}>Balance</dt>
            <dd className="font-display font-bold text-amber">
              {formatPaise(stay.folio.balancePaise)}
            </dd>
          </div>
        </dl>

        <ExtendForm stay={stay} />
        <ShortenForm stay={stay} />
        <ChargeForm stay={stay} />
      </aside>
    </div>
  );
}

function ExtendForm({ stay }: { stay: InHouseStay }) {
  const [state, action, pending] = useActionState<StayResult | null, FormData>(
    extendStay,
    null,
  );
  // Set once reception picks an alternative unit from the refusal.
  const [plan, setPlan] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  const blocked = (state && !state.ok && state.blocked) || [];

  return (
    <form action={action} className="mt-5 space-y-3 border-t hairline pt-5">
      <p className="font-data flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.16em] text-sage">
        <CalendarPlus size={13} aria-hidden /> Extend
      </p>
      <input type="hidden" name="reservation_id" value={stay.reservationId} />
      <input type="hidden" name="plan" value={plan} />

      <div className="flex gap-2">
        <input
          type="date"
          name="checkout"
          defaultValue={stay.checkout}
          min={stay.checkout}
          required
          className={field}
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-xl bg-amber px-4 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
        >
          {pending ? "…" : chosen ? "Confirm" : "Extend"}
        </button>
      </div>

      {state && !state.ok && (
        <p className="text-sm text-amber">{state.error}</p>
      )}
      {state?.ok && (
        <p className="text-sm text-emerald-400">
          {state.message}
          {state.split && (
            <span className="mt-1 flex items-center gap-1.5 text-amber">
              <TriangleAlert size={12} aria-hidden />
              Tell the guest they move bed partway through.
            </span>
          )}
        </p>
      )}

      {blocked.map((b) => (
        <BlockedChoice
          key={b.allocationId}
          blocked={b}
          chosen={chosen}
          onChoose={(action_, unitId) => {
            setChosen(`${action_}:${unitId}`);
            setPlan(
              JSON.stringify([
                { allocationId: b.allocationId, action: action_, unitId },
              ]),
            );
          }}
        />
      ))}
    </form>
  );
}

function BlockedChoice({
  blocked,
  chosen,
  onChoose,
}: {
  blocked: BlockedAllocation;
  chosen: string | null;
  onChoose: (action: "move" | "split", unitId: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-amber/40 bg-amber/5 p-3">
      <p className="text-xs text-sage">
        <span className="text-paper">{blocked.unit}</span> isn&apos;t free for those
        nights.
      </p>

      {blocked.moveOptions.length > 0 && (
        <div>
          <p className={labelCls}>Move — one bed for the whole stay</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {blocked.moveOptions.map((o) => (
              <Choice
                key={o.unitId}
                label={o.label}
                active={chosen === `move:${o.unitId}`}
                onClick={() => onChoose("move", o.unitId)}
              />
            ))}
          </div>
        </div>
      )}

      {blocked.splitOptions.length > 0 && (
        <div>
          <p className={labelCls}>
            Split — <span className="text-amber">guest changes beds</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {blocked.splitOptions.map((o) => (
              <Choice
                key={o.unitId}
                label={o.label}
                active={chosen === `split:${o.unitId}`}
                onClick={() => onChoose("split", o.unitId)}
              />
            ))}
          </div>
        </div>
      )}

      {blocked.moveOptions.length === 0 && blocked.splitOptions.length === 0 && (
        <p className="text-xs text-amber">
          Nothing of this type is free for those nights.
        </p>
      )}
    </div>
  );
}

function Choice({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        active
          ? "border-amber bg-amber text-pine"
          : "hairline text-paper hover:border-amber hover:text-amber"
      }`}
    >
      {label}
    </button>
  );
}

function ShortenForm({ stay }: { stay: InHouseStay }) {
  const [state, action, pending] = useActionState<StayResult | null, FormData>(
    shortenStay,
    null,
  );

  return (
    <form action={action} className="mt-5 space-y-2 border-t hairline pt-5">
      <p className="font-data flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.16em] text-sage">
        <CalendarMinus size={13} aria-hidden /> Leaving early
      </p>
      <input type="hidden" name="reservation_id" value={stay.reservationId} />
      <div className="flex gap-2">
        <input
          type="date"
          name="checkout"
          defaultValue={stay.checkout}
          min={stay.checkin}
          max={stay.checkout}
          required
          className={field}
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
        >
          {pending ? "…" : "Shorten"}
        </button>
      </div>
      <p className="text-xs text-sage/70">
        Removes the room charge for nights they no longer stay.
      </p>
      {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
    </form>
  );
}

function ChargeForm({ stay }: { stay: InHouseStay }) {
  const [state, action, pending] = useActionState<StayResult | null, FormData>(
    addCharge,
    null,
  );

  return (
    <form action={action} className="mt-5 space-y-2 border-t hairline pt-5">
      <p className="font-data flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.16em] text-sage">
        <PlusCircle size={13} aria-hidden /> Add a charge
      </p>
      <input type="hidden" name="reservation_id" value={stay.reservationId} />
      <div className="flex gap-2">
        <input
          name="description"
          placeholder="Laundry, damage, transfer…"
          required
          className={field}
        />
        <input
          name="amount"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder="₹"
          required
          className="w-28 rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
        >
          {pending ? "…" : "Post"}
        </button>
      </div>
      {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
    </form>
  );
}
