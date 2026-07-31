"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Ban, PlusCircle, Sparkles, Wrench, X } from "lucide-react";
import { blockCell, moveBooking, type BoardActionResult } from "@/lib/stays/actions";
import {
  HOUSEKEEPING_LABEL,
  setHousekeeping,
  type HousekeepingResult,
  type HousekeepingStatus,
} from "@/lib/stays/housekeeping";
import type { BoardAllocation, BoardData, BoardRoom, BoardUnit } from "@/lib/stays/board";

/**
 * The 14-day occupancy board.
 *
 * At this size a grid of plain cells beats a virtualised, drag-and-drop
 * component: moves happen through a select in the drawer, which is faster than
 * dragging and actually works on the tablet at the desk.
 */

type Row = {
  unit: BoardUnit;
  room: BoardRoom;
  /** The room label and housekeeping pill render once, on its first bed. */
  isFirstOfRoom: boolean;
};

type Selection =
  | { kind: "allocation"; allocation: BoardAllocation; row: Row }
  | { kind: "empty"; row: Row; date: string };

const dayIndex = (dates: string[], iso: string) => dates.indexOf(iso);

/** Clamp a stay to the visible window and return its 1-based column span. */
function span(dates: string[], from: string, to: string) {
  const first = dates[0];
  const lastExclusive = dates[dates.length - 1];
  const start = from < first ? 0 : dayIndex(dates, from);
  // `to` is exclusive (checkout day is not a night).
  let endExclusive = dayIndex(dates, to);
  if (to > lastExclusive) endExclusive = dates.length;
  if (endExclusive < 0) endExclusive = dates.length;
  const s = Math.max(0, start);
  const len = Math.max(1, endExclusive - s);
  return { start: s + 1, len, clippedLeft: from < first, clippedRight: to > lastExclusive };
}

function shortDay(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return {
    dow: d.toLocaleDateString("en-IN", { weekday: "narrow" }),
    day: d.getDate(),
  };
}

