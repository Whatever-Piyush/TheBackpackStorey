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

/* ------------------------------------------------------------------ kitchen */

export type ItemStatus = "pending" | "preparing" | "ready";

/** Kitchen-facing labels. The schema calls the first state 'pending'. */
export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending: "Queued",
  preparing: "Preparing",
  ready: "Ready",
};

/** One step along pending → preparing → ready. `null` once ready. */
export function nextItemStatus(current: ItemStatus): ItemStatus | null {
  if (current === "pending") return "preparing";
  if (current === "preparing") return "ready";
  return null;
}

export type TicketItem = {
  id: string;
  name: string;
  qty: number;
  notes: string | null;
  status: ItemStatus;
  station: MenuStation;
};

export type Ticket = {
  id: string;
  ref: string;
  type: "dine_in" | "takeaway" | "room";
  where: string;
  status: string;
  createdAt: string;
  items: TicketItem[];
};

/* --------------------------------------------------------------- settlement */

export type PaymentMethod = "cash" | "upi" | "card";

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
];

export type CheckedInGuest = {
  reservationId: string;
  code: string;
  guestName: string;
  rooms: string[];
};

export type OpenOrder = {
  id: string;
  ref: string;
  type: "dine_in" | "takeaway" | "room";
  where: string;
  status: string;
  createdAt: string;
  totalPaise: number;
  itemCount: number;
};

export type DayOrder = {
  id: string;
  ref: string;
  type: string;
  tableLabel: string | null;
  status: string;
  createdAt: string;
  totalPaise: number;
  discountPaise: number;
  items: number;
  chargedToRoom: boolean;
  method: PaymentMethod | null;
};

export type DayReport = {
  date: string;
  orders: DayOrder[];
  byMethod: { method: PaymentMethod; count: number; totalPaise: number }[];
  summary: {
    orders: number;
    open: number;
    settled: number;
    void: number;
    grossPaise: number;
    openPaise: number;
    discountPaise: number;
    toRoomPaise: number;
  };
  closed: { at: string; by: string | null } | null;
};
