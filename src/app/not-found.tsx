import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-32 text-center">
      <p className="font-data text-xs uppercase tracking-[0.2em] text-amber">Off the map</p>
      <h1 className="mt-4 font-display text-5xl font-extrabold tracking-tight text-paper">404</h1>
      <p className="mt-4 max-w-sm text-sage">
        That page never launched. Let&apos;s get you back to solid ground.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-1.5 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
      >
        Back to the hostel
      </Link>
    </main>
  );
}
