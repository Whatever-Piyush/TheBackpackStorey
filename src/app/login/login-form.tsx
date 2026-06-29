"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

// Only allow internal portal redirects (no open-redirect to arbitrary URLs).
function safeRedirect(target: string | null): string {
  if (target && target.startsWith("/") && !target.startsWith("//")) return target;
  return "/pos";
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = safeRedirect(params.get("redirectTo"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!isSupabaseConfigured) {
    return (
      <div className="rounded-card border hairline bg-forest p-6 text-sm leading-relaxed text-sage">
        <p className="font-display text-base font-bold text-paper">Supabase not configured yet</p>
        <p className="mt-2">
          Add <code className="font-data text-amber">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="font-data text-amber">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to{" "}
          <code className="font-data">.env.local</code>, then run the migrations in{" "}
          <code className="font-data">supabase/</code>. The public website works without this.
        </p>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setPending(false);
      return;
    }
    router.replace(redirectTo);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="font-data text-xs uppercase tracking-[0.16em] text-sage">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full rounded-xl border hairline bg-pine px-3.5 py-2.5 text-paper outline-none focus:border-amber"
        />
      </label>
      <label className="block">
        <span className="font-data text-xs uppercase tracking-[0.16em] text-sage">Password</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-xl border hairline bg-pine px-3.5 py-2.5 text-paper outline-none focus:border-amber"
        />
      </label>

      {error ? <p className="text-sm text-ember">{error}</p> : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
