import type { Listing } from "./listings"
import type { GuestJobView } from "./guest-jobs"
import { STAMP_BOTH, STAMP_COURIER_CODE, STAMP_SENDER } from "./delivery-stamps"

// The "Delivery completed" line, chosen from the stamps on the row (item 8,
// scope addition A, 8.2 and part (c)). One function per rail, shared by
// components/track-view.tsx, components/track-tab.tsx and
// components/listing-detail-sheet.tsx. Pure: the only runtime import is
// lib/delivery-stamps.ts, itself import-free, so the lines are tested
// directly (tests/completion-lines.test.ts).
//
// A line says only what the row records. A `completed` listing is not proof
// that both flags are set, and a `delivered` guest job may carry no stamp at
// all (closed by hand, F14), so neither status alone picks a "both" line.
//
// The pickup half reads pickupConfirmedAt only (8.10 decision 4): "sender" is
// the one pickup_confirmed_by value ever written, so the track route carries
// no new field.
//
// Copy approved 11 Oct 2026 (8.17), except where a line is marked otherwise.
// The second sentence is "Thanks for using Gyema." (8.17 D1); it replaced a
// comparative claim.

// COPY: later (8.17). The three "You confirmed" lines are worded to the
// sender, but the tracker shows them to anyone holding the tracking ID.
export const GUEST_LINE_SENDER_AND_CODE =
  "You confirmed this delivery and the courier entered your delivery code at handover."
export const GUEST_LINE_PICKUP_AND_DELIVERY = "You confirmed pickup and delivery."
export const GUEST_LINE_DELIVERY = "You confirmed delivery."
export const GUEST_LINE_CODE_ONLY = "The courier entered your delivery code at handover."
export const LISTING_LINE_BOTH = "Both sender and traveller confirmed this delivery as done."
// No stamp, or a value the map does not know: nothing about who confirmed.
export const LINE_MARKED_COMPLETE = "This delivery is marked complete."
export const COMPLETION_THANKS = "Thanks for using Gyema."

export function guestCompletionLine(
  j: Pick<GuestJobView, "deliveryConfirmedBy" | "pickupConfirmedAt">
): string {
  const by = j.deliveryConfirmedBy
  if (by === STAMP_BOTH) return GUEST_LINE_SENDER_AND_CODE
  if (by === STAMP_SENDER) return j.pickupConfirmedAt ? GUEST_LINE_PICKUP_AND_DELIVERY : GUEST_LINE_DELIVERY
  if (by === STAMP_COURIER_CODE) return GUEST_LINE_CODE_ONLY
  return LINE_MARKED_COMPLETE
}

export function listingCompletionLine(l: Pick<Listing, "senderConfirmed" | "travellerConfirmed">): string {
  return l.senderConfirmed === true && l.travellerConfirmed === true ? LISTING_LINE_BOTH : LINE_MARKED_COMPLETE
}

/**
 * The whole completion message for a tracked result, by rail. A guest result
 * only ever gets a guest line, so track-tab.tsx cannot print the listing line
 * for a guest job (8.8 (c)).
 */
export function completionMessage(result: Listing | GuestJobView): string {
  const line = result.kind === "guest" ? guestCompletionLine(result) : listingCompletionLine(result)
  return `${line} ${COMPLETION_THANKS}`
}
