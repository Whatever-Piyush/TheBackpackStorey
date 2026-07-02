"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Minus, Plus, Trash2 } from "lucide-react";
import { createOrder, type OrderType } from "@/lib/pos/actions";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import type { MenuCategory } from "@/lib/pos/types";

type Room = { id: string; name: string };
type Line = { name: string; price: number; qty: number; notes: string };

const TYPES: { value: OrderType; label: string }[] = [
  { value: "dine_in", label: "Dine-in" },
  { value: "takeaway", label: "Takeaway" },
  { value: "room", label: "Room" },
];

export function OrderBuilder({
  categories,
  rooms,
}: {
  categories: MenuCategory[];
  rooms: Room[];
}) {
  const [type, setType] = useState<OrderType>("dine_in");
  const [tableLabel, setTableLabel] = useState("");
  const [roomId, setRoomId] = useState("");
  const [cart, setCart] = useState<Record<string, Line>>({});
  const [discount, setDiscount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ref: string; total: number } | null>(null);
  const [pending, start] = useTransition();

  const entries = Object.entries(cart);
  const subtotal = useMemo(
    () => entries.reduce((s, [, l]) => s + l.price * l.qty, 0),
    [entries],
  );
  const discountPaise = Math.min(Math.max(0, rupeesToPaise(discount) ?? 0), subtotal);
  const total = subtotal - discountPaise;

  function add(id: string, name: string, price: number) {
    setCart((c) => ({
      ...c,
      [id]: c[id] ? { ...c[id], qty: c[id].qty + 1 } : { name, price, qty: 1, notes: "" },
    }));
  }
  function bump(id: string, d: number) {
    setCart((c) => {
      const line = c[id];
      if (!line) return c;
      const qty = line.qty + d;
      if (qty <= 0) {
        const { [id]: _drop, ...rest } = c;
        return rest;
      }
      return { ...c, [id]: { ...line, qty } };
    });
  }
  function setNotes(id: string, notes: string) {
    setCart((c) => (c[id] ? { ...c, [id]: { ...c[id], notes } } : c));
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await createOrder({
        type,
        tableLabel,
        roomId,
        discountPaise,
        items: entries.map(([id, l]) => ({ menuItemId: id, qty: l.qty, notes: l.notes })),
      });
      if (!r.ok) return setError(r.error);
      setResult({ ref: r.ref, total: r.total });
      setCart({});
      setDiscount("");
      setTableLabel("");
    });
  }

  if (result) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-card border hairline bg-forest/70 p-8 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber/15 text-amber">
          <Check size={28} />
        </span>
        <h2 className="mt-4 font-display text-2xl font-extrabold text-paper">Sent to kitchen</h2>
        <p className="font-data mt-1 text-sm text-sage">
          Order <span className="text-amber">{result.ref}</span> · {formatPaise(result.total)}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => setResult(null)}
            className="rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
          >
            New order
          </button>
          <Link href="/pos" className="rounded-full border hairline px-5 py-2.5 text-sm text-sage hover:text-paper">
            Done
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* menu */}
      <div className="space-y-7">
        {categories.map((cat) => {
          const items = cat.items.filter((i) => i.is_available);
          if (items.length === 0) return null;
          return (
            <section key={cat.id}>
              <h2 className="font-display text-lg font-bold text-paper">{cat.name}</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => add(item.id, item.name, item.price_paise)}
                    className="flex items-center justify-between gap-3 rounded-xl border hairline bg-forest/60 px-4 py-3 text-left transition-colors hover:border-amber"
                  >
                    <span className="text-sm text-paper">{item.name}</span>
                    <span className="font-data shrink-0 text-sm text-amber">
                      {formatPaise(item.price_paise)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* cart */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-card border hairline bg-forest/70 p-5">
          {/* type */}
          <div className="flex gap-1.5 rounded-full border hairline p-1">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  type === t.value ? "bg-amber text-pine" : "text-sage hover:text-paper"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {type === "dine_in" ? (
            <input
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              placeholder="Table (e.g. T4)"
              className="mt-3 w-full rounded-xl border hairline bg-pine px-3.5 py-2 text-sm text-paper outline-none focus:border-amber"
            />
          ) : null}
          {type === "room" ? (
            <select
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="mt-3 w-full rounded-xl border hairline bg-pine px-3.5 py-2 text-sm text-paper outline-none focus:border-amber"
            >
              <option value="">Select room…</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          ) : null}

          {/* lines */}
          <div className="mt-4 space-y-3">
            {entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-sage/70">Tap items to add them.</p>
            ) : (
              entries.map(([id, l]) => (
                <div key={id} className="rounded-xl border hairline bg-pine/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-paper">{l.name}</span>
                    <span className="font-data text-sm text-sage">{formatPaise(l.price * l.qty)}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" onClick={() => bump(id, -1)}
                      className="rounded-full border hairline p-1 text-sage hover:text-paper" aria-label="Decrease">
                      <Minus size={14} />
                    </button>
                    <span className="font-data w-6 text-center text-sm text-paper">{l.qty}</span>
                    <button type="button" onClick={() => bump(id, 1)}
                      className="rounded-full border hairline p-1 text-sage hover:text-paper" aria-label="Increase">
                      <Plus size={14} />
                    </button>
                    <input
                      value={l.notes}
                      onChange={(e) => setNotes(id, e.target.value)}
                      placeholder="Note…"
                      className="ml-1 min-w-0 flex-1 rounded-lg border hairline bg-pine px-2.5 py-1 text-xs text-paper outline-none focus:border-amber"
                    />
                    <button type="button" onClick={() => bump(id, -l.qty)}
                      className="text-sage hover:text-ember" aria-label="Remove">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* totals */}
          <div className="mt-4 space-y-2 border-t hairline pt-4 text-sm">
            <div className="flex justify-between text-sage">
              <span>Subtotal</span>
              <span className="font-data text-paper">{formatPaise(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between text-sage">
              <label htmlFor="discount">Discount ₹</label>
              <input
                id="discount"
                type="number"
                min="0"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="w-24 rounded-lg border hairline bg-pine px-2.5 py-1 text-right font-data text-sm text-paper outline-none focus:border-amber"
              />
            </div>
            <div className="flex justify-between font-display text-base font-bold text-paper">
              <span>Total</span>
              <span className="text-amber">{formatPaise(total)}</span>
            </div>
          </div>

          {error ? <p className="mt-3 text-sm text-ember">{error}</p> : null}

          <button
            type="button"
            onClick={submit}
            disabled={pending || entries.length === 0}
            className="mt-4 w-full rounded-full bg-amber px-5 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send to kitchen"}
          </button>
        </div>
      </aside>
    </div>
  );
}
