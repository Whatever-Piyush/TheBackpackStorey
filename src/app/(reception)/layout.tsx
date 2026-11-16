import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReceptionShell } from "@/components/reception/shell";
import { STAFF_PORTAL_ENABLED } from "@/lib/launch-server";
import { requireStaff } from "@/lib/reception/staff";

export const metadata: Metadata = {
  title: { default: "Reception", template: "%s · Reception" },
  robots: { index: false, follow: false },
};

export default async function ReceptionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reception exists only where STAFF_PORTAL_ENABLED is set (not on the public
  // portfolio deployment) — see src/lib/launch.ts.
  if (!STAFF_PORTAL_ENABLED) notFound();

  // Authoritative gate. proxy.ts only does the optimistic signed-out redirect;
  // this also rejects authenticated users who aren't reception staff.
  const staff = await requireStaff();

  return <ReceptionShell staff={staff}>{children}</ReceptionShell>;
}
