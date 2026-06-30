/**
 * Client-safe café/POS types and constants. No server imports here, so both
 * Server and Client Components can import from this module freely.
 */

/** Where a menu item is prepared — drives kitchen display routing later. */
export type MenuStation = "main" | "bar" | "coffee";

export const STATIONS: { value: MenuStation; label: string }[] = [
  { value: "main", label: "Kitchen" },
  { value: "bar", label: "Bar" },
  { value: "coffee", label: "Coffee" },
];

export type MenuItem = {
  id: string;
  name: string;
  price_paise: number;
  kitchen_station: MenuStation;
  is_available: boolean;
};

export type MenuCategory = {
  id: string;
  name: string;
  sort_order: number;
  items: MenuItem[];
};
