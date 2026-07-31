import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { getChannelStatus, type ChannelStatus } from "@/lib/channel/status";
import { ChannelStatusView } from "@/components/stays/channel-status";

export const metadata: Metadata = {
  title: "Channel sync",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ChannelPage() {
  await requireRole(["owner", "manager", "reception"]);

  let status: ChannelStatus;
  try {
    status = await getChannelStatus();
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load channel status.{" "}
          <Link href="/stays/channel" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/stays"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Stays
      </Link>

      <h1 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
        Channel sync
      </h1>
      <p className="mt-1.5 text-sm text-sage">
        Inventory is one pool, recalculated on every change. This is how those
        numbers reach the outside world.
      </p>

      <div className="mt-6">
        <ChannelStatusView status={status} />
      </div>
    </div>
  );
}
