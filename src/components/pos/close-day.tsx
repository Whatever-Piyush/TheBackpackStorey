"use client";

import { useActionState } from "react";
import { Lock } from "lucide-react";
import { closeDay, type PosResult } from "@/lib/pos/settlement";

/** Owner-only sign-off. Client-side purely for the pending and error states. */
export function CloseDayButton({ date, openOrders }: { date: string; openOrders: number }) {
  const [state, action, pending] = useActionState<PosResult | null, FormData>(closeDay, null);

  return (
    <div className="mt-4">
      <form action={action}>
        <input type="hidden" name="date" value={date} />
        <button
          type="submit"
          disabled={pending || openOrders > 0}
          className="inline-flex items-center gap-2 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Lock size={15} aria-hidden />
          {pending ? "Closing…" : "Close the day"}
        </button>
      </form>

      {openOrders > 0 && (
        <p className="mt-2 text-sm text-sage">
          {openOrders} bill{openOrders === 1 ? "" : "s"} still open — settle{" "}
          {openOrders === 1 ? "it" : "them"} first.
        </p>
      )}
      {state && !state.ok && <p className="mt-2 text-sm text-amber">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-emerald-400">{state.message}</p>}
    </div>
  );
}
