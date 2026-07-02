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

// -------------------------------------------------------------------- orders

export type OrderType = "dine_in" | "takeaway" | "room";
export type CartLine = { menuItemId: string; qty: number; notes?: string };
export type OrderResult =
  | { ok: true; ref: string; total: number }
  | { ok: false; error: string };

/** Create an order + its items and send it to the kitchen (status 'sent'). */
export async function createOrder(input: {
  type: OrderType;
  tableLabel?: string;
  roomId?: string;
  discountPaise?: number;
  items: CartLine[];
}): Promise<OrderResult> {
  const session = await requireRole(MENU_ROLES);
  const supabase = await createClient();

  const lines = (input.items ?? []).filter((l) => l.qty > 0 && l.menuItemId);
  if (lines.length === 0) return { ok: false, error: "Add at least one item." };
  if (input.type === "room" && !input.roomId)
    return { ok: false, error: "Pick a room for room service." };

  // Re-read prices server-side — never trust the client for money.
  const ids = [...new Set(lines.map((l) => l.menuItemId))];
  const { data: menuItems, error: mErr } = await supabase
    .from("menu_items")
    .select("id, price_paise, is_available")
    .in("id", ids);
  if (mErr) return { ok: false, error: mErr.message };

  const byId = new Map((menuItems ?? []).map((m) => [m.id as string, m]));
  for (const l of lines) {
    const m = byId.get(l.menuItemId);
    if (!m) return { ok: false, error: "An item is no longer on the menu." };
    if (!m.is_available) return { ok: false, error: "An item is no longer available." };
  }

  const subtotal = lines.reduce(
    (s, l) => s + (byId.get(l.menuItemId)!.price_paise as number) * l.qty,
    0,
  );
  const discount = Math.min(Math.max(0, Math.round(input.discountPaise ?? 0)), subtotal);
  const total = subtotal - discount;

  const { data: order, error: oErr } = await supabase
    .from("orders")
    .insert({
      type: input.type,
      table_label: input.type === "dine_in" ? input.tableLabel?.trim() || null : null,
      room_id: input.type === "room" ? input.roomId : null,
      status: "sent",
      subtotal_paise: subtotal,
      discount_paise: discount,
      total_paise: total,
      created_by: session.userId,
    })
    .select("id")
    .single();
  if (oErr || !order) return { ok: false, error: oErr?.message ?? "Couldn't create the order." };

  const rows = lines.map((l) => ({
    order_id: order.id,
    menu_item_id: l.menuItemId,
    qty: l.qty,
    price_paise: byId.get(l.menuItemId)!.price_paise as number,
    notes: l.notes?.trim() || null,
    status: "pending",
  }));
  const { error: iErr } = await supabase.from("order_items").insert(rows);
  if (iErr) {
    await supabase.from("orders").delete().eq("id", order.id); // don't leave an empty ticket
    return { ok: false, error: iErr.message };
  }

  revalidatePath("/pos/kitchen");
  revalidatePath("/pos/today");
  return { ok: true, ref: String(order.id).slice(0, 8).toUpperCase(), total };
}
