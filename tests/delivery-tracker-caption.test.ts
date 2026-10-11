import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  GUEST_ACCEPTED_CAPTION,
  GUEST_CARRYING_CAPTION,
  guestAcceptedCaption,
} from "@/lib/guest-tracker-caption"

// The guest tracker's Accepted caption (item 8, 8.1 and 8.2). /api/guest/track
// emits courierAssigned and no courier identity, and the caption is chosen
// from it alone. The repository has no component renderer and the test runner
// does not load .tsx, so the choice is the pure module
// lib/guest-tracker-caption.ts tested here, and the static checks below pin
// that the tracker uses it.

// Any caption that says or implies someone is carrying the package.
const CARRIER_CLAIM = /carrying|courier|pioneer|@/i

describe("guestAcceptedCaption", () => {
  for (const status of ["accepted", "in_transit", "delivered"] as const) {
    it(`gives the carrying caption on ${status} with courierAssigned true`, () => {
      expect(guestAcceptedCaption({ status, courierAssigned: true })).toBe(GUEST_CARRYING_CAPTION)
    })

    it(`makes no carrier claim on ${status} with courierAssigned false`, () => {
      const caption = guestAcceptedCaption({ status, courierAssigned: false })
      expect(caption).toBe(GUEST_ACCEPTED_CAPTION)
      expect(caption).not.toMatch(CARRIER_CLAIM)
    })

    it(`makes no carrier claim on ${status} with courierAssigned absent (a cached payload)`, () => {
      const caption = guestAcceptedCaption({ status })
      expect(caption).toBe(GUEST_ACCEPTED_CAPTION)
      expect(caption).not.toMatch(CARRIER_CLAIM)
    })
  }

  it("keeps the cancelled and waiting captions", () => {
    expect(guestAcceptedCaption({ status: "cancelled", courierAssigned: true })).toBe("Cancelled")
    // Part (b): expired is told apart from cancelled (8.3).
    expect(guestAcceptedCaption({ status: "expired" })).toBe("Expired")
    expect(guestAcceptedCaption({ status: "posted", courierAssigned: false })).toBe(
      "Waiting for a courier"
    )
  })

  it("the captions are the approved strings (8.17)", () => {
    expect(GUEST_CARRYING_CAPTION).toBe("A courier took this job")
    expect(GUEST_ACCEPTED_CAPTION).toBe("Accepted")
  })
})

describe("static pins", () => {
  it("delivery-tracker.tsx says no Pioneer and reads no assignedCourier", () => {
    const src = readFileSync("components/delivery-tracker.tsx", "utf8")
    expect(src).not.toMatch(/Pioneer/)
    expect(src).not.toMatch(/assignedCourier/)
  })

  // Retargeted in part (d): the stage derivation moved to lib/tracker-stages.ts,
  // so the guarantee is a chain. The stages call guestAcceptedCaption, and the
  // tracker renders the stages.
  it("the guest Accepted caption comes from guestAcceptedCaption, via lib/tracker-stages.ts", () => {
    const stages = readFileSync("lib/tracker-stages.ts", "utf8")
    expect(stages).toMatch(/caption:\s*guestAcceptedCaption\(j\)/)
    // The listing rail keeps its own "@... is carrying it"; only the guest
    // string must not be hard-coded in the tracker.
    const src = readFileSync("components/delivery-tracker.tsx", "utf8")
    expect(src).not.toMatch(/A courier took this job/)
  })

  it("lib/tracker-stages.ts imports the caption from ./guest-tracker-caption, and the tracker imports the stages", () => {
    const stages = readFileSync("lib/tracker-stages.ts", "utf8")
    expect(stages).toMatch(/import\s*\{\s*guestAcceptedCaption\s*\}\s*from\s*"\.\/guest-tracker-caption"/)
    const src = readFileSync("components/delivery-tracker.tsx", "utf8")
    expect(src).toMatch(/import\s*\{[^}]*\bderiveGuestStages\b[^}]*\}\s*from\s*"@\/lib\/tracker-stages"/)
  })

  it("lib/guest-tracker-caption.ts has no runtime import", () => {
    const src = readFileSync("lib/guest-tracker-caption.ts", "utf8")
    const imports = src.match(/^\s*import\b.*$/gm) ?? []
    for (const line of imports) expect(line).toMatch(/^\s*import\s+type\b/)
    expect(src).not.toMatch(/\brequire\(|\bimport\(/)
  })

  it("lib/guest-jobs.ts declares no assignedCourier", () => {
    const src = readFileSync("lib/guest-jobs.ts", "utf8")
    expect(src).not.toMatch(/assignedCourier/)
    // One home for the caption: not redefined beside the fetch wrappers.
    expect(src).not.toMatch(/guestAcceptedCaption|GUEST_CARRYING_CAPTION|GUEST_ACCEPTED_CAPTION/)
  })
})
