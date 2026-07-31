/**
 * Route-level loading UI, also reused as the Suspense fallback in page.tsx so
 * the two never drift apart. Server Component.
 */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the dashboard…</span>

      <div className="space-y-2">
        <div className="h-3 w-32 animate-pulse rounded bg-forest/70" />
        <div className="h-8 w-64 animate-pulse rounded bg-forest/70" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-forest/40" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-2xl bg-forest/40" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-48 animate-pulse rounded-2xl bg-forest/40" />
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return <DashboardSkeleton />;
}
