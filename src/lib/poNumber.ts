// Customer PO numbers mirrored from the sales pipeline (SharePoint Lead
// List.PONum via the sync-leads function).
//
// The pipeline field is free text the team types by hand, and roughly a fifth
// of the filled-in values are notes rather than numbers: "Verbal", "Verbal
// Jeremy", "CC", "Credit Card", "TBR", "Email PO", or just the name of the
// person who gave the go-ahead. Showing a customer "PO: Verbal Jeremy" would
// be nonsense, so the two audiences see different things:
//
//   - Everyone (customers included) sees values that look like an actual
//     reference — the test is simply "contains a digit", which keeps short
//     real POs like "7260" and rejects every observed placeholder.
//   - Admins additionally see the placeholders, rendered as a muted note, so
//     they can tell WHY a project's PO requirement is already satisfied.
//
// Deliberately not stricter than "has a digit": customer PO formats are wildly
// inconsistent (4-digit numbers, "T-31590", "SEWARD72926", "202603-20"), and a
// tighter pattern would hide real POs from the people who issued them.

export function hasPoNumber(poNumber: string | null | undefined): boolean {
  return !!poNumber && poNumber.trim().length > 0
}

/** True when the value reads as a real PO reference rather than a placeholder note. */
export function isRealPoNumber(poNumber: string | null | undefined): boolean {
  return hasPoNumber(poNumber) && /\d/.test(poNumber!)
}

/**
 * What to render for this viewer, or null to render nothing.
 * Placeholders collapse to null for customers and to the raw note for admins.
 */
export function displayPoNumber(
  poNumber: string | null | undefined,
  isAdmin: boolean,
): string | null {
  if (!hasPoNumber(poNumber)) return null
  const trimmed = poNumber!.trim()
  if (isRealPoNumber(trimmed)) return trimmed
  return isAdmin ? trimmed : null
}
