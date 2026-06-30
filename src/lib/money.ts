/**
 * Money helpers. Money is stored as integer **paise** everywhere (never floats);
 * these convert to/from the rupee strings shown in the UI.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Integer paise → display string, e.g. 12000 → "₹120", 12050 → "₹120.5". */
export function formatPaise(paise: number): string {
  return INR.format(paise / 100);
}

/** Integer paise → bare rupee string for an editable input, e.g. 12000 → "120". */
export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Rupee input → integer paise. Returns null for anything that isn't a
 * non-negative number (so callers can show a validation error).
 */
export function rupeesToPaise(input: FormDataEntryValue | null): number | null {
  const n = Number(String(input ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
