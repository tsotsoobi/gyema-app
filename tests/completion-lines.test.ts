import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import type { Listing } from "@/lib/listings"
import type { GuestJobView } from "@/lib/guest-jobs"
import {
  COMPLETION_THANKS,
  GUEST_LINE_CODE_ONLY,
  GUEST_LINE_DELIVERY,
  GUEST_LINE_PICKUP_AND_DELIVERY,
  GUEST_LINE_SENDER_AND_CODE,
  LINE_MARKED_COMPLETE,
  LISTING_LINE_BOTH,
  completionMessage,
  guestCompletionLine,
  listingCompletionLine,
} from "@/lib/completion-lines"

// The completion line from the stamps on the row (item 8, scope addition A,
// 8.2 and part (c)). lib/completion-lines.ts is pure, so it is tested
// directly, and the static pins check that the three consumers use it.

const PICKED = "2026-10-01T09:00:00Z"

function guest(
  status: GuestJobView["status"],
  deliveryConfirmedBy: string | null | undefined,
  pickupConfirmedAt: string | null
): GuestJobView {
  return {
    kind: "guest",
    trackingId: "GYM-A1B2C3",
    pickupArea: "Osu",
    dropoffArea: "Madina",
    status,
    createdAt: "2026-10-01T00:00:00Z",
    pickupConfirmedAt,
    deliveryConfirmedAt: deliveryConfirmedBy ? "2026-10-01T12:00:00Z" : null,
    deliveryConfirmedBy,
    hasDeliveryCode: deliveryConfirmedBy === "sender+courier_code" || deliveryConfirmedBy === "courier_code",
  }
}

function listing(senderConfirmed?: boolean, travellerConfirmed?: boolean, kind: "trip" | "package" = "package"): Listing {
  return {
    kind,
    status: "completed",
    trackingId: "GYM-D4E5F6",
    postedByUsername: "poster_fixture",
    matchedWithUsername: "matched_fixture",
    fromCity: "Osu",
    toCity: "Madina",
    createdAt: "2026-10-01T00:00:00Z",
    senderConfirmed,
    travellerConfirmed,
  } as unknown as Listing
}

// Any wording that claims who confirmed.
const WHO_CLAIM = /you confirmed|courier entered|both|sender|traveller/i

describe("the guest line, every row of 8.2's table", () => {
  it("sender+courier_code: you confirmed, and the courier entered the code", () => {
    expect(guestCompletionLine(guest("delivered", "sender+courier_code", PICKED))).toBe(GUEST_LINE_SENDER_AND_CODE)
    expect(GUEST_LINE_SENDER_AND_CODE).toBe(
      "You confirmed this delivery and the courier entered your delivery code at handover."
    )
  })

  it("sender, and pickup confirmed: you confirmed pickup and delivery", () => {
    expect(guestCompletionLine(guest("delivered", "sender", PICKED))).toBe(GUEST_LINE_PICKUP_AND_DELIVERY)
    expect(GUEST_LINE_PICKUP_AND_DELIVERY).toBe("You confirmed pickup and delivery.")
  })

  it("sender, pickup not confirmed: you confirmed delivery, nothing about pickup", () => {
    const line = guestCompletionLine(guest("delivered", "sender", null))
    expect(line).toBe(GUEST_LINE_DELIVERY)
    expect(GUEST_LINE_DELIVERY).toBe("You confirmed delivery.")
    expect(line).not.toMatch(/pickup/i)
  })

  it("courier_code only: the courier entered the code, nothing about the sender", () => {
    const line = guestCompletionLine(guest("delivered", "courier_code", PICKED))
    expect(line).toBe(GUEST_LINE_CODE_ONLY)
    expect(GUEST_LINE_CODE_ONLY).toBe("The courier entered your delivery code at handover.")
    expect(line).not.toMatch(/you confirmed/i)
  })

  it("no stamps: marked complete, nothing about who confirmed", () => {
    for (const by of [null, undefined]) {
      for (const pickup of [PICKED, null]) {
        const line = guestCompletionLine(guest("delivered", by, pickup))
        expect(line).toBe(LINE_MARKED_COMPLETE)
        expect(line).not.toMatch(WHO_CLAIM)
      }
    }
    expect(LINE_MARKED_COMPLETE).toBe("This delivery is marked complete.")
  })

  it("an unknown stamp value makes no claim either", () => {
    for (const by of ["", "operator", "SENDER", "sender+"]) {
      expect(guestCompletionLine(guest("delivered", by, PICKED)), by).toBe(LINE_MARKED_COMPLETE)
    }
  })

  it("the pickup half reads pickupConfirmedAt only (8.10 decision 4)", () => {
    expect(guestCompletionLine({ deliveryConfirmedBy: "sender", pickupConfirmedAt: PICKED })).toBe(
      GUEST_LINE_PICKUP_AND_DELIVERY
    )
    expect(guestCompletionLine({ deliveryConfirmedBy: "sender", pickupConfirmedAt: null })).toBe(GUEST_LINE_DELIVERY)
  })
})

