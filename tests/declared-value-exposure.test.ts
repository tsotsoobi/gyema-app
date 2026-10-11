import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Item 7, founder decision 6: the declared value of a guest parcel is NEVER
// returned to any courier. A visible parcel value is a theft incentive. It is
// used server side only, and shown to the sender on their own form and to the
// operator.
//
// A static scan with an ALLOWLIST rather than a list of routes to check, so a
// route or module added later (item 6's /api/courier/jobs/* and
// lib/guest-claim.ts) is covered the day it appears, without anyone
// remembering to add it here.

/** The only files that may name the declared value at all. */
const ALLOWED = new Set([
  "app/api/guest/create/route.ts", // writes it
  "app/send/page.tsx", // the sender's own form
  "lib/schemas.ts", // GuestCreateBody
  "lib/declared-value.ts", // the cap
])

/** Every guest job route a courier, or anyone holding a tracking id, can reach. */
const COURIER_REACHABLE = [
  "app/api/guest/accept/route.ts",
  "app/api/guest/mine/route.ts",
  "app/api/guest/open/route.ts",
  "app/api/guest/track/route.ts",
  "app/api/guest/confirm-pickup/route.ts",
  "app/api/guest/confirm-delivery/route.ts",
  "app/api/guest/delivery-code/route.ts",
  "app/api/courier/jobs/accept/route.ts",
  "app/api/courier/jobs/mine/route.ts",
  "app/api/courier/jobs/confirm-delivery/route.ts",
]

const NAMES = /declared_?value/i

/** A select string containing a star anywhere: "*", "*, remit_cedis", "id, x(*)". */
const STAR_SELECT = /\.select\(\s*["'`][^"'`]*\*/

/**
 * The one form allowed outside the allowlist: a filter, which compares in the
 * database and returns nothing (item 6's buffer guard,
 * .lte("declared_value_cedis", 200)). Stripped before the scan. Anything else,
 * a select string, a column array, a row type or a mapper, is left in and
 * fails.
 */
function stripFilters(source: string): string {
  return source.replace(/\.(?:lte|lt|gte|gt)\(\s*["'`]declared_value_cedis["'`]\s*,/g, ".FILTER(")
}

/** Block and line comments removed. Rough, and only used for the select rule. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "")
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return files(full)
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry) ? [full.replace(/\\/g, "/")] : []
  })
}

const scanned = ["app", "lib", "components"].flatMap(files)

describe("the declared value never reaches a courier", () => {
  it("scans the whole app, so a new file cannot slip past", () => {
    expect(scanned.length).toBeGreaterThan(50)
    for (const file of [...ALLOWED, ...COURIER_REACHABLE]) {
      expect(existsSync(file), `${file} moved: update this test`).toBe(true)
    }
    expect(scanned).toContain("app/api/courier/me/route.ts")
  })

  it("is named only in the allowlisted files", () => {
    const offenders = scanned.filter(
      (file) => !ALLOWED.has(file) && NAMES.test(stripFilters(readFileSync(file, "utf8")))
    )
    expect(offenders).toEqual([])
  })

  it("is not read back by the create route either", () => {
    // The insert used to read the whole row back with a bare select().
    const source = readFileSync("app/api/guest/create/route.ts", "utf8")
    expect(source).toContain('.select("tracking_id, status")')
    expect(source).not.toMatch(/\.select\(\s*\)/)
  })

  it("is never fetched without being named: no bare or star select on guest_jobs outside create", () => {
    // A select() with no argument, or "*", returns every column, this one
    // included, without the allowlist ever seeing its name.
    const readers = scanned.filter(
      (file) =>
        file !== "app/api/guest/create/route.ts" &&
        /from\(\s*["'`]guest_jobs["'`]\s*\)/.test(readFileSync(file, "utf8"))
    )
    // Item 6 moved the accept and mine reads into lib/guest-claim.ts, shared
    // with the courier host's routes. A route that reads guest_jobs through it
    // is covered by the rule below through that file, which must itself be a
    // reader.
    expect(readers).toContain("lib/guest-claim.ts")
    for (const file of COURIER_REACHABLE) {
      const viaClaim = /from\s+["']@\/lib\/guest-claim["']/.test(readFileSync(file, "utf8"))
      expect(readers.includes(file) || viaClaim, `${file} reads guest_jobs neither itself nor through lib/guest-claim`).toBe(true)
    }
    for (const file of readers) {
      // Code only: app/api/guest/mine explains in a comment why it never
      // passes a joined constant to .select().
      const source = withoutComments(readFileSync(file, "utf8"))
      expect(source, `${file}: bare select()`).not.toMatch(/\.select\(\s*\)/)
      // Any star in the select string, so "*, courier_registry(*)" is caught too.
      expect(source, `${file}: select with *`).not.toMatch(STAR_SELECT)
    }
  })

  it("covers every courier route, present and future", () => {
    const courierRoutes = scanned.filter((f) => f.startsWith("app/api/courier/"))
    expect(courierRoutes.length).toBeGreaterThan(0)
    for (const file of courierRoutes) {
      expect(ALLOWED.has(file)).toBe(false)
      expect(NAMES.test(stripFilters(readFileSync(file, "utf8"))), file).toBe(false)
    }
  })

  it("strips only the filter form", () => {
    // The scan's one exception, tested on its own so it cannot widen quietly.
    expect(NAMES.test(stripFilters('.lte("declared_value_cedis", 200)'))).toBe(false)
    expect(NAMES.test(stripFilters('.select("tracking_id, declared_value_cedis")'))).toBe(true)
    expect(NAMES.test(stripFilters('const COLS = ["tracking_id", "declared_value_cedis"]'))).toBe(true)
    expect(NAMES.test(stripFilters("declaredValueCedis: j.declared_value_cedis"))).toBe(true)
    expect(NAMES.test(stripFilters('.eq("declared_value_cedis", 200)'))).toBe(true)
  })

  it("catches every star select form", () => {
    for (const s of ['.select("*")', '.select("*, remit_cedis")', '.select("id, courier_registry(*)")', ".select( '*' )"]) {
      expect(s, s).toMatch(STAR_SELECT)
    }
    expect('.select("tracking_id, status")').not.toMatch(STAR_SELECT)
  })
})
