import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarRange,
  ChevronDown,
  CircleUser,
  IndianRupee,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Receipt,
  SlidersHorizontal,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import type { StaffMember } from "@/lib/reception/staff";

/**
 * Reception shell — tablet-first. This runs on a device at a desk, so touch
 * targets are large and the navigation is a drawer, not a 27-inch sidebar.
 *
 * Entirely server-rendered: the drawer is a native <details>, so the shell needs
 * no client JavaScript at all.
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
};

// Business screens are intentionally not built yet; these are the destinations
// the shell will grow into.
const NAV: NavItem[] = [
  { href: "/reception", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reception/arrivals", label: "Arrivals", icon: LogIn },
  { href: "/reception/departures", label: "Departures", icon: LogOut },
  { href: "/reception/board", label: "Occupancy board", icon: CalendarRange },
  { href: "/reception/guests", label: "Guests", icon: Users },
  { href: "/reception/housekeeping", label: "Housekeeping", icon: Sparkles },
  { href: "/reception/rates", label: "Rates", icon: IndianRupee, ownerOnly: true },
  { href: "/reception/allotment", label: "Direct allotment", icon: SlidersHorizontal, ownerOnly: true },
  { href: "/reception/close", label: "Daily close", icon: Receipt, ownerOnly: true },
];

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

function NavLinks({ items }: { items: NavItem[] }) {
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const ItemIcon = item.icon;
        return (
        <Link
          key={item.href}
          href={item.href}
          className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-sage transition-colors hover:bg-forest/60 hover:text-paper"
        >
          <ItemIcon size={18} aria-hidden />
          {item.label}
          {item.ownerOnly && (
            <span className="font-data ml-auto text-[0.6rem] uppercase tracking-[0.14em] text-amber">
              owner
            </span>
          )}
        </Link>
      );})}
    </nav>
  );
}

export function ReceptionShell({
  staff,
  children,
}: {
  staff: StaffMember;
  children: React.ReactNode;
}) {
  const items = NAV.filter((n) => !n.ownerOnly || staff.role === "owner");

  return (
    <div className="min-h-screen bg-pine">
      <header className="sticky top-0 z-40 border-b hairline bg-pine/90 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            {/* Drawer toggle — <details> keeps this a Server Component. */}
            <details className="group relative lg:hidden">
              <summary
                className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-xl border hairline text-sage hover:text-paper [&::-webkit-details-marker]:hidden"
                aria-label="Open navigation"
              >
                <Menu size={20} aria-hidden />
              </summary>
              <div className="absolute left-0 top-13 z-50 mt-2 w-64 rounded-2xl border hairline bg-forest p-2 shadow-2xl">
                <NavLinks items={items} />
              </div>
            </details>

            <Link href="/reception" className="font-display text-base font-extrabold tracking-tight text-paper">
              Storey{" "}
              <span className="font-data text-[0.6rem] uppercase tracking-[0.2em] text-amber">
                reception
              </span>
            </Link>
          </div>

          {/* User menu — also a <details>, also server-rendered. */}
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border hairline px-3 py-2.5 text-sm text-sage hover:text-paper [&::-webkit-details-marker]:hidden">
              <CircleUser size={18} aria-hidden />
              <span className="hidden max-w-[10rem] truncate sm:inline">{staff.displayName}</span>
              <ChevronDown size={14} aria-hidden />
            </summary>
            <div className="absolute right-0 z-50 mt-2 w-60 rounded-2xl border hairline bg-forest p-3 shadow-2xl">
              <p className="truncate text-sm text-paper">{staff.displayName}</p>
              <p className="font-data mt-1 text-[0.65rem] uppercase tracking-[0.16em] text-amber">
                {staff.role}
              </p>
              {staff.email && (
                <p className="mt-1 truncate text-xs text-sage">{staff.email}</p>
              )}
              <form action={signOut} className="mt-3">
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2 rounded-xl border hairline px-3 py-2.5 text-sm text-sage transition-colors hover:border-amber hover:text-amber"
                >
                  <LogOut size={16} aria-hidden />
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6 sm:px-6">
        {/* Persistent sidebar from lg up; the drawer covers everything smaller. */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <NavLinks items={items} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
