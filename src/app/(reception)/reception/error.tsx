"use client";

import { useEffect } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

/**
 * The ONLY Client Component in the dashboard, and only because reset() needs an
 * event handler. A failed dashboard shows a retry, never a blank page — patchy
 * internet in Bir means this path gets used.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Reception dashboard failed:", error);
  }, [error]);

  return (
    <div className="rounded-2xl border hairline bg-forest/40 p-6 text-center sm:p-10">
      <TriangleAlert size={28} className="mx-auto text-amber" aria-hidden />

      <h1 className="mt-4 font-display text-xl font-extrabold text-paper">
        The dashboard didn&apos;t load
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-sage">
        This is usually the connection rather than the data. Nothing has been
        changed — try again.
      </p>

      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
      >
        <RefreshCw size={16} aria-hidden />
        Try again
      </button>

      {error.digest && (
        <p className="font-data mt-4 text-[0.6rem] uppercase tracking-[0.14em] text-sage/60">
          ref {error.digest}
        </p>
      )}
    </div>
  );
}
