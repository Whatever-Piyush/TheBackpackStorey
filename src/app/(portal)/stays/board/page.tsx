import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { addDays } from "@/lib/dates";
import { getBoard, type BoardData } from "@/lib/stays/board";
import { BoardGrid } from "@/components/stays/board-grid";

export const metadata: Metadata = {
  title: "Occupancy board",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const DAYS = 14;

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  // Housekeeping can see the board (item 5 adds their filter); only the desk
  // can act on it — the actions re-check on their own.
  await requireRole(["owner", "manager", "reception", "housekeeping"]);
  const { from } = await searchParams;

  let board: BoardData;
  try {
    board = await getBoard(from, DAYS);
  } catch {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load the board.{" "}
          <Link href="/stays/board" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  const prev = addDays(board.from, -DAYS);
  const next = addDays(board.from, DAYS);
  const last = board.dates[board.dates.length - 1];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link
        href="/stays"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Stays
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
            Occupancy
          </h1>
          <p className="mt-1 text-sm text-sage">
            {board.from} → {last} · tap a booking to open it, or an empty night to
            block it.
          </p>
        </div>

        <nav className="flex items-center gap-2">
          <Link
            href={`/stays/board?from=${prev}`}
            className="rounded-xl border hairline p-2.5 text-sage transition-colors hover:border-amber hover:text-amber"
            aria-label="Previous 14 days"
          >
            <ChevronLeft size={16} aria-hidden />
          </Link>
          <Link
            href="/stays/board"
            className="rounded-xl border hairline px-3 py-2.5 text-sm text-sage transition-colors hover:border-amber hover:text-amber"
          >
            Today
          </Link>
          <Link
            href={`/stays/board?from=${next}`}
            className="rounded-xl border hairline p-2.5 text-sage transition-colors hover:border-amber hover:text-amber"
            aria-label="Next 14 days"
          >
            <ChevronRight size={16} aria-hidden />
          </Link>
        </nav>
      </div>

      <div className="mt-6">
        {board.rooms.length === 0 ? (
          <p className="rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
            No rooms are set up yet.
          </p>
        ) : (
          <BoardGrid board={board} />
        )}
      </div>
    </div>
  );
}
