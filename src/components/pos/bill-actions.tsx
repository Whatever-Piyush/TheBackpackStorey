"use client";

import { useActionState, useState } from "react";
import { BedDouble } from "lucide-react";
import { chargeToRoom, settleOrder, type PosResult } from "@/lib/pos/settlement";
import { PAYMENT_METHODS, type CheckedInGuest, type OpenOrder } from "@/lib/pos/types";
import { formatPaise } from "@/lib/money";

/**
 * Settle a bill, or push it onto an in-house guest's folio.
 *
 * Client-side only for the pending/error states — the money itself is moved by
 * a single transactional call on the server.
 */
export function BillActions({
  order,
  guests,
}: {
  order: OpenOrder;
  guests: CheckedInGuest[];
}) {
  const [settleState, settle, settling] = useActionState<PosResult | null, FormData>(
    settleOrder,
    null,
  );
  const [roomState, charge, charging] = useActionState<PosResult | null, FormData>(
    chargeToRoom,
    null,
  );
  const [showGuests, setShowGuests] = useState(false);

  const busy = settling || charging;
  const error =
    settleState && !settleState.ok
      ? settleState.error
      : roomState && !roomState.ok
        ? roomState.error
        : null;

  return (
    <div className="mt-3 border-t hairline pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {PAYMENT_METHODS.map((m) => (
          <form key={m.value} action={settle}>
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="method" value={m.value} />
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
            >
              {m.label}
            </button>
          </form>
        ))}

        {/* Hidden entirely when nobody is in-house — never a dead control. */}
        {guests.length > 0 && (
          <button
            type="button"
            onClick={() => setShowGuests((v) => !v)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
          >
            <BedDouble size={15} aria-hidden />
            Charge to room
          </button>
        )}

        <span className="ml-auto font-display text-base font-bold text-paper">
          {formatPaise(order.totalPaise)}
        </span>
      </div>

      {showGuests && guests.length > 0 && (
        <form action={charge} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="order_id" value={order.id} />
          <select
            name="reservation_id"
            required
            className="min-w-0 flex-1 rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber"
          >
            <option value="">Which guest?</option>
            {guests.map((g) => (
              <option key={g.reservationId} value={g.reservationId}>
                {g.guestName}
                {g.rooms.length > 0 ? ` — ${g.rooms.join(", ")}` : ""} ({g.code})
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-amber px-4 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
          >
            {charging ? "Charging…" : "Charge"}
          </button>
        </form>
      )}

      {busy && <p className="mt-2 text-xs text-sage">Working…</p>}
      {error && <p className="mt-2 text-sm text-amber">{error}</p>}
    </div>
  );
}
