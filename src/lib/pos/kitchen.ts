import { createClient } from "@/lib/supabase/server";
import type { CheckedInGuest, ItemStatus, OpenOrder, Ticket } from "@/lib/pos/types";
import type { MenuStation } from "@/lib/pos/types";

/**
 * Kitchen and billing reads. All server-side on the authenticated client, so
 * RLS applies (kitchen staff can see tickets, and nothing else).
 */

/** Orders still in the kitchen: sent, or fully prepared but not yet settled. */
export async function getTickets(): Promise<Ticket[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("orders")
    .select(
      `id, type, table_label, status, created_at,
       rooms(number),
       order_items(id, qty, notes, status, menu_items(name, kitchen_station))`,
    )
    .in("status", ["sent", "served"])
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load tickets: ${error.message}`);

  type Row = {
    id: string;
    type: Ticket["type"];
    table_label: string | null;
    status: string;
    created_at: string;
    rooms: { number: string } | null;
    order_items: {
      id: string;
      qty: number;
      notes: string | null;
      status: ItemStatus;
      menu_items: { name: string; kitchen_station: MenuStation } | null;
    }[];
  };

  return ((data ?? []) as unknown as Row[]).map((o) => ({
    id: o.id,
    ref: o.id.slice(0, 8).toUpperCase(),
    type: o.type,
    where:
      o.type === "room"
        ? `Room ${o.rooms?.number ?? "?"}`
        : o.type === "dine_in"
          ? o.table_label
            ? `Table ${o.table_label}`
            : "Dine-in"
          : "Takeaway",
    status: o.status,
    createdAt: o.created_at,
    items: (o.order_items ?? []).map((i) => ({
      id: i.id,
      name: i.menu_items?.name ?? "Item",
      qty: i.qty,
      notes: i.notes,
      status: i.status,
      station: i.menu_items?.kitchen_station ?? "main",
    })),
  }));
}

/** Unsettled orders — the bills screen works through this list. */
export async function getOpenOrders(): Promise<OpenOrder[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("orders")
    .select("id, type, table_label, status, created_at, total_paise, rooms(number), order_items(id)")
    .not("status", "in", "(paid,void)")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load open orders: ${error.message}`);

  type Row = {
    id: string;
    type: OpenOrder["type"];
    table_label: string | null;
    status: string;
    created_at: string;
    total_paise: number;
    rooms: { number: string } | null;
    order_items: { id: string }[];
  };

  return ((data ?? []) as unknown as Row[]).map((o) => ({
    id: o.id,
    ref: o.id.slice(0, 8).toUpperCase(),
    type: o.type,
    where:
      o.type === "room"
        ? `Room ${o.rooms?.number ?? "?"}`
        : o.type === "dine_in"
          ? o.table_label
            ? `Table ${o.table_label}`
            : "Dine-in"
          : "Takeaway",
    status: o.status,
    createdAt: o.created_at,
    totalPaise: o.total_paise,
    itemCount: (o.order_items ?? []).length,
  }));
}

/**
 * In-house guests available for charge-to-room. `reservations` is
 * deny-by-default, so this goes through a SECURITY DEFINER function.
 */
export async function getCheckedInGuests(): Promise<CheckedInGuest[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pos_checked_in_guests");
  if (error) throw new Error(`Failed to load in-house guests: ${error.message}`);
  return (data ?? []) as CheckedInGuest[];
}
