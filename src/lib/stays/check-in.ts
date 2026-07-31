"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Check-in and ID capture.
 *
 * ID scans are the most sensitive data in the system, so they live in a PRIVATE
 * bucket with no storage policies at all: only the service role can touch the
 * objects, and reception views them through short-lived signed URLs minted here.
 * A public URL is never generated or stored.
 */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];
const BUCKET = "guest-ids";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export type CheckInResult =
  | { ok: true; message: string }
  | { ok: false; error: string; missingId?: string[] };

/** One person as submitted from the check-in drawer. */
export type GuestInput = {
  guestId?: string;
  name: string;
  phone?: string;
  email?: string;
  nationality?: string;
  idProofType?: string;
  idProofNumber?: string;
  passportNumber?: string;
  passportIssueDate?: string;
  passportExpiry?: string;
  visaNumber?: string;
  visaType?: string;
  visaExpiry?: string;
  arrivedInIndiaOn?: string;
  arrivedFrom?: string;
  nextDestination?: string;
  isLead?: boolean;
};

/**
 * Check the whole reservation in — one action covering every person and every
 * bed. The party is validated in full before anything is written, so a group
 * missing one person's ID leaves no half-recorded state behind.
 */
export async function checkIn(
  _prev: CheckInResult | null,
  formData: FormData,
): Promise<CheckInResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  if (!reservationId) return { ok: false, error: "Missing reservation." };

  let guests: GuestInput[];
  try {
    guests = JSON.parse(String(formData.get("guests") ?? "[]")) as GuestInput[];
  } catch {
    return { ok: false, error: "Couldn't read the guest details." };
  }
  if (!Array.isArray(guests) || guests.length === 0) {
    return { ok: false, error: "Add at least one guest." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_in_reservation", {
    p_reservation_id: reservationId,
    p_guests: guests,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    rooms?: string;
    units?: number;
    guests?: number;
    missing?: string[];
  };

  if (!result?.ok) {
    if (result?.code === "ID_REQUIRED") {
      const who = (result.missing ?? []).join(", ");
      return {
        ok: false,
        error: `ID is required for every guest — still missing for ${who}.`,
        missingId: result.missing,
      };
    }
    const messages: Record<string, string> = {
      NOT_FOUND: "That booking no longer exists.",
      ALREADY_CHECKED_IN: "That guest is already checked in.",
      NOT_ARRIVABLE: "That booking can't be checked in — it's cancelled or already closed.",
      NO_UNITS: "No bed is assigned to that booking. Assign one on the board first.",
      NO_GUESTS: "Add at least one guest.",
      NAME_REQUIRED: "Every guest needs a name.",
    };
    return { ok: false, error: messages[result?.code ?? ""] ?? "Couldn't check them in." };
  }

  revalidatePath("/stays/arrivals");
  revalidatePath("/stays/board");
  return {
    ok: true,
    message: `${result.guests} guest${result.guests === 1 ? "" : "s"} checked in to ${result.rooms}.`,
  };
}

/** Store an ID scan against the guest. Private bucket; path only, never a URL. */
export async function uploadGuestDocument(
  _prev: CheckInResult | null,
  formData: FormData,
): Promise<CheckInResult> {
  const session = await requireRole(DESK_ROLES);

  const guestId = String(formData.get("guest_id") ?? "");
  const reservationId = String(formData.get("reservation_id") ?? "") || null;
  const kind = String(formData.get("kind") ?? "id");
  const file = formData.get("file");

  if (!guestId) return { ok: false, error: "Missing guest." };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "That file is larger than 10 MB." };
  }
  if (!ALLOWED.includes(file.type)) {
    return { ok: false, error: "Upload a photo (JPG, PNG, WebP, HEIC) or a PDF." };
  }

  const db = createAdminClient();
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  // Namespaced by guest, random per file: the key is never guessable.
  const path = `${guestId}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  const { error: rowErr } = await db.from("guest_documents").insert({
    guest_id: guestId,
    reservation_id: reservationId,
    kind: ["passport", "visa", "aadhaar", "driving_licence", "id", "other"].includes(kind)
      ? kind
      : "id",
    storage_path: path,
    original_name: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    uploaded_by: session.userId,
  });
  if (rowErr) {
    // Don't leave an orphaned object nobody can find a record of.
    await db.storage.from(BUCKET).remove([path]);
    return { ok: false, error: rowErr.message };
  }

  revalidatePath("/stays/arrivals");
  return { ok: true, message: "Document saved." };
}

/** A short-lived link to a stored scan. Minted per view; nothing is cached. */
export async function getDocumentUrl(documentId: string): Promise<string | null> {
  await requireRole(DESK_ROLES);

  const db = createAdminClient();
  const { data: doc } = await db
    .from("guest_documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return null;

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path as string, 60);
  if (error) return null;
  return data.signedUrl;
}
