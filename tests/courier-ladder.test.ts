import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { BUFFER_WINDOW_DAYS, bufferJobGuards, effectiveTier } from "@/lib/courier-ladder"
import { BUFFER_VALUE_CAP_CEDIS, DECLARED_VALUE_CAP_CEDIS } from "@/lib/declared-value"
import { GUEST_AREA_NAMES } from "@/lib/guest-pricing"

// Item 6, section 6.4: the ladder, row for row.

const NOW = Date.parse("2026-10-10T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("effectiveTier", () => {
  it("no row: none, courier_not_registered", () => {
    expect(effectiveTier(null, NOW)).toEqual({ tier: "none", reason: "courier_not_registered" })
  })

  it("a shredded row: none, unavailable, whatever its status", () => {
    for (const status of ["full", "buffer", "registered"]) {
      expect(effectiveTier({ status, buffer_since: ago(DAY), shredded_at: ago(0) }, NOW)).toEqual({
        tier: "none",
        reason: "unavailable",
      })
    }
  })

  it("registered and paused: none, courier_not_active", () => {
    for (const status of ["registered", "paused"]) {
      expect(effectiveTier({ status, buffer_since: null }, NOW)).toEqual({ tier: "none", reason: "courier_not_active" })
    }
  })

  it("buffer with buffer_since null fails closed", () => {
    expect(effectiveTier({ status: "buffer", buffer_since: null }, NOW)).toEqual({
      tier: "none",
      reason: "courier_not_active",
    })
  })

  it("buffer with a buffer_since that does not parse fails closed", () => {
    expect(effectiveTier({ status: "buffer", buffer_since: "not a time" }, NOW)).toEqual({
      tier: "none",
      reason: "courier_not_active",
    })
  })

  it("buffer inside 30 days is buffer, up to the last millisecond", () => {
    expect(BUFFER_WINDOW_DAYS).toBe(30)
    expect(effectiveTier({ status: "buffer", buffer_since: ago(0) }, NOW)).toEqual({ tier: "buffer" })
    expect(effectiveTier({ status: "buffer", buffer_since: ago(29 * DAY) }, NOW)).toEqual({ tier: "buffer" })
    expect(effectiveTier({ status: "buffer", buffer_since: ago(30 * DAY - 1) }, NOW)).toEqual({ tier: "buffer" })
  })

  it("buffer at or past 30 days is none, computed on read", () => {
    for (const ms of [30 * DAY, 30 * DAY + 1, 365 * DAY]) {
      expect(effectiveTier({ status: "buffer", buffer_since: ago(ms) }, NOW)).toEqual({
        tier: "none",
        reason: "courier_not_active",
      })
    }
  })

  it("full is full, whatever the timestamps", () => {
    expect(effectiveTier({ status: "full", buffer_since: null }, NOW)).toEqual({ tier: "full" })
    expect(effectiveTier({ status: "full", buffer_since: ago(400 * DAY) }, NOW)).toEqual({ tier: "full" })
    expect(effectiveTier({ status: "full", buffer_since: null, shredded_at: null }, NOW)).toEqual({ tier: "full" })
  })

  it("any other status, case variants included, is none", () => {
    for (const status of ["", "Full", "FULL", "gold", "buffer ", "active"]) {
      expect(effectiveTier({ status, buffer_since: ago(DAY) }, NOW), status).toEqual({
        tier: "none",
        reason: "courier_not_active",
      })
    }
  })
})

describe("bufferJobGuards", () => {
  function recorder() {
    const calls: Array<[string, unknown[]]> = []
    const q = {
      in(column: string, values: readonly string[]) {
        calls.push(["in", [column, values]])
        return q
      },
      lte(column: string, value: number) {
        calls.push(["lte", [column, value]])
        return q
      },
    }
    return { q, calls }
  }

  it("adds both bounded area guards and the GHS 200 value guard, and nothing else", () => {
    const { q, calls } = recorder()
    expect(bufferJobGuards(q)).toBe(q)
    expect(calls).toEqual([
      ["in", ["pickup_area", GUEST_AREA_NAMES]],
      ["in", ["dropoff_area", GUEST_AREA_NAMES]],
      ["lte", ["declared_value_cedis", 200]],
    ])
  })

  it("the buffer cap is GHS 200, inside the pilot cap", () => {
    expect(BUFFER_VALUE_CAP_CEDIS).toBe(200)
    expect(BUFFER_VALUE_CAP_CEDIS).toBeLessThanOrEqual(DECLARED_VALUE_CAP_CEDIS)
    expect(Number.isInteger(BUFFER_VALUE_CAP_CEDIS)).toBe(true)
  })

  it("writes the value guard as the literal filter call the exposure test allows", () => {
    // 7.8: a guard written as data, the column name in a constant or an
    // object, fails tests/declared-value-exposure.test.ts.
    const source = readFileSync("lib/courier-ladder.ts", "utf8")
    expect(source).toContain('.lte("declared_value_cedis", BUFFER_VALUE_CAP_CEDIS)')
  })
})

describe("the shared modules import no identity resolver (6.2)", () => {
  for (const file of ["lib/courier-ladder.ts", "lib/guest-claim.ts"]) {
    it(file, () => {
      const imports = readFileSync(file, "utf8").match(/from\s+["'][^"']+["']/g) ?? []
      expect(imports.join(" "), file).not.toMatch(/route-auth|courier-auth|supabase-admin|next\/server/)
    })
  }
})
