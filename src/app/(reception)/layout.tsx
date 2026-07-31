import type { Metadata } from "next";
import { ReceptionShell } from "@/components/reception/shell";
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
  // Authoritative gate. proxy.ts only does the optimistic signed-out redirect;
  // this also rejects authenticated users who aren't reception staff.
  const staff = await requireStaff();

  return <ReceptionShell staff={staff}>{children}</ReceptionShell>;
}
