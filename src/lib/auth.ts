import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export type Role = "owner" | "manager" | "reception" | "kitchen" | "housekeeping";

export const ALL_ROLES: Role[] = ["owner", "manager", "reception", "kitchen", "housekeeping"];

export type SessionProfile = {
  userId: string;
  email?: string;
  fullName: string | null;
  role: Role | null;
};

/** Where a given role lands after login / when redirected off a page they can't see. */
export function roleHome(role: Role | null): string {
  return role === "housekeeping" ? "/stays" : "/pos";
}

/** Returns the signed-in staffer + profile, or null. Authoritative (validates the token). */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  if (!isSupabaseConfigured) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: user.email,
    fullName: data?.full_name ?? null,
    role: (data?.role as Role) ?? null,
  };
}

/** Require a signed-in staffer; otherwise send to login. */
export async function requireUser(): Promise<SessionProfile> {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  return session;
}

/** Require one of `allowed` roles; otherwise bounce to the role's own home. */
export async function requireRole(allowed: Role[]): Promise<SessionProfile> {
  const session = await requireUser();
  if (!session.role || !allowed.includes(session.role)) {
    redirect(roleHome(session.role));
  }
  return session;
}
