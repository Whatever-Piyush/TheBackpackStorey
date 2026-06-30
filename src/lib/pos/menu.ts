import { createClient } from "@/lib/supabase/server";
import type { MenuCategory, MenuItem } from "@/lib/pos/types";

export type { MenuStation, MenuItem, MenuCategory } from "@/lib/pos/types";
export { STATIONS } from "@/lib/pos/types";

/** Full menu: categories (by sort_order) each with their items (by name). */
export async function getMenu(): Promise<MenuCategory[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .select(
      "id, name, sort_order, menu_items(id, name, price_paise, kitchen_station, is_available)",
    )
    .order("sort_order")
    .order("name", { referencedTable: "menu_items" });

  if (error) throw new Error(`Failed to load menu: ${error.message}`);

  return (data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    sort_order: c.sort_order as number,
    items: (c.menu_items ?? []) as MenuItem[],
  }));
}
