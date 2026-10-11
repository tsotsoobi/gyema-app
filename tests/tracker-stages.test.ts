import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import type { Listing } from "@/lib/listings"
import type { GuestJobView, GuestJobStatus } from "@/lib/guest-jobs"
import { guestAcceptedCaption } from "@/lib/guest-tracker-caption"
import {
  LISTING_CLOSED_CAPTION,
  PACKAGE_WAITING_CAPTION,
  TRIP_WAITING_CAPTION,
  deliveredCaption,
  deriveGuestStages,
  deriveStages,
} from "@/lib/tracker-stages"

// The tracker's stages (item 8, part (d)): the listing carrier by kind, the
// neutral expired caption, the open trip caption, and no "Signed for" on
// either rail. lib/tracker-stages.ts is pure, so it is tested directly.

const POSTER = "poster_fixture"
const MATCHED = "matched_fixture"

function listing(kind: "trip" | "package", status: Listing["status"]): Listing {
  return {
    kind,
    status,
    postedByUsername: POSTER,
    matchedWithUsername: status === "open" ? null : MATCHED,
    fromCity: "Osu",
    toCity: "Madina",
    createdAt: "2026-10-01T00:00:00Z",
  } as unknown as Listing
}

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

function accepted(stages: { label: string; caption: string }[]): string {
  return stages.find((s) => s.label === "Accepted")!.caption
}

const LISTING_STATUSES: Listing["status"][] = ["open", "matched", "in_transit", "completed", "expired"]
const GUEST_STATUSES: GuestJobStatus[] = [
  "posted",
  "pending_quote",
  "accepted",
  "in_transit",
  "delivered",
  "cancelled",
  "expired",
]

describe("the listing carrier, by kind", () => {
  for (const status of ["matched", "in_transit", "completed"] as const) {
    it(`a trip listing (${status}) names the poster as carrier, never the matched user`, () => {
      const caption = accepted(deriveStages(listing("trip", status)))
      expect(caption).toBe(`@${POSTER} is carrying it`)
      expect(caption).not.toContain(MATCHED)
    })

    it(`a package listing (${status}) names the matched user as carrier, never the poster`, () => {
      const caption = accepted(deriveStages(listing("package", status)))
      expect(caption).toBe(`@${MATCHED} is carrying it`)
      expect(caption).not.toContain(POSTER)
    })
  }
})

describe("an open listing, by kind", () => {
  it("a trip listing waits for a sender", () => {
    expect(accepted(deriveStages(listing("trip", "open")))).toBe(TRIP_WAITING_CAPTION)
    expect(TRIP_WAITING_CAPTION).toBe("Waiting for a sender")
  })

  it("a package listing waits for a traveller", () => {
    expect(accepted(deriveStages(listing("package", "open")))).toBe(PACKAGE_WAITING_CAPTION)
    expect(PACKAGE_WAITING_CAPTION).toBe("Waiting for a traveller")
  })
})

describe("an expired listing", () => {
  for (const kind of ["trip", "package"] as const) {
    it(`a ${kind} listing reads the neutral caption, with no "Match" or "cancelled"`, () => {
      const caption = accepted(deriveStages(listing(kind, "expired")))
      expect(caption).toBe(LISTING_CLOSED_CAPTION)
      expect(LISTING_CLOSED_CAPTION).toBe("Closed")
      expect(caption).not.toMatch(/match/i)
      expect(caption).not.toMatch(/cancelled/i)
    })
  }
})

describe("no caption says Signed", () => {
  it("on the listing rail, every kind and status", () => {
    for (const kind of ["trip", "package"] as const) {
      for (const status of LISTING_STATUSES) {
        for (const st of deriveStages(listing(kind, status))) {
          expect(st.caption, `${kind} ${status} ${st.label}`).not.toMatch(/Signed/i)
        }
      }
    }
  })

  it("on the guest rail, every status", () => {
    for (const status of GUEST_STATUSES) {
      for (const st of deriveGuestStages(guest(status, true))) {
        expect(st.caption, `${status} ${st.label}`).not.toMatch(/Signed/i)
      }
    }
  })

  it("a delivered stage reads Delivered in the place, on both rails", () => {
    expect(deliveredCaption("Madina")).toBe("Delivered in Madina")
    const l = deriveStages(listing("package", "completed")).find((s) => s.label === "Delivered")!
    expect(l.caption).toBe("Delivered in Madina")
    const g = deriveGuestStages(guest("delivered", true)).find((s) => s.label === "Delivered")!
    expect(g.caption).toBe("Delivered in Madina")
  })
})

describe("the guest Accepted caption", () => {
  it("still comes from guestAcceptedCaption, for every status and courierAssigned value", () => {
    for (const status of GUEST_STATUSES) {
      for (const courierAssigned of [true, false, undefined]) {
        const j = guest(status, courierAssigned)
        expect(accepted(deriveGuestStages(j))).toBe(guestAcceptedCaption(j))
      }
    }
  })
})

describe("static pins", () => {
  it("delivery-tracker.tsx imports the stages from @/lib/tracker-stages", () => {
    const src = readFileSync("components/delivery-tracker.tsx", "utf8")
    expect(src).toMatch(
      /import\s*\{[^}]*\bderiveStages\b[^}]*\}\s*from\s*"@\/lib\/tracker-stages"/
    )
    expect(src).not.toMatch(/function\s+derive(Guest)?Stages/)
  })

  it('delivery-tracker.tsx no longer contains "Match cancelled" or "Signed for"', () => {
    const src = readFileSync("components/delivery-tracker.tsx", "utf8")
    expect(src).not.toMatch(/Match cancelled/)
    expect(src).not.toMatch(/Signed for/)
  })

  it("lib/tracker-stages.ts has only type imports or imports of import-free modules", () => {
    const src = readFileSync("lib/tracker-stages.ts", "utf8")
    expect(src).not.toMatch(/\brequire\(|\bimport\(/)
    const runtime = (src.match(/^\s*import\b.*$/gm) ?? []).filter((l) => !/^\s*import\s+type\b/.test(l))
    for (const line of runtime) {
      const from = line.match(/from\s+"\.\/([^"]+)"/)
      expect(from, line).not.toBeNull()
      // Each runtime dependency is itself import-free at runtime.
      const dep = readFileSync(`lib/${from![1]}.ts`, "utf8")
      const depRuntime = (dep.match(/^\s*import\b.*$/gm) ?? []).filter(
        (l) => !/^\s*import\s+type\b/.test(l)
      )
      expect(depRuntime, from![1]).toEqual([])
    }
  })
})
