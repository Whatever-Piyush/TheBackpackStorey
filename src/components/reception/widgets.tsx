import Link from "next/link";
import { BedDouble, LogIn, LogOut, Sparkles, Wallet } from "lucide-react";
import { formatPaise } from "@/lib/money";
import type { ArrivalRow, DashboardData } from "@/lib/reception/dashboard";

/**
 * Dashboard widgets. All Server Components — no dashboard data is ever fetched
 * from the browser. Every widget renders an explicit empty state, because a
 * quiet day and a broken query must never look the same at the desk.
 */

export function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border hairline bg-forest/40 p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-data text-[0.68rem] uppercase tracking-[0.16em] text-sage">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-sm text-sage/70">{children}</p>;
}

/** Big number tiles: in-house, occupancy, arrivals/departures counts. */
export function StatTiles({ data }: { data: DashboardData }) {
  const tiles = [
    { label: "Arriving", value: data.arrivals.length, icon: LogIn },
    { label: "Departing", value: data.departures.length, icon: LogOut },
    { label: "In-house", value: data.inHouse.guests, icon: BedDouble },
    {
      label: "Occupancy",
      value: `${data.occupancy.pct}%`,
      icon: Sparkles,
      sub: `${data.occupancy.sold}/${data.occupancy.sellable} unit-nights`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => {
        const TileIcon = t.icon;
        return (
          <div key={t.label} className="rounded-2xl border hairline bg-forest/40 p-4">
            <div className="flex items-center gap-2 text-sage">
              <TileIcon size={16} aria-hidden />
              <span className="font-data text-[0.65rem] uppercase tracking-[0.16em]">
                {t.label}
              </span>
            </div>
            <p className="mt-2 font-display text-3xl font-extrabold text-paper">{t.value}</p>
            {t.sub && <p className="mt-1 text-xs text-sage/80">{t.sub}</p>}
          </div>
        );
      })}
    </div>
  );
}

function StayList({ rows, empty }: { rows: ArrivalRow[]; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;

  return (
    <ul className="divide-y divide-white/5">
      {rows.map((r) => (
        <li key={r.reservationId} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-paper">{r.guestName}</p>
            <p className="font-data mt-0.5 text-[0.65rem] uppercase tracking-[0.14em] text-sage">
              {r.code} · {r.units} unit{r.units === 1 ? "" : "s"}
              {r.rooms.length > 0 && ` · ${r.rooms.join(", ")}`}
            </p>
          </div>
          {r.guestPhone && (
            <a
              href={`tel:${r.guestPhone.replace(/[^\d+]/g, "")}`}
              className="shrink-0 rounded-lg border hairline px-3 py-2 text-xs text-sage hover:border-amber hover:text-amber"
            >
              Call
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Arrivals({ data }: { data: DashboardData }) {
  return (
    <Card title="Today's arrivals">
      <StayList rows={data.arrivals} empty="No arrivals today." />
    </Card>
  );
}

export function Departures({ data }: { data: DashboardData }) {
  return (
    <Card title="Today's departures">
      <StayList rows={data.departures} empty="No departures today." />
    </Card>
  );
}

export function AvailableByType({ data }: { data: DashboardData }) {
  return (
    <Card title="Available tonight">
      {data.availableByType.length === 0 ? (
        <Empty>No room types configured.</Empty>
      ) : (
        <ul className="space-y-2">
          {data.availableByType.map((t) => (
            <li key={t.roomTypeId} className="flex items-center justify-between gap-3">
              <span className="truncate text-sm text-paper">{t.name}</span>
              <span className="font-data shrink-0 text-xs text-sage">
                <span className={t.available === 0 ? "text-amber" : "text-paper"}>
                  {t.available}
                </span>
                {" / "}
                {t.total} {t.sellMode === "per_bed" ? "beds" : "rooms"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function NeedsCleaning({ data }: { data: DashboardData }) {
  return (
    <Card title="Needs cleaning">
      {data.needsCleaning.length === 0 ? (
        <Empty>Everything is clean.</Empty>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {data.needsCleaning.map((r) => (
            <li
              key={r.roomId}
              className="rounded-lg border hairline px-3 py-2 text-sm text-paper"
            >
              {r.number}
              <span className="font-data ml-2 text-[0.6rem] uppercase tracking-[0.14em] text-amber">
                {r.housekeeping.replace("_", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function OpenFolios({ data }: { data: DashboardData }) {
  const total = data.openFolios.reduce((sum, f) => sum + f.balancePaise, 0);

  return (
    <Card
      title="Open folios with balance"
      action={
        total > 0 ? (
          <span className="font-display text-sm font-bold text-amber">
            {formatPaise(total)}
          </span>
        ) : undefined
      }
    >
      {data.openFolios.length === 0 ? (
        <Empty>Nothing outstanding.</Empty>
      ) : (
        <ul className="divide-y divide-white/5">
          {data.openFolios.map((f) => (
            <li key={f.folioId} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-paper">{f.guestName}</p>
                <p className="font-data mt-0.5 text-[0.65rem] uppercase tracking-[0.14em] text-sage">
                  {f.code ?? (f.tableNo ? `Table ${f.tableNo}` : "Walk-in")}
                </p>
              </div>
              <span className="shrink-0 font-display text-sm font-bold text-paper">
                {formatPaise(f.balancePaise)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function EventFeed({ data }: { data: DashboardData }) {
  return (
    <Card title="Recent activity">
      {data.events.length === 0 ? (
        <Empty>Nothing has happened yet today.</Empty>
      ) : (
        <ul className="space-y-2.5">
          {data.events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="font-data mt-0.5 w-12 shrink-0 text-[0.62rem] uppercase tracking-[0.1em] text-sage/70">
                {new Date(e.at).toLocaleTimeString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
              <span className="min-w-0 text-sm text-sage">
                {e.summary}
                {e.actorLabel && <span className="text-sage/60"> — {e.actorLabel}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Destinations are intentionally not built yet (see DO NOT BUILD). */
export function QuickActions() {
  const actions = [
    { href: "/reception/walk-in", label: "Walk-in booking", icon: BedDouble },
    { href: "/reception/check-in", label: "Check in by code", icon: LogIn },
    { href: "/reception/block", label: "Block a unit", icon: Wallet },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {actions.map((a) => {
        const ActionIcon = a.icon;
        return (
          <Link
            key={a.href}
            href={a.href}
            className="flex items-center gap-3 rounded-2xl border hairline bg-forest/40 px-4 py-4 text-sm text-paper transition-colors hover:border-amber hover:text-amber"
          >
            <ActionIcon size={18} aria-hidden />
            {a.label}
          </Link>
        );
      })}
    </div>
  );
}
