import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  STATUS_UNAVAILABLE,
  TONE_BADGE,
  guestStatusChip,
  listingStatusChip,
} from "@/lib/status-labels"
import {
  GUEST_ACCEPTED_CAPTION,
  GUEST_CARRYING_CAPTION,
  guestAcceptedCaption,
} from "@/lib/guest-tracker-caption"
import { deriveGuestStages } from "@/lib/tracker-stages"
import type { GuestJobStatus, GuestJobView } from "@/lib/guest-jobs"

// Status chips (item 8, part (b), 8.3 and 8.10 decision 3). One map per rail
// in lib/status-labels.ts; every consumer renders from it and never prints
// the raw status.

const GUEST: [string, string, string][] = [
  ["posted", "Waiting for a courier", "waiting"],
  ["pending_quote", "Waiting for a price", "waiting"],
  ["accepted", "Accepted, not picked up yet", "active"],
  ["in_transit", "On the way", "active"],
  ["delivered", "Delivered", "done"],
  ["cancelled", "Cancelled", "stopped"],
  ["expired", "Expired", "stopped"],
]

const LISTING: [string, string, string][] = [
  ["open", "Open", "waiting"],
  ["matched", "Matched", "active"],
  ["in_transit", "In transit", "active"],
  ["completed", "Completed", "done"],
  ["expired", "Closed", "stopped"],
]

const ODD: (string | null | undefined)[] = ["unknown_status", "", null, undefined, "OPEN", " open", "constructor", "__proto__"]

describe("guestStatusChip", () => {
  for (const [status, label, tone] of GUEST) {
    it(`${status} is "${label}", ${tone}`, () => {
      expect(guestStatusChip(status)).toEqual({ label, tone })
    })
  }
})

describe("listingStatusChip", () => {
  for (const [status, label, tone] of LISTING) {
    it(`${status} is "${label}", ${tone}`, () => {
      expect(listingStatusChip(status)).toEqual({ label, tone })
    })
  }
})

describe("a value the map does not know", () => {
  it('reads "Status unavailable" with tone unknown, never the input, on both rails', () => {
    for (const v of ODD) {
      for (const chip of [guestStatusChip(v), listingStatusChip(v)]) {
        expect(chip, String(v)).toEqual({ label: "Status unavailable", tone: "unknown" })
        if (v) expect(chip.label).not.toContain(v)
      }
    }
    expect(STATUS_UNAVAILABLE).toEqual({ label: "Status unavailable", tone: "unknown" })
  })

  it("a listing value is not a guest label, and the reverse", () => {
    expect(guestStatusChip("completed")).toEqual(STATUS_UNAVAILABLE)
    expect(listingStatusChip("delivered")).toEqual(STATUS_UNAVAILABLE)
  })
})

describe("labels and tones", () => {
  it("no label contains an underscore", () => {
    for (const [status] of GUEST) expect(guestStatusChip(status).label).not.toContain("_")
    for (const [status] of LISTING) expect(listingStatusChip(status).label).not.toContain("_")
    expect(STATUS_UNAVAILABLE.label).not.toContain("_")
  })

  it("each tone has the Badge variant 8.3 proposes", () => {
    expect(TONE_BADGE).toEqual({
      waiting: { variant: "outline", muted: false },
      active: { variant: "default", muted: false },
      done: { variant: "secondary", muted: false },
      stopped: { variant: "outline", muted: true },
      unknown: { variant: "outline", muted: true },
    })
  })

  it("green means done: only done is secondary, and done is never gold", () => {
    for (const [tone, b] of Object.entries(TONE_BADGE)) {
      if (tone === "done") expect(b.variant).toBe("secondary")
      else expect(b.variant).not.toBe("secondary")
    }
  })
})

