"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Globe, Plus, Trash2, Upload, UserCheck, UserX, X } from "lucide-react";
import { checkIn, uploadGuestDocument, type CheckInResult, type GuestInput } from "@/lib/stays/check-in";
import { markNoShow, type StayResult } from "@/lib/stays/stay-actions";
import type { Arrival, PartyGuest } from "@/lib/stays/arrivals";

/**
 * Today's arrivals and the check-in drawer.
 *
 * A booking is a PARTY: four backpackers sharing a dorm are four people, each of
 * whom must produce ID on arrival. It is still ONE check-in action — the desk
 * records everyone, then commits once.
 */

const field =
  "w-full rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber";
const labelCls = "font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage";

/** Kept in sync with is_foreign_national() in 0017. */
function isDomestic(nationality: string): boolean {
  return ["india", "indian", "in", "ind"].includes(nationality.trim().toLowerCase());
}

type Draft = GuestInput & { hasDocument: boolean };

function draftFrom(p: PartyGuest): Draft {
  return {
    guestId: p.guestId,
    name: p.name,
    phone: p.phone ?? "",
    email: p.email ?? "",
    nationality: p.nationality ?? "",
    idProofType: p.idProofType ?? "",
    idProofNumber: p.idProofNumber ?? "",
    passportNumber: p.passportNumber ?? "",
    passportIssueDate: p.passportIssueDate ?? "",
    passportExpiry: p.passportExpiry ?? "",
    visaNumber: p.visaNumber ?? "",
    visaType: p.visaType ?? "",
    visaExpiry: p.visaExpiry ?? "",
    arrivedInIndiaOn: p.arrivedInIndiaOn ?? "",
    arrivedFrom: p.arrivedFrom ?? "",
    nextDestination: p.nextDestination ?? "",
    isLead: p.isLead,
    hasDocument: p.documents > 0,
  };
}

/** `hasDocument` is UI-only state; the server derives it from guest_documents. */
function toPayload({ hasDocument, ...guest }: Draft): GuestInput {
  void hasDocument;
  return guest;
}

const blankDraft = (): Draft => ({
  name: "",
  phone: "",
  email: "",
  nationality: "",
  idProofType: "",
  idProofNumber: "",
  passportNumber: "",
  hasDocument: false,
});

