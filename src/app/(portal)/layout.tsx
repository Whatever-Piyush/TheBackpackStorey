import Link from "next/link";
import { requireUser, type Role } from "@/lib/auth";
import { PortalNav } from "@/components/portal/nav";
import { SignOutButton } from "@/components/portal/sign-out-button";

const NAV: { href: string; label: string; roles: Role[] }[] = [
  { href: "/pos", label: "Café POS", roles: ["owner", "manager", "reception", "kitchen"] },
  { href: "/stays", label: "Stays", roles: ["owner", "manager", "reception", "housekeeping"] },
];

/** Two letters for the avatar — from the name if we have one, else the email. */
function initials(name: string | null, email?: string): string {
  const source = (name || email?.split("@")[0] || "").trim();
  if (!source) return "—";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

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
      <header className="sticky top-0 z-40 border-b hairline bg-pine/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <div className="flex items-center gap-6">
            <Link
              href={nav[0]?.href ?? "/"}
              className="font-display text-base font-extrabold tracking-tight text-paper"
            >
              Storey{" "}
              <span className="font-data text-[0.6rem] uppercase tracking-[0.2em] text-amber">
                ops
              </span>
            </Link>
            <PortalNav items={nav} />
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2.5 sm:flex">
              <span
                aria-hidden
                className="font-data grid h-8 w-8 place-items-center rounded-full border hairline bg-moss/40 text-[0.62rem] font-bold tracking-wider text-paper"
              >
                {initials(session.fullName, session.email)}
              </span>
              <span className="leading-tight">
                <span className="block max-w-[14ch] truncate text-xs text-paper">
                  {session.fullName || session.email}
                </span>
                <span className="font-data block text-[0.58rem] uppercase tracking-[0.18em] text-amber/80">
                  {role ?? "no role"}
                </span>
              </span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
