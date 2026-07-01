"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, MessageCircle } from "lucide-react";
import { searchAvailability, createBooking } from "@/lib/booking/actions";
import type { AvailOption } from "@/lib/booking/types";
import { formatPaise } from "@/lib/money";
import type { RoomType } from "@/lib/site";

const field =
  "w-full rounded-xl border hairline bg-pine px-3.5 py-2.5 text-paper outline-none focus:border-amber";
const label = "font-data text-xs uppercase tracking-[0.16em] text-sage";

type Step = "search" | "choose" | "details" | "done";

export function BookingWidget({ initialType }: { initialType?: RoomType }) {
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>("search");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [nightsCount, setNightsCount] = useState(0);
  const [options, setOptions] = useState<AvailOption[]>([]);
  const [selected, setSelected] = useState<AvailOption | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ref: string; total: number; whatsapp: string } | null>(null);

  const todayStr = new Date().toISOString().slice(0, 10);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await searchAvailability({ checkIn, checkOut });
      if (!r.ok) return setError(r.error);
      setNightsCount(r.nights);
      setOptions(r.options);
      const pre = initialType ? r.options.find((o) => o.type === initialType && o.freeUnits > 0) : null;
      if (pre) {
        setSelected(pre);
        setStep("details");
      } else {
        setStep("choose");
      }
    });
  }

  function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    start(async () => {
      const r = await createBooking({
        roomType: selected.type,
        checkIn,
        checkOut,
        guests,
        name: form.name,
        phone: form.phone,
        email: form.email,
        notes: form.notes,
      });
      if (!r.ok) return setError(r.error);
      setResult({ ref: r.ref, total: r.total, whatsapp: r.whatsapp });
      setStep("done");
    });
  }

  return (
    <div className="rounded-card border hairline bg-forest/70 p-6 shadow-2xl backdrop-blur sm:p-8">
      {/* stepper */}
      {step !== "done" ? (
        <ol className="font-data mb-6 flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.16em] text-sage">
          {(["search", "choose", "details"] as Step[]).map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={step === s ? "text-amber" : "text-sage/60"}>
                {i + 1}. {s === "search" ? "Dates" : s === "choose" ? "Room" : "Details"}
              </span>
              {i < 2 ? <span className="text-sage/30">→</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {/* ---- step: dates ---- */}
      {step === "search" ? (
        <form onSubmit={runSearch} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={label}>Check-in</span>
              <input type="date" required min={todayStr} value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)} className={`mt-1.5 ${field}`} />
            </label>
            <label className="block">
              <span className={label}>Check-out</span>
              <input type="date" required min={checkIn || todayStr} value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)} className={`mt-1.5 ${field}`} />
            </label>
            <label className="block">
              <span className={label}>Guests</span>
              <input type="number" min={1} max={12} value={guests}
                onChange={(e) => setGuests(Math.max(1, Number(e.target.value) || 1))} className={`mt-1.5 ${field}`} />
            </label>
          </div>
          {error ? <p className="text-sm text-ember">{error}</p> : null}
          <button type="submit" disabled={pending}
            className="inline-flex items-center gap-2 rounded-full bg-amber px-6 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-60">
            {pending ? "Checking…" : "Check availability"} <ArrowRight size={16} />
          </button>
        </form>
      ) : null}

      {/* ---- step: choose room ---- */}
      {step === "choose" ? (
        <div>
          <p className="mb-4 text-sm text-sage">
            {nightsCount} night{nightsCount > 1 ? "s" : ""} · {checkIn} → {checkOut}
          </p>
          <ul className="space-y-3">
            {options.map((o) => {
              const soldOut = o.freeUnits < 1;
              return (
                <li key={o.type}>
                  <button
                    type="button"
                    disabled={soldOut}
                    onClick={() => { setSelected(o); setStep("details"); }}
                    className={`flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition-colors ${
                      soldOut ? "cursor-not-allowed border-transparent bg-pine/40 opacity-50"
                              : "hairline bg-pine/40 hover:border-amber"}`}
                  >
                    <div>
                      <p className="font-display font-bold text-paper">{o.name}</p>
                      <p className="font-data mt-0.5 text-xs text-sage">
                        {soldOut ? "No availability" : `${o.freeUnits} ${o.unitLabel}${o.freeUnits > 1 ? "s" : ""} left`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-display font-bold text-amber">{formatPaise(o.ratePaise)}</p>
                      <p className="font-data text-[0.65rem] text-sage/70">/ {o.unitLabel} / night</p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => setStep("search")}
            className="mt-5 inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper">
            <ArrowLeft size={15} /> Change dates
          </button>
        </div>
      ) : null}

      {/* ---- step: guest details ---- */}
      {step === "details" && selected ? (
        <form onSubmit={confirm} className="space-y-4">
          <div className="rounded-xl border hairline bg-pine/40 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-display font-bold text-paper">{selected.name}</span>
              <span className="font-display font-bold text-amber">
                {formatPaise(selected.ratePaise * nightsCount)}
              </span>
            </div>
            <p className="font-data mt-1 text-xs text-sage">
              {nightsCount} night{nightsCount > 1 ? "s" : ""} · {checkIn} → {checkOut} · {guests} guest{guests > 1 ? "s" : ""}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={label}>Full name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-1.5 ${field}`} />
            </label>
            <label className="block">
              <span className={label}>Phone</span>
              <input required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`mt-1.5 ${field}`} />
            </label>
          </div>
          <label className="block">
            <span className={label}>Email <span className="normal-case text-sage/50">(optional)</span></span>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={`mt-1.5 ${field}`} />
          </label>
          <label className="block">
            <span className={label}>Notes <span className="normal-case text-sage/50">(optional)</span></span>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`mt-1.5 ${field}`} />
          </label>

          {error ? <p className="text-sm text-ember">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending}
              className="inline-flex items-center gap-2 rounded-full bg-amber px-6 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-60">
              {pending ? "Booking…" : "Confirm booking"} <Check size={16} />
            </button>
            <button type="button" onClick={() => setStep("choose")}
              className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper">
              <ArrowLeft size={15} /> Back
            </button>
          </div>
          <p className="font-data text-xs text-sage/60">
            No online payment — you reserve now and pay at the property. We'll confirm on WhatsApp.
          </p>
        </form>
      ) : null}

      {/* ---- step: done ---- */}
      {step === "done" && result ? (
        <div className="text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber/15 text-amber">
            <Check size={28} />
          </span>
          <h3 className="mt-4 font-display text-2xl font-extrabold text-paper">Reservation requested</h3>
          <p className="font-data mt-1 text-sm text-sage">Booking ref <span className="text-amber">{result.ref}</span></p>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-sage">
            We've saved your request ({formatPaise(result.total)}, payable at the property).
            Tap below to confirm instantly on WhatsApp.
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <a href={result.whatsapp} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-amber px-6 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90">
              <MessageCircle size={17} /> Confirm on WhatsApp
            </a>
            <Link href="/" className="text-sm text-sage hover:text-paper">Back to home</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