export function ArrivalsList({ arrivals }: { arrivals: Arrival[] }) {
  const [open, setOpen] = useState<Arrival | null>(null);

  if (arrivals.length === 0) {
    return (
      <p className="mt-6 rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
        Nobody expected. Anyone who hasn&apos;t arrived from an earlier date would
        show here too.
      </p>
    );
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {arrivals.map((a) => {
          const foreign = a.party.some((p) => p.isForeign);
          const missing = a.party.filter((p) => !p.hasId).length;
          return (
            <li key={a.reservationId}>
              <button
                type="button"
                onClick={() => setOpen(a)}
                className="flex w-full items-center justify-between gap-3 rounded-card border hairline bg-forest/40 p-4 text-left transition-colors hover:border-amber"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-base text-paper">{a.guestName}</span>
                    {a.adults + a.children > 1 && (
                      <span className="font-data rounded-full border hairline px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-sage">
                        party of {a.adults + a.children}
                      </span>
                    )}
                    {a.overdue && (
                      <span className="font-data inline-flex items-center gap-1 rounded-full border border-amber/50 px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-amber">
                        <AlertTriangle size={10} aria-hidden /> since {a.checkin}
                      </span>
                    )}
                    {foreign && (
                      <span className="font-data inline-flex items-center gap-1 rounded-full border hairline px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-sage">
                        <Globe size={10} aria-hidden /> foreign
                      </span>
                    )}
                  </div>
                  <p className="font-data mt-1 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                    {a.code} · {a.nights} night{a.nights === 1 ? "" : "s"} ·{" "}
                    {a.units.map((u) => `${u.room}${u.bed ? ` ${u.bed}` : ""}`).join(", ")}
                    {a.party.length > 0 && missing > 0 && (
                      <span className="text-amber"> · {missing} without ID</span>
                    )}
                  </p>
                </div>
                <span className="font-data shrink-0 text-[0.6rem] uppercase tracking-[0.14em] text-amber">
                  Check in
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {open && <CheckInDrawer arrival={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function CheckInDrawer({ arrival, onClose }: { arrival: Arrival; onClose: () => void }) {
  const [state, action, pending] = useActionState<CheckInResult | null, FormData>(
    checkIn,
    null,
  );

  // Start from whoever is already recorded; pad up to the booked headcount so
  // reception isn't hunting for an "add" button for a party they already know.
  const [party, setParty] = useState<Draft[]>(() => {
    const known = arrival.party.map(draftFrom);
    if (known.length === 0) {
      known.push({ ...blankDraft(), name: arrival.guestName, phone: arrival.guestPhone ?? "", isLead: true });
    }
    const expected = Math.max(1, arrival.adults + arrival.children);
    while (known.length < expected) known.push(blankDraft());
    return known;
  });

  const update = (i: number, patch: Partial<Draft>) =>
    setParty((p) => p.map((g, idx) => (idx === i ? { ...g, ...patch } : g)));

  const missingId = party.filter(
    (g) => g.name.trim() && !g.idProofNumber?.trim() && !g.passportNumber?.trim() && !g.hasDocument,
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-pine/70 backdrop-blur-sm"
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l hairline bg-forest p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-data text-[0.6rem] uppercase tracking-[0.16em] text-amber">
              {arrival.code} · {arrival.checkin} → {arrival.checkout}
            </p>
            <h2 className="mt-1 font-display text-xl font-extrabold text-paper">
              {arrival.guestName}
            </h2>
            <p className="mt-1 text-sm text-sage">
              {arrival.units.map((u) => `${u.room}${u.bed ? ` · ${u.bed}` : ""}`).join(" | ")}
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

        <p className="mt-3 rounded-xl border hairline bg-pine/40 px-3 py-2 text-xs text-sage">
          {arrival.adults + arrival.children} booked across {arrival.units.length} unit
          {arrival.units.length === 1 ? "" : "s"}. Every person needs an ID number or a
          scan before check-in completes.
        </p>

        <form action={action} className="mt-5 space-y-4">
          <input type="hidden" name="reservation_id" value={arrival.reservationId} />
          <input
            type="hidden"
            name="guests"
            value={JSON.stringify(party.filter((g) => g.name.trim()).map(toPayload))}
          />

          {party.map((guest, i) => (
            <GuestCard
              key={guest.guestId ?? `new-${i}`}
              index={i}
              guest={guest}
              reservationId={arrival.reservationId}
              onChange={(patch) => update(i, patch)}
              onRemove={
                party.length > 1 ? () => setParty((p) => p.filter((_, x) => x !== i)) : undefined
              }
            />
          ))}

          <button
            type="button"
            onClick={() => setParty((p) => [...p, blankDraft()])}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed hairline px-4 py-2.5 text-sm text-sage transition-colors hover:border-amber hover:text-amber"
          >
            <Plus size={15} aria-hidden />
            Add another guest
          </button>

          {missingId.length > 0 && (
            <p className="rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-xs text-amber">
              Still needed: ID for {missingId.map((g) => g.name).join(", ")}. Enter a
              number or upload a scan.
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber px-4 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
          >
            <UserCheck size={16} aria-hidden />
            {pending ? "Checking in…" : `Check in ${party.filter((g) => g.name.trim()).length} guest(s)`}
          </button>
          {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
          {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
        </form>

        {/* Only offered once they are genuinely late — someone arriving later
            today is not a no-show. */}
        {arrival.overdue && <NoShowForm reservationId={arrival.reservationId} />}
      </aside>
    </div>
  );
}

function NoShowForm({ reservationId }: { reservationId: string }) {
  const [state, action, pending] = useActionState<StayResult | null, FormData>(
    markNoShow,
    null,
  );

  return (
    <form action={action} className="mt-5 border-t hairline pt-5">
      <input type="hidden" name="reservation_id" value={reservationId} />
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-xl border hairline px-4 py-2.5 text-sm text-sage transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
      >
        <UserX size={15} aria-hidden />
        {pending ? "Marking…" : "They never arrived — mark no-show"}
      </button>
      <p className="mt-1.5 text-xs text-sage/70">
        Releases the bed so it can be sold again.
      </p>
      {state && !state.ok && <p className="mt-2 text-sm text-amber">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-emerald-400">{state.message}</p>}
    </form>
  );
}

function GuestCard({
  index,
  guest,
  reservationId,
  onChange,
  onRemove,
}: {
  index: number;
  guest: Draft;
  reservationId: string;
  onChange: (patch: Partial<Draft>) => void;
  onRemove?: () => void;
}) {
  const nationality = guest.nationality ?? "";
  const foreign = nationality.trim() !== "" && !isDomestic(nationality);

  return (
    <fieldset className="space-y-3 rounded-xl border hairline bg-pine/30 p-3">
      <legend className="flex items-center gap-2 px-1">
        <span className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-amber">
          {guest.isLead ? "Lead guest" : `Guest ${index + 1}`}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-sage hover:text-amber"
            aria-label={`Remove guest ${index + 1}`}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        )}
      </legend>

      <div className="grid gap-3 sm:grid-cols-2">
        <Text label="Name" value={guest.name} onChange={(v) => onChange({ name: v })} />
        <Text label="Phone" value={guest.phone ?? ""} onChange={(v) => onChange({ phone: v })} />
        <div>
          <label className={labelCls}>Nationality</label>
          <input
            list="nationality-options"
            value={nationality}
            onChange={(e) => onChange({ nationality: e.target.value })}
            placeholder="India"
            className={`mt-1 ${field}`}
          />
        </div>
        <div>
          <label className={labelCls}>ID type</label>
          <select
            value={guest.idProofType ?? ""}
            onChange={(e) => onChange({ idProofType: e.target.value })}
            className={`mt-1 ${field}`}
          >
            <option value="">—</option>
            <option value="aadhaar">Aadhaar</option>
            <option value="driving_licence">Driving licence</option>
            <option value="passport">Passport</option>
            <option value="other">Other</option>
          </select>
        </div>
        <Text
          label="ID number"
          value={guest.idProofNumber ?? ""}
          onChange={(v) => onChange({ idProofNumber: v })}
        />
      </div>

      {foreign && (
        <div className="grid gap-3 rounded-lg border border-amber/40 bg-amber/5 p-3 sm:grid-cols-2">
          <p className="font-data col-span-full text-[0.58rem] uppercase tracking-[0.14em] text-amber">
            Foreign national — required for the register
          </p>
          <Text label="Passport no." value={guest.passportNumber ?? ""} onChange={(v) => onChange({ passportNumber: v })} />
          <Text label="Passport issued" type="date" value={guest.passportIssueDate ?? ""} onChange={(v) => onChange({ passportIssueDate: v })} />
          <Text label="Passport expires" type="date" value={guest.passportExpiry ?? ""} onChange={(v) => onChange({ passportExpiry: v })} />
          <Text label="Visa no." value={guest.visaNumber ?? ""} onChange={(v) => onChange({ visaNumber: v })} />
          <Text label="Visa type" value={guest.visaType ?? ""} onChange={(v) => onChange({ visaType: v })} />
          <Text label="Visa expires" type="date" value={guest.visaExpiry ?? ""} onChange={(v) => onChange({ visaExpiry: v })} />
          <Text label="Arrived in India" type="date" value={guest.arrivedInIndiaOn ?? ""} onChange={(v) => onChange({ arrivedInIndiaOn: v })} />
          <Text label="Arrived from" value={guest.arrivedFrom ?? ""} onChange={(v) => onChange({ arrivedFrom: v })} />
          <Text label="Next destination" value={guest.nextDestination ?? ""} onChange={(v) => onChange({ nextDestination: v })} />
        </div>
      )}

      {/* A scan can only be attached once the person exists in the database. */}
      {guest.guestId ? (
        <DocumentUpload
          guestId={guest.guestId}
          reservationId={reservationId}
          onUploaded={() => onChange({ hasDocument: true })}
        />
      ) : (
        <p className="text-xs text-sage/70">
          Save the check-in first, then a scan can be attached to this guest.
        </p>
      )}
    </fieldset>
  );
}

function DocumentUpload({
  guestId,
  reservationId,
  onUploaded,
}: {
  guestId: string;
  reservationId: string;
  onUploaded: () => void;
}) {
  const [state, action, pending] = useActionState<CheckInResult | null, FormData>(
    async (prev: CheckInResult | null, fd: FormData) => {
      const result = await uploadGuestDocument(prev, fd);
      if (result.ok) onUploaded();
      return result;
    },
    null,
  );

  return (
    // Nested forms are invalid HTML, so the upload posts through its own action
    // rather than sitting inside the check-in form element.
    <div className="flex flex-wrap items-center gap-2">
      <form action={action} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="guest_id" value={guestId} />
        <input type="hidden" name="reservation_id" value={reservationId} />
        <select name="kind" defaultValue="id" className="w-28 rounded-lg border hairline bg-pine px-2 py-2 text-xs text-paper">
          <option value="id">ID</option>
          <option value="passport">Passport</option>
          <option value="visa">Visa</option>
          <option value="aadhaar">Aadhaar</option>
        </select>
        <input
          type="file"
          name="file"
          required
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className="min-w-0 flex-1 rounded-lg border hairline bg-pine px-2 py-1.5 text-xs text-paper file:mr-2 file:rounded file:border-0 file:bg-forest file:px-2 file:py-0.5 file:text-sage"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border hairline px-3 py-2 text-xs text-paper hover:border-amber hover:text-amber disabled:opacity-50"
        >
          <Upload size={13} aria-hidden />
          {pending ? "…" : "Scan"}
        </button>
      </form>
      {state && !state.ok && <p className="w-full text-xs text-amber">{state.error}</p>}
      {state?.ok && <p className="w-full text-xs text-emerald-400">Scan stored.</p>}
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${field}`}
      />
    </div>
  );
}
