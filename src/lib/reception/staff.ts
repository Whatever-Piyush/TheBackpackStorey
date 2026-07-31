import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Reception staff (0013_staff.sql). Two roles, no permission matrix:
 * `owner` additionally sees rates, direct allotment and daily close.
 */

export type StaffRole = "owner" | "staff";

export type StaffMember = {
  userId: string;
  email?: string;
  displayName: string;
  role: StaffRole;
};

/** The signed-in reception staffer, or null. Validates the token. */
export async function getStaff(): Promise<StaffMember | null> {
  if (!isSupabaseConfigured) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // RLS limits this to the caller's own row.
  const { data } = await supabase
    .from("staff")
    .select("display_name, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return null;

  return {
    userId: user.id,
    email: user.email,
    displayName: (data.display_name as string) ?? user.email ?? "Reception",
    role: data.role as StaffRole,
  };
}

/**
 * Authoritative gate for /reception. The proxy does an optimistic redirect for
 * signed-out users; this additionally rejects authenticated users who are not
 * reception staff (e.g. a kitchen account from the café portal).
 */
export async function requireStaff(): Promise<StaffMember> {
  const staff = await getStaff();
  if (!staff) redirect("/login?redirectTo=/reception");
  return staff;
}

export function isOwner(staff: StaffMember): boolean {
  return staff.role === "owner";
}
