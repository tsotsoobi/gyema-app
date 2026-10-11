import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { GUEST_AREA_NAMES } from "@/lib/guest-pricing"
import { bufferWindowLapsed, canTakeJobs, visibleBoard } from "@/app/courier/courier-view"

// What the courier page shows (app/courier/courier-view.ts), decided from
// GET /api/courier/me's effectiveTier and never from the stored status (item 6
// review, after c1b0868). The repository has no component renderer, so the
// decisions live in a pure module tested here, and the static checks below
// pin that the panel and the job list use it.

const LISTED = GUEST_AREA_NAMES[0]
const ALSO_LISTED = GUEST_AREA_NAMES[1]

function job(trackingId: string, pickupArea: string, dropoffArea: string) {
  return { trackingId, pickupArea, dropoffArea }
}

describe("canTakeJobs", () => {
  it("offers jobs on an active tier only", () => {
    expect(canTakeJobs("full")).toBe(true)
    expect(canTakeJobs("buffer")).toBe(true)
    expect(canTakeJobs("none")).toBe(false)
  })
})

describe("bufferWindowLapsed", () => {
  it("is true only for status buffer with a tier the ladder has stopped", () => {
    expect(bufferWindowLapsed("buffer", "none")).toBe(true)
    expect(bufferWindowLapsed("buffer", "buffer")).toBe(false)
    expect(bufferWindowLapsed("full", "full")).toBe(false)
    expect(bufferWindowLapsed("registered", "none")).toBe(false)
    expect(bufferWindowLapsed("paused", "none")).toBe(false)
  })
})

describe("visibleBoard", () => {
  const board = [
    job("GYM-000001", LISTED, ALSO_LISTED),
    job("GYM-000002", "Somewhere off the list", ALSO_LISTED),
    job("GYM-000003", LISTED, "Somewhere off the list"),
    job("GYM-000004", `${LISTED} `, ALSO_LISTED),
    job("GYM-000005", LISTED.toLowerCase(), ALSO_LISTED),
  ]

  it("shows a buffer courier only jobs with both areas on GUEST_AREA_NAMES, exact match", () => {
    expect(visibleBoard(board, "buffer").map((j) => j.trackingId)).toEqual(["GYM-000001"])
  })

  it("shows a full courier every job", () => {
    expect(visibleBoard(board, "full")).toEqual(board)
  })

  it("reads nothing about the declared value", () => {
    const src = readFileSync("app/courier/courier-view.ts", "utf8")
    expect(src).toContain('from "@/lib/guest-pricing"')
    expect(src).not.toMatch(/declared_value_cedis|declaredValue|BUFFER_VALUE_CAP/)
  })
})

describe("the panel and the job list decide from effectiveTier, never from status", () => {
  const panel = readFileSync("app/courier/courier-panel.tsx", "utf8")
  const jobs = readFileSync("app/courier/courier-jobs.tsx", "utf8")

  it("the panel hands the job list the tier, and shows the lapsed line from bufferWindowLapsed", () => {
    expect(panel).toContain("<CourierJobs effectiveTier={courier.effectiveTier}")
    expect(panel).toContain("bufferWindowLapsed(courier.status, courier.effectiveTier) && (")
    expect(panel).toContain("Your verification has taken longer than 30 days. Jobs are paused until it completes.")
  })

  it("the job list offers and filters the board through courier-view", () => {
    expect(jobs).toContain("const offerJobs = canTakeJobs(effectiveTier)")
    expect(jobs).toContain("visibleBoard(board, effectiveTier)")
  })

  it("neither file compares a stored status with buffer or full", () => {
    for (const [name, src] of [["panel", panel], ["jobs", jobs]] as const) {
      expect(src, name).not.toMatch(/status\s*===\s*["'](buffer|full)["']/)
      expect(src, name).not.toMatch(/["'](buffer|full)["']\s*===\s*[\w.]*status/)
    }
  })
})