describe("the listing line, every row of 8.2's table", () => {
  it("both flags: both sender and traveller confirmed", () => {
    expect(listingCompletionLine(listing(true, true))).toBe(LISTING_LINE_BOTH)
    expect(LISTING_LINE_BOTH).toBe("Both sender and traveller confirmed this delivery as done.")
  })

  it('a completed listing with one flag, or neither, never says "Both"', () => {
    for (const [s, t] of [
      [true, false],
      [false, true],
      [true, undefined],
      [undefined, true],
      [false, false],
      [undefined, undefined],
    ] as const) {
      const line = listingCompletionLine(listing(s, t))
      expect(line, `${s} ${t}`).toBe(LINE_MARKED_COMPLETE)
      expect(line).not.toMatch(/both/i)
    }
  })
})

describe("completionMessage", () => {
  it("adds the second sentence, unchanged", () => {
    expect(COMPLETION_THANKS).toBe("Thanks for using Gyema.")
    expect(completionMessage(listing(true, true))).toBe(`${LISTING_LINE_BOTH} ${COMPLETION_THANKS}`)
    expect(completionMessage(guest("delivered", "sender", PICKED))).toBe(
      `${GUEST_LINE_PICKUP_AND_DELIVERY} ${COMPLETION_THANKS}`
    )
  })

  it("never gives a guest result the listing line, whatever its stamps", () => {
    for (const by of ["sender+courier_code", "sender", "courier_code", null, undefined, "other"]) {
      for (const pickup of [PICKED, null]) {
        const j = guest("delivered", by, pickup)
        const msg = completionMessage(j)
        // Exactly the guest line for these stamps, so a guest routed through
        // the listing rule fails here even where both rules say "marked complete".
        expect(msg, `${by} ${pickup}`).toBe(`${guestCompletionLine(j)} ${COMPLETION_THANKS}`)
        expect(msg).not.toContain(LISTING_LINE_BOTH)
        expect(msg).not.toMatch(/traveller/i)
      }
    }
  })

  it("never gives a listing the guest lines", () => {
    for (const kind of ["trip", "package"] as const) {
      for (const [s, t] of [[true, true], [true, false], [false, false]] as const) {
        const msg = completionMessage(listing(s, t, kind))
        for (const g of [GUEST_LINE_SENDER_AND_CODE, GUEST_LINE_PICKUP_AND_DELIVERY, GUEST_LINE_DELIVERY, GUEST_LINE_CODE_ONLY]) {
          expect(msg).not.toContain(g)
        }
      }
    }
  })
})

describe("static pins", () => {
  const CONSUMERS = [
    "components/track-view.tsx",
    "components/track-tab.tsx",
    "components/listing-detail-sheet.tsx",
  ]
  const LINES = [
    "confirmed this delivery and the courier entered",
    "You confirmed pickup and delivery",
    "You confirmed delivery.",
    "Both sender and traveller confirmed",
    "marked complete",
  ]
  // The code-only sentence also opens track-view's in-transit prompt
  // ("... at handover. Confirm with the last 4 digits ...", 8.2, unchanged).
  // As a completion line it stands alone or is followed by the thanks.
  const CODE_ONLY_AS_COMPLETION = /The courier entered your delivery code at handover\.(\s*Thanks|\s*["'`<{])/

  it("the three consumers import the module and render completionMessage", () => {
    for (const f of CONSUMERS) {
      const src = readFileSync(f, "utf8")
      expect(src, f).toMatch(/import\s*\{\s*completionMessage\s*\}\s*from\s*"@\/lib\/completion-lines"/)
      expect(src, f).toMatch(/\{completionMessage\((result|listing)\)\}/)
    }
  })

  it("the three consumers hold no completion line of their own", () => {
    for (const f of CONSUMERS) {
      const src = readFileSync(f, "utf8")
      for (const line of LINES) expect(src, `${f}: ${line}`).not.toContain(line)
      expect(src, f).not.toMatch(CODE_ONLY_AS_COMPLETION)
    }
  })

  it('"Thanks for using Gyema." lives in the module; track-view keeps it only on its sign-off card (8.2, 8.17 D1)', () => {
    expect(readFileSync("components/track-tab.tsx", "utf8")).not.toMatch(/Thanks for using Gyema/)
    expect(readFileSync("components/listing-detail-sheet.tsx", "utf8")).not.toMatch(/Thanks for using Gyema/)
    const tv = readFileSync("components/track-view.tsx", "utf8")
    expect(tv.match(/Thanks for using Gyema/g) ?? []).toHaveLength(1)
    expect(tv).toMatch(/"You signed off on this delivery\. Thanks for using Gyema\."/)
  })

  it("track-tab.tsx picks no line by itself: no listing line or listing function", () => {
    const src = readFileSync("components/track-tab.tsx", "utf8")
    expect(src).not.toMatch(/listingCompletionLine|LISTING_LINE_BOTH|guestCompletionLine/)
  })

  it("lib/completion-lines.ts has only type imports or imports of import-free modules", () => {
    const src = readFileSync("lib/completion-lines.ts", "utf8")
    expect(src).not.toMatch(/\brequire\(|\bimport\(/)
    const runtime = (src.match(/^\s*import\b.*$/gm) ?? []).filter((l) => !/^\s*import\s+type\b/.test(l))
    for (const line of runtime) {
      const from = line.match(/from\s+"\.\/([^"]+)"/)
      expect(from, line).not.toBeNull()
      const dep = readFileSync(`lib/${from![1]}.ts`, "utf8")
      const depRuntime = (dep.match(/^\s*import\b.*$/gm) ?? []).filter((l) => !/^\s*import\s+type\b/.test(l))
      expect(depRuntime, from![1]).toEqual([])
    }
  })
})
