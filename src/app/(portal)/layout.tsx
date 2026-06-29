import Link from "next/link";
import { requireUser, type Role } from "@/lib/auth";
import { SignOutButton } from "@/components/portal/sign-out-button";

const NAV: { href: string; label: string; roles: Role[] }[] = [
  { href: "/pos", label: "Café POS", roles: ["owner", "manager", "reception", "kitchen"] },
  { href: "/stays", label: "Stays", roles: ["owner", "manager", "reception", "housekeeping"] },
];

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Authoritative gate (proxy.ts only does the optimistic redirect).
  const session = await requireUser();
  const role = session.role;
  const nav = NAV.filter((n) => role !== null && n.roles.includes(role));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b hairline bg-pine/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <div className="flex items-center gap-6">
            <Link href={nav[0]?.href ?? "/"} className="font-display text-base font-extrabold tracking-tight text-paper">
              Storey <span className="font-data text-[0.6rem] uppercase tracking-[0.2em] text-amber">ops</span>
            </Link>
            <nav className="flex items-center gap-4">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="text-sm text-sage hover:text-paper">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-data hidden text-[0.65rem] uppercase tracking-[0.16em] text-sage sm:inline">
              {session.fullName || session.email} · {role ?? "no role"}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
