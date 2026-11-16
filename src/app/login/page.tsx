import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { STAFF_PORTAL_ENABLED } from "@/lib/launch-server";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Staff sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  // No staff sign-in on the public portfolio deployment — see src/lib/launch.ts.
  if (!STAFF_PORTAL_ENABLED) notFound();

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="font-display text-xl font-extrabold tracking-tight text-paper">
          Backpackers <span className="text-amber">Storey</span>
        </Link>
        <p className="font-data mt-1 text-xs uppercase tracking-[0.2em] text-sage/70">
          Staff portal
        </p>

        <h1 className="mt-8 font-display text-2xl font-extrabold text-paper">Sign in</h1>
        <p className="mt-1 text-sm text-sage">Café POS &amp; the front desk live here.</p>

        <div className="mt-6">
          <Suspense fallback={<div className="h-48" />}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
