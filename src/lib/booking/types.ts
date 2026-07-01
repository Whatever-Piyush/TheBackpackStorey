import type { RoomType } from "@/lib/site";

/** Client-safe booking types (kept out of the "use server" actions file). */

export type AvailOption = {
  type: RoomType;
  name: string;
  isDorm: boolean;
  ratePaise: number;
  freeUnits: number;
  unitLabel: string;
};

export type AvailabilityResult =
  | { ok: true; nights: number; options: AvailOption[] }
  | { ok: false; error: string };

export type BookingResult =
  | { ok: true; ref: string; total: number; whatsapp: string }
  | { ok: false; error: string };