describe("the guest tracker captions (8.2, part (b))", () => {
  function guest(status: GuestJobStatus, courierAssigned?: boolean): GuestJobView {
    return {
      kind: "guest",
      trackingId: "GYM-A1B2C3",
      pickupArea: "Osu",
      dropoffArea: "Madina",
      status,
      createdAt: "2026-10-01T00:00:00Z",
      pickupConfirmedAt: null,
      deliveryConfirmedAt: null,
      courierAssigned,
    }
  }
  const acceptedStage = (j: GuestJobView) => deriveGuestStages(j).find((s) => s.label === "Accepted")!

  it('pending_quote waits for a price, not a courier', () => {
    const st = acceptedStage(guest("pending_quote"))
    expect(st.caption).toBe("Waiting for a price")
    expect(st.state).toBe("current")
  })

  it('expired reads "Expired", told apart from cancelled; the stage stays cancelled', () => {
    const st = acceptedStage(guest("expired"))
    expect(st.caption).toBe("Expired")
    expect(st.state).toBe("cancelled")
    expect(acceptedStage(guest("cancelled")).caption).toBe("Cancelled")
  })

  it("the Accepted caption for every other status is unchanged", () => {
    expect(guestAcceptedCaption({ status: "posted" })).toBe("Waiting for a courier")
    expect(guestAcceptedCaption({ status: "cancelled" })).toBe("Cancelled")
    for (const status of ["accepted", "in_transit", "delivered"] as const) {
      expect(guestAcceptedCaption({ status, courierAssigned: true })).toBe(GUEST_CARRYING_CAPTION)
      expect(guestAcceptedCaption({ status, courierAssigned: false })).toBe(GUEST_ACCEPTED_CAPTION)
      expect(guestAcceptedCaption({ status })).toBe(GUEST_ACCEPTED_CAPTION)
    }
  })
})

describe("static pins", () => {
  const CONSUMERS = [
    "components/listing-detail-sheet.tsx",
    "components/trips-tab.tsx",
    "components/guest-courier-card.tsx",
    "app/courier/courier-jobs.tsx",
  ]

  it("none of the four consumers renders a raw status as text", () => {
    for (const f of CONSUMERS) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/\{\s*(listing|job|l|j)\.status\s*\}/)
      expect(src, f).not.toMatch(/\?\?\s*(listing|job)\.status\b/)
      expect(src, f).not.toMatch(/text:\s*(listing|job)\.status\b/)
      expect(src, f).toMatch(/from "@\/lib\/status-labels"/)
    }
  })

  it("the Pioneer surfaces take their chip from the right rail's map", () => {
    expect(readFileSync("components/listing-detail-sheet.tsx", "utf8")).toMatch(/listingStatusChip\(listing\.status\)/)
    expect(readFileSync("components/trips-tab.tsx", "utf8")).toMatch(/listingStatusChip\(listing\.status\)/)
    expect(readFileSync("components/guest-courier-card.tsx", "utf8")).toMatch(/guestStatusChip\(job\.status\)/)
  })

  it("courier-jobs.tsx keeps no label map of its own and prints the label as plain text", () => {
    const src = readFileSync("app/courier/courier-jobs.tsx", "utf8")
    expect(src).not.toMatch(/JOB_STATUS_LABELS/)
    expect(src).not.toMatch(/\bin_transit:\s*"/)
    expect(src).not.toMatch(/Accepted, not picked up yet/)
    expect(src).toMatch(/<p>\{guestStatusChip\(job\.status\)\.label\}<\/p>/)
  })

  it("the sheet keeps no label switch of its own", () => {
    const src = readFileSync("components/listing-detail-sheet.tsx", "utf8")
    expect(src).not.toMatch(/case "expired":\s*return \{ text:/)
    expect(src).not.toMatch(/text: "Expired"/)
  })

  it("lib/status-labels.ts has no import of any kind", () => {
    const src = readFileSync("lib/status-labels.ts", "utf8")
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\brequire\(|\bimport\(/)
    expect(src).not.toMatch(/^\s*export\s+[^\n]*\bfrom\b/m)
  })
})