export function BoardGrid({ board }: { board: BoardData }) {
  const [selected, setSelected] = useState<Selection | null>(null);
  // Housekeeping's view of the same grid: just the rooms that need attention.
  const [needsCleaning, setNeedsCleaning] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const rooms = needsCleaning
      ? board.rooms.filter((r) => r.housekeeping !== "clean" && r.housekeeping !== "inspected")
      : board.rooms;
    for (const room of rooms) {
      room.units.forEach((unit, i) => {
        out.push({ unit, room, isFirstOfRoom: i === 0 });
      });
    }
    return out;
  }, [board.rooms, needsCleaning]);

  const byUnit = useMemo(() => {
    const map = new Map<string, BoardAllocation[]>();
    for (const a of board.allocations) {
      map.set(a.unitId, [...(map.get(a.unitId) ?? []), a]);
    }
    return map;
  }, [board.allocations]);

  const cols = `10rem repeat(${board.dates.length}, minmax(2.75rem, 1fr))`;

  const dirty = board.rooms.filter(
    (r) => r.housekeeping !== "clean" && r.housekeeping !== "inspected",
  ).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setNeedsCleaning(false)}
          className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
            needsCleaning ? "hairline text-sage hover:text-paper" : "border-amber bg-amber text-pine"
          }`}
        >
          All rooms
        </button>
        <button
          type="button"
          onClick={() => setNeedsCleaning(true)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
            needsCleaning ? "border-amber bg-amber text-pine" : "hairline text-sage hover:text-paper"
          }`}
        >
          <Sparkles size={12} aria-hidden />
          Needs cleaning{dirty > 0 ? ` (${dirty})` : ""}
        </button>
      </div>

      <div className="overflow-x-auto rounded-card border hairline bg-forest/30">
        <div className="min-w-[46rem]">
          {/* header */}
          <div className="grid items-end gap-px border-b hairline" style={{ gridTemplateColumns: cols }}>
            <div className="px-3 py-2">
              <span className="font-data text-[0.6rem] uppercase tracking-[0.16em] text-sage">
                Unit
              </span>
            </div>
            {board.dates.map((d) => {
              const { dow, day } = shortDay(d);
              const isToday = d === board.today;
              return (
                <div
                  key={d}
                  className={`px-1 py-2 text-center ${isToday ? "bg-amber/10" : ""}`}
                >
                  <p className="font-data text-[0.55rem] uppercase tracking-[0.1em] text-sage">
                    {dow}
                  </p>
                  <p className={`text-sm ${isToday ? "font-bold text-amber" : "text-paper"}`}>
                    {day}
                  </p>
                </div>
              );
            })}
          </div>

          {/* rows */}
          {rows.map((row) => {
            const allocations = byUnit.get(row.unit.unitId) ?? [];
            return (
              <div
                key={row.unit.unitId}
                className="grid gap-px border-b hairline last:border-b-0"
                style={{ gridTemplateColumns: cols }}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  {/* The room number and its housekeeping state belong to the
                      ROOM, so they appear once, on its first bed. */}
                  {row.isFirstOfRoom ? (
                    <>
                      <span className="truncate text-sm text-paper">{row.room.number}</span>
                      <HousekeepingPill room={row.room} />
                    </>
                  ) : (
                    <span className="w-[3.2rem] shrink-0" aria-hidden />
                  )}
                  {row.unit.label && (
                    <span className="font-data truncate text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                      {row.unit.label}
                    </span>
                  )}
                </div>

                {/* one clickable cell per night, then bars layered on top */}
                <div
                  className="relative col-span-full grid gap-px"
                  style={{
                    gridColumn: `2 / span ${board.dates.length}`,
                    gridTemplateColumns: `repeat(${board.dates.length}, minmax(2.75rem, 1fr))`,
                  }}
                >
                  {board.dates.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setSelected({ kind: "empty", row, date: d })}
                      aria-label={`${row.room.number}${row.unit.label ? ` ${row.unit.label}` : ""} on ${d}`}
                      className={`h-11 transition-colors hover:bg-paper/5 ${
                        d === board.today ? "bg-amber/5" : ""
                      }`}
                      style={{ gridColumn: i + 1, gridRow: 1 }}
                    />
                  ))}

                  {allocations.map((a) => {
                    const { start, len, clippedLeft, clippedRight } = span(
                      board.dates,
                      a.from,
                      a.to,
                    );
                    const isBooking = a.reason === "booking";
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setSelected({ kind: "allocation", allocation: a, row })}
                        title={
                          isBooking
                            ? `${a.guestName ?? "Guest"} · ${a.code} · ${a.from} → ${a.to}`
                            : `${a.reason.replace("_", " ")} · ${a.from} → ${a.to}`
                        }
                        className={`z-10 m-0.5 flex h-10 items-center overflow-hidden px-2 text-left text-xs transition-opacity hover:opacity-90 ${
                          isBooking
                            ? "bg-amber text-pine"
                            : "border border-dashed border-sage/50 bg-forest text-sage"
                        } ${clippedLeft ? "rounded-l-none" : "rounded-l-lg"} ${
                          clippedRight ? "rounded-r-none" : "rounded-r-lg"
                        }`}
                        style={{ gridColumn: `${start} / span ${len}`, gridRow: 1 }}
                      >
                        <span className="truncate font-medium">
                          {isBooking ? (
                            a.guestName ?? a.code
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Wrench size={11} aria-hidden />
                              {a.reason.replace("_", " ")}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {needsCleaning && rows.length === 0 && (
        <p className="mt-3 rounded-card border hairline bg-forest/30 p-6 text-center text-sm text-sage">
          Every room is clean.
        </p>
      )}

      <Legend />

      {selected && (
        <Drawer
          selection={selected}
          board={board}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

const HK_STYLE: Record<HousekeepingStatus, string> = {
  clean: "text-emerald-400 border-emerald-500/40",
  dirty: "text-amber border-amber/50",
  inspected: "text-sage border-sage/40",
  out_of_order: "text-red-400 border-red-500/50",
};

/** Per-room clean/dirty control. Submits on change; no separate save button. */
function HousekeepingPill({ room }: { room: BoardRoom }) {
  const [state, action] = useActionState<HousekeepingResult | null, FormData>(
    setHousekeeping,
    null,
  );
  const status = room.housekeeping as HousekeepingStatus;

  return (
    <form action={action} className="relative shrink-0">
      <input type="hidden" name="room_id" value={room.roomId} />
      <select
        name="status"
        defaultValue={status}
        aria-label={`Housekeeping for ${room.number}`}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className={`cursor-pointer rounded-full border bg-transparent px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.12em] outline-none ${
          HK_STYLE[status] ?? "hairline text-sage"
        }`}
      >
        {(Object.keys(HOUSEKEEPING_LABEL) as HousekeepingStatus[]).map((k) => (
          <option key={k} value={k} className="bg-pine text-paper">
            {HOUSEKEEPING_LABEL[k]}
          </option>
        ))}
      </select>
      {state && !state.ok && (
        <span className="absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-pine px-2 py-1 text-[0.6rem] text-amber shadow">
          {state.error}
        </span>
      )}
      {state?.ok && state.needsBlock && (
        <span className="absolute left-0 top-full z-20 mt-1 w-56 rounded bg-pine px-2 py-1 text-[0.6rem] text-amber shadow">
          {state.message}
        </span>
      )}
    </form>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-sage">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-amber" aria-hidden /> Booked
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded border border-dashed border-sage/50 bg-forest"
          aria-hidden
        />{" "}
        Blocked
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-amber/10" aria-hidden /> Today
      </span>
    </div>
  );
}

function Drawer({
  selection,
  board,
  onClose,
}: {
  selection: Selection;
  board: BoardData;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-pine/70 backdrop-blur-sm"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l hairline bg-forest p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-data text-[0.6rem] uppercase tracking-[0.16em] text-amber">
              {selection.row.room.typeName}
            </p>
            <h2 className="mt-1 font-display text-xl font-extrabold text-paper">
              {selection.row.room.number}
              {selection.row.unit.label ? ` · ${selection.row.unit.label}` : ""}
            </h2>
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

        {selection.kind === "allocation" ? (
          <AllocationPanel selection={selection} board={board} />
        ) : (
          <EmptyPanel selection={selection} />
        )}
      </aside>
    </div>
  );
}

function AllocationPanel({
  selection,
  board,
}: {
  selection: Extract<Selection, { kind: "allocation" }>;
  board: BoardData;
}) {
  const a = selection.allocation;
  const [state, action, pending] = useActionState<BoardActionResult | null, FormData>(
    moveBooking,
    null,
  );

  // Same room type only — moving a dorm guest into a private room would be a
  // different sale, not a move.
  const candidates = board.rooms
    .filter((r) => r.roomTypeId === selection.row.room.roomTypeId)
    .flatMap((r) =>
      r.units
        .filter((u) => u.unitId !== a.unitId)
        .map((u) => ({
          unitId: u.unitId,
          label: `${r.number}${u.label ? ` · ${u.label}` : ""}`,
          busy: board.allocations.some(
            (x) => x.unitId === u.unitId && x.from < a.to && x.to > a.from,
          ),
        })),
    );

  return (
    <div className="mt-5 space-y-5">
      <dl className="space-y-2 text-sm">
        {a.reason === "booking" ? (
          <>
            <Field label="Guest" value={a.guestName ?? "—"} />
            <Field label="Reference" value={a.code ?? "—"} />
            <Field label="Status" value={a.status ?? "—"} />
            <Field
              label="Stay"
              value={`${a.from} → ${a.to} · ${nightsBetween(a.from, a.to)} night${
                nightsBetween(a.from, a.to) === 1 ? "" : "s"
              }`}
            />
            <Field
              label="Party"
              value={`${a.adults ?? 1} adult${(a.adults ?? 1) === 1 ? "" : "s"}${
                a.children ? `, ${a.children} children` : ""
              }`}
            />
            {a.unitsOnReservation > 1 && (
              <Field
                label="Group"
                value={`${a.unitsOnReservation} units on this booking`}
              />
            )}
            {a.guestPhone && <Field label="Phone" value={a.guestPhone} />}
          </>
        ) : (
          <>
            <Field label="Type" value={a.reason.replace("_", " ")} />
            <Field label="Dates" value={`${a.from} → ${a.to}`} />
          </>
        )}
      </dl>

      {a.reason === "booking" && candidates.length > 0 && (
        <form action={action} className="space-y-2 border-t hairline pt-4">
          <p className="font-data text-[0.62rem] uppercase tracking-[0.16em] text-sage">
            Move to another {selection.row.room.sellMode === "per_bed" ? "bed" : "room"}
          </p>
          <input type="hidden" name="allocation_id" value={a.id} />
          <select
            name="to_unit_id"
            required
            className="w-full rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber"
          >
            <option value="">Choose…</option>
            {candidates.map((c) => (
              <option key={c.unitId} value={c.unitId}>
                {c.label}
                {c.busy ? " — occupied" : ""}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-xl bg-amber px-4 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
          >
            {pending ? "Moving…" : "Move"}
          </button>
          {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
          {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
        </form>
      )}
    </div>
  );
}

function EmptyPanel({ selection }: { selection: Extract<Selection, { kind: "empty" }> }) {
  const [state, action, pending] = useActionState<BoardActionResult | null, FormData>(
    blockCell,
    null,
  );

  return (
    <div className="mt-5 space-y-5">
      <p className="text-sm text-sage">
        Free on <span className="text-paper">{selection.date}</span>.
      </p>

      <Link
        href={`/stays/walk-in?unit=${selection.row.unit.unitId}&date=${selection.date}`}
        className="flex items-center gap-2 rounded-xl border hairline px-4 py-3 text-sm text-paper transition-colors hover:border-amber hover:text-amber"
      >
        <PlusCircle size={16} aria-hidden />
        New booking
      </Link>

      <form action={action} className="space-y-2 border-t hairline pt-4">
        <p className="font-data text-[0.62rem] uppercase tracking-[0.16em] text-sage">
          Take it off sale
        </p>
        <input type="hidden" name="unit_id" value={selection.row.unit.unitId} />
        <input type="hidden" name="from" value={selection.date} />
        <div className="flex gap-2">
          <select
            name="reason"
            className="flex-1 rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber"
          >
            <option value="maintenance">Maintenance</option>
            <option value="owner_use">Owner use</option>
          </select>
          <input
            type="number"
            name="nights"
            min={1}
            max={60}
            defaultValue={1}
            aria-label="Nights"
            className="w-20 rounded-xl border hairline bg-pine px-3 py-2.5 text-sm text-paper outline-none focus:border-amber"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
        >
          <Ban size={15} aria-hidden />
          {pending ? "Blocking…" : "Block"}
        </button>
        {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
        {state?.ok && <p className="text-sm text-emerald-400">{state.message}</p>}
      </form>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="font-data text-[0.62rem] uppercase tracking-[0.14em] text-sage">
        {label}
      </dt>
      <dd className="text-right text-paper">{value}</dd>
    </div>
  );
}

function nightsBetween(from: string, to: string) {
  return Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) /
      86_400_000,
  );
}
