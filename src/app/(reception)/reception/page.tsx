import { Suspense } from "react";
import type { Metadata } from "next";
import { getDashboard } from "@/lib/reception/dashboard";
import {
  Arrivals,
  AvailableByType,
  Departures,
  EventFeed,
  NeedsCleaning,
  OpenFolios,
  QuickActions,
  StatTiles,
} from "@/components/reception/widgets";
import { DashboardSkeleton } from "./loading";

export const metadata: Metadata = { title: "Dashboard" };

// Reception must never see a cached yesterday.
export const dynamic = "force-dynamic";

/**
 * Everything below is a Server Component: the dashboard is fetched on the server
 * in ONE RPC call and streamed in. No dashboard data is fetched from the browser.
 */
async function DashboardContent({ date }: { date?: string }) {
  const data = await getDashboard(date);

  const heading = new Date(`${data.date}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="font-data text-[0.65rem] uppercase tracking-[0.18em] text-amber">
          {/* Computed in Postgres, Asia/Kolkata — never the browser clock. */}
          Today · {data.date}
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
          {heading}
        </h1>
      </header>

      <StatTiles data={data} />
      <QuickActions />

      <div className="grid gap-4 lg:grid-cols-2">
        <Arrivals data={data} />
        <Departures data={data} />
        <AvailableByType data={data} />
        <NeedsCleaning data={data} />
        <OpenFolios data={data} />
        <EventFeed data={data} />
      </div>
    </div>
  );
}

export default async function ReceptionDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;

  return (
    <Suspense key={date ?? "today"} fallback={<DashboardSkeleton />}>
      <DashboardContent date={date} />
    </Suspense>
  );
}
