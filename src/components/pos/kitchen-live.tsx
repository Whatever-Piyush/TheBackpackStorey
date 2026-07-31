"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Keeps the kitchen board fresh. The ONLY client component on this screen — it
 * holds no ticket data of its own, it just tells the server component to
 * re-render, so the query lives in exactly one place.
 *
 * Realtime plus a polling fallback: the café is on hill internet and the socket
 * WILL drop. A board that silently stops updating is worse than a slow one.
 */

const POLL_MS = 20_000;

export function KitchenLive() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("pos-kitchen")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_items" },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        () => router.refresh(),
      )
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));

    // Runs regardless of socket state — this is the safety net, not an optimisation.
    const poll = setInterval(() => router.refresh(), POLL_MS);

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [router]);

  return (
    <span
      className="font-data inline-flex items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.16em] text-sage"
      title={
        connected
          ? "Live — updates arrive instantly"
          : "Reconnecting — refreshing every 20 seconds"
      }
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber animate-pulse"}`}
      />
      {connected ? "Live" : "Polling"}
    </span>
  );
}
