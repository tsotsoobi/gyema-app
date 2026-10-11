// One status label map per rail, in one place (item 8, 8.3 and part (b)).
// Pure, with no imports of any kind, so the courier page can import it
// without the Pi client (tests/courier-host.test.ts) and it is tested on its
// own (tests/status-labels.test.ts).
//
// Copy approved 11 Oct 2026 (8.17). A value the map does not know reads "Status unavailable",
// never the raw string, so a stored value never reaches a person as text.
//
// The tone carries the colour, and green means done on every surface,
// matching the tracker (8.10 decision 3).

export type StatusTone = "waiting" | "active" | "done" | "stopped" | "unknown"

export type StatusChip = { label: string; tone: StatusTone }

/** The Badge variant for each tone, and whether its text is muted. */
export const TONE_BADGE: Record<StatusTone, { variant: "outline" | "default" | "secondary"; muted: boolean }> = {
  waiting: { variant: "outline", muted: false },
  active: { variant: "default", muted: false },
  done: { variant: "secondary", muted: false },
  stopped: { variant: "outline", muted: true },
  unknown: { variant: "outline", muted: true },
}

export const STATUS_UNAVAILABLE: StatusChip = { label: "Status unavailable", tone: "unknown" }

const GUEST_CHIPS: Record<string, StatusChip> = {
  posted: { label: "Waiting for a courier", tone: "waiting" },
  pending_quote: { label: "Waiting for a price", tone: "waiting" },
  accepted: { label: "Accepted, not picked up yet", tone: "active" },
  in_transit: { label: "On the way", tone: "active" },
  delivered: { label: "Delivered", tone: "done" },
  cancelled: { label: "Cancelled", tone: "stopped" },
  expired: { label: "Expired", tone: "stopped" },
}

const LISTING_CHIPS: Record<string, StatusChip> = {
  open: { label: "Open", tone: "waiting" },
  matched: { label: "Matched", tone: "active" },
  in_transit: { label: "In transit", tone: "active" },
  completed: { label: "Completed", tone: "done" },
  // The row cannot tell cancelled from expired (8.3, 8.10 decision 1).
  expired: { label: "Closed", tone: "stopped" },
}

function lookup(map: Record<string, StatusChip>, status: string | null | undefined): StatusChip {
  if (typeof status !== "string") return STATUS_UNAVAILABLE
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : STATUS_UNAVAILABLE
}

export function guestStatusChip(status: string | null | undefined): StatusChip {
  return lookup(GUEST_CHIPS, status)
}

export function listingStatusChip(status: string | null | undefined): StatusChip {
  return lookup(LISTING_CHIPS, status)
}
