"use client";

import { useActionState, useRef } from "react";
import { Check, Plus } from "lucide-react";
import { createOtaBooking, type OtaResult } from "@/lib/stays/ota";

/**
 * OTA entry form (ROADMAP M5 item 2).
 *
 * Flat and tab-ordered: source, name, dates, type, units, reference, amount.
 * After a save it clears and refocuses the source so a run of emails can be
 * typed in without touching the mouse.
 */

const field =
  "w-full rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber";
const labelCls = "font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage";

export type OtaRoomType = { roomTypeId: string; name: string; unitNoun: string };
export type OtaChannel = { value: string; label: string };

export function OtaForm({
  types,
  channels,
}: {
  types: OtaRoomType[];
  channels: OtaChannel[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);

  const [state, action, pending] = useActionState<OtaResult | null, FormData>(
    async (prev: OtaResult | null, fd: FormData) => {
      const result = await createOtaBooking(prev, fd);
      if (result.ok) {
        formRef.current?.reset();
        firstRef.current?.focus();
      }
      return result;
    },
    null,
  );

  if (types.length === 0) {
    return (
      <p className="rounded-card border hairline bg-forest/30 p-8 text-center text-sage">
        No room types are set up yet.
      </p>
    );
  }

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="source">
            Channel
          </label>
          <select
            id="source"
            name="source"
            ref={firstRef}
            defaultValue={channels[0]?.value}
            className={`mt-1 ${field}`}
          >
            {channels.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="reference">
            Their reference
          </label>
          <input
            id="reference"
            name="reference"
            placeholder="Confirmation number"
            className={`mt-1 ${field}`}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="name">
            Guest name
          </label>
          <input id="name" name="name" required className={`mt-1 ${field}`} />
        </div>
        <div>
          <label className={labelCls} htmlFor="phone">
            Phone (optional)
          </label>
          <input id="phone" name="phone" type="tel" className={`mt-1 ${field}`} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="checkin">
            Arrives
          </label>
          <input id="checkin" name="checkin" type="date" required className={`mt-1 ${field}`} />
        </div>
        <div>
          <label className={labelCls} htmlFor="checkout">
            Leaves
          </label>
          <input id="checkout" name="checkout" type="date" required className={`mt-1 ${field}`} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="room_type_id">
            Room type
          </label>
          <select id="room_type_id" name="room_type_id" required className={`mt-1 ${field}`}>
            {types.map((t) => (
              <option key={t.roomTypeId} value={t.roomTypeId}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="units">
            How many
          </label>
          <input
            id="units"
            name="units"
            type="number"
            min={1}
            max={10}
            defaultValue={1}
            required
            className={`mt-1 ${field}`}
          />
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="amount">
          Amount the guest paid the channel (₹)
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className={`mt-1 ${field}`}
        />
        <p className="mt-1 text-xs text-sage/70">
          Recorded as already paid, so checkout shows nothing owing. Our own rate
          calendar is not applied to channel bookings.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber px-4 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
        {pending ? "Entering…" : "Enter booking"}
      </button>

      {state && !state.ok && (
        <p className="rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-sm text-amber">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400">
          <Check size={15} aria-hidden />
          {state.message}
        </p>
      )}
    </form>
  );
}
