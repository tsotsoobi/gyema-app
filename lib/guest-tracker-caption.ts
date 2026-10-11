import type { GuestJobView } from "./guest-jobs"

// The guest tracker's Accepted stage caption (item 8, 8.1 and 8.2), used by
// components/delivery-tracker.tsx. Pure, with no runtime import (the import
// above is type-only and erased), so it is tested on its own
// (tests/delivery-tracker-caption.test.ts). Here rather than in the component
// because the test runner does not load .tsx.
//
// Never names the courier: /api/guest/track emits only whether one holds the
// job, as courierAssigned.

// Copy approved 11 Oct 2026 (8.17).
export const GUEST_CARRYING_CAPTION = "A courier took this job"
// Copy approved 11 Oct 2026 (8.17). A status-only caption with no carrier claim: the row records no
// courier, or the payload predates courierAssigned and so does not say.
export const GUEST_ACCEPTED_CAPTION = "Accepted"

// Copy approved 11 Oct 2026 (8.17). Part (b), 8.2 and 8.3: pending_quote waits for a price, not a
// courier. expired is told apart from cancelled; the stage stays vermillion.
export const GUEST_PRICE_WAITING_CAPTION = "Waiting for a price"
export const GUEST_EXPIRED_CAPTION = "Expired"

export function guestAcceptedCaption(j: Pick<GuestJobView, "status" | "courierAssigned">): string {
  const s = j.status
  if (s === "cancelled") return "Cancelled"
  if (s === "expired") return GUEST_EXPIRED_CAPTION
  if (s === "accepted" || s === "in_transit" || s === "delivered") {
    return j.courierAssigned === true ? GUEST_CARRYING_CAPTION : GUEST_ACCEPTED_CAPTION
  }
  if (s === "pending_quote") return GUEST_PRICE_WAITING_CAPTION
  return "Waiting for a courier"
}
