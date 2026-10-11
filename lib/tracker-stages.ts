import type { Listing } from "./listings"
import type { GuestJobView } from "./guest-jobs"
import { guestAcceptedCaption } from "./guest-tracker-caption"

// The tracker's four stages for each rail, used by
// components/delivery-tracker.tsx (item 8, 8.2 and part (d)). Pure: the only
// runtime import is lib/guest-tracker-caption.ts, itself import-free, so the
// stages are tested directly (tests/tracker-stages.test.ts). Here rather than
// in the component because the test runner does not load .tsx (8.11).

export type Stage = {
  label: string
  caption: string
  state: "done" | "current" | "upcoming" | "cancelled"
}

// Copy approved 11 Oct 2026 (8.17).
// An expired listing: cancelled and expired are one value on the row (8.3), and
// the row does not record whether a handover happened (8.10 decision 1).
export const LISTING_CLOSED_CAPTION = "Closed"
// Copy approved 11 Oct 2026 (8.17). An open trip listing: the poster is the traveller, so it waits
// for a sender. An open package listing keeps "Waiting for a traveller".
export const TRIP_WAITING_CAPTION = "Waiting for a sender"
export const PACKAGE_WAITING_CAPTION = "Waiting for a traveller"
// Copy approved 11 Oct 2026 (8.17). A matched package listing whose matched
// username is missing: no handle to show, so no "@".
export const UNNAMED_TRAVELLER_CAPTION = "A traveller is carrying it"

// Copy approved 11 Oct 2026 (8.17). Nothing on either rail records a
// signature (8.2).
export function deliveredCaption(place: string): string {
  return `Delivered in ${place}`
}

function fmtDate(iso?: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

/**
 * Who is carrying a matched listing, by kind (listing-detail-sheet.tsx:61-71).
 * package: a sender posted, so the matched user is the traveller.
 * trip: a traveller posted, so the poster is the traveller.
 * With no matched username the package caption names no one (8.17 D5).
 */
export function listingCarrierCaption(l: Listing): string {
  if (l.kind === "trip") return `@${l.postedByUsername} is carrying it`
  return l.matchedWithUsername ? `@${l.matchedWithUsername} is carrying it` : UNNAMED_TRAVELLER_CAPTION
}

export function deriveStages(l: Listing): Stage[] {
  const s = l.status
  const cancelled = s === "expired"
  const acceptedDone = s === "matched" || s === "in_transit" || s === "completed"
  const delivered = s === "completed"

  return [
    {
      label: "Posted",
      caption: `@${l.postedByUsername} · ${fmtDate(l.createdAt)}`,
      state: "done",
    },
    {
      label: "Accepted",
      caption: cancelled
        ? LISTING_CLOSED_CAPTION
        : acceptedDone
          ? listingCarrierCaption(l)
          : l.kind === "trip"
            ? TRIP_WAITING_CAPTION
            : PACKAGE_WAITING_CAPTION,
      state: cancelled ? "cancelled" : acceptedDone ? "done" : "current",
    },
    {
      label: "In transit",
      caption: `On the way to ${l.toCity}`,
      state: cancelled ? "upcoming" : s === "in_transit" ? "current" : delivered ? "done" : "upcoming",
    },
    {
      label: "Delivered",
      caption: delivered ? deliveredCaption(l.toCity) : `Destination: ${l.toCity}`,
      state: delivered ? "done" : "upcoming",
    },
  ]
}

export function deriveGuestStages(j: GuestJobView): Stage[] {
  const s = j.status
  const cancelled = s === "cancelled" || s === "expired"
  const acceptedDone = s === "accepted" || s === "in_transit" || s === "delivered"
  const delivered = s === "delivered"

  return [
    {
      label: "Posted",
      caption: `Sender confirmed on WhatsApp · ${fmtDate(j.createdAt)}`,
      state: "done",
    },
    {
      label: "Accepted",
      caption: guestAcceptedCaption(j),
      state: cancelled ? "cancelled" : acceptedDone ? "done" : "current",
    },
    {
      label: "In transit",
      caption: `On the way to ${j.dropoffArea}`,
      state: cancelled ? "upcoming" : s === "in_transit" ? "current" : delivered ? "done" : "upcoming",
    },
    {
      label: "Delivered",
      caption: delivered ? deliveredCaption(j.dropoffArea) : `Destination: ${j.dropoffArea}`,
      state: delivered ? "done" : "upcoming",
    },
  ]
}
