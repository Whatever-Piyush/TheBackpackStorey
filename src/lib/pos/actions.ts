"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type Role } from "@/lib/auth";
import { rupeesToPaise } from "@/lib/money";
import type { MenuStation } from "@/lib/pos/types";

// Matches the menu_*_write RLS policies (owner / manager / reception).
const MENU_ROLES: Role[] = ["owner", "manager", "reception"];
const VALID_STATIONS: MenuStation[] = ["main", "bar", "coffee"];

export type ActionResult = { ok: true } | { ok: false; error: string };

const ok: ActionResult = { ok: true };
const fail = (error: string): ActionResult => ({ ok: false, error });

function station(input: FormDataEntryValue | null): MenuStation {
  const s = String(input ?? "");
  return (VALID_STATIONS as string[]).includes(s) ? (s as MenuStation) : "main";
}

/** Guard every action: must be a signed-in front-desk role; returns a client. */
async function authed() {
  await requireRole(MENU_ROLES);
  return createClient();
}

// ---------------------------------------------------------------- categories

export async function createCategory(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return fail("Category name is required.");
  const sortOrder = Number(formData.get("sort_order") ?? 0) || 0;

  const supabase = await authed();
  const { error } = await supabase
    .from("menu_categories")
    .insert({ name, sort_order: sortOrder });
  if (error) return fail(error.message);

  revalidatePath("/pos/menu");
  return ok;
}

export async function deleteCategory(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await authed();
  // ON DELETE CASCADE removes the category's items too.
  await supabase.from("menu_categories").delete().eq("id", id);
  revalidatePath("/pos/menu");
}

// --------------------------------------------------------------------- items

export async function createItem(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const categoryId = String(formData.get("category_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const pricePaise = rupeesToPaise(formData.get("price"));

  if (!categoryId) return fail("Missing category.");
  if (!name) return fail("Item name is required.");
  if (pricePaise === null) return fail("Enter a valid price (₹).");

  const supabase = await authed();
  const { error } = await supabase.from("menu_items").insert({
    category_id: categoryId,
    name,
    price_paise: pricePaise,
    kitchen_station: station(formData.get("station")),
  });
  if (error) return fail(error.message);

  revalidatePath("/pos/menu");
  return ok;
}

export async function updateItem(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const pricePaise = rupeesToPaise(formData.get("price"));

  if (!id) return fail("Missing item.");
  if (!name) return fail("Item name is required.");
  if (pricePaise === null) return fail("Enter a valid price (₹).");

  const supabase = await authed();
  const { error } = await supabase
    .from("menu_items")
    .update({
      name,
      price_paise: pricePaise,
      kitchen_station: station(formData.get("station")),
      is_available: formData.get("is_available") === "on",
    })
    .eq("id", id);
  if (error) return fail(error.message);

  revalidatePath("/pos/menu");
  return ok;
}

export async function deleteItem(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await authed();
  await supabase.from("menu_items").delete().eq("id", id);
  revalidatePath("/pos/menu");
}
