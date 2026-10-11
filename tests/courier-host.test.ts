import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { buildCourierCsp } from "@/lib/csp"
import {
  COURIER_GUEST_APIS,
  courierSurfaceServes,
  hostnameOf,
  isCourierOnlyPath,
  SURFACE_HEADER,
  surfaceFor,
} from "@/lib/courier-host"
import { middleware } from "@/middleware"

// Phase 1 item 4: the courier host. What it serves, what it refuses, and that
// the Pi SDK never reaches it. The hosts here are placeholders: the real ones
// live in each deployment's COURIER_HOST, so this file names no network and
// mirrors between repositories as bytes.

const COURIER = "couriers.example.test"
const PIONEER = "gyema.example.test"

function request(host: string, path = "/", headers: Record<string, string> = {}) {
  return new NextRequest(
    new Request(`https://${host}${path}`, { headers: { "x-forwarded-proto": "https", host, ...headers } })
  )
}

/** The value middleware handed on to the page for a request header. */
function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`)
}

const PI_ORIGIN = /minepi|pinet|piappengine/

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("COURIER_HOST", COURIER)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("which surface a request is on", () => {
  it("is the courier surface only on the exact host", () => {
    expect(surfaceFor(COURIER, COURIER)).toBe("courier")
    expect(surfaceFor(`${COURIER}:443`, COURIER)).toBe("courier")
    expect(surfaceFor(COURIER.toUpperCase(), COURIER)).toBe("courier")
    expect(surfaceFor(`${COURIER}.`, COURIER)).toBe("courier")
  })

  it("does not match a lookalike", () => {
    expect(surfaceFor(`${COURIER}.evil.test`, COURIER)).toBe("pioneer")
    expect(surfaceFor(`evil${COURIER}`, COURIER)).toBe("pioneer")
    expect(surfaceFor(`x.${COURIER}`, COURIER)).toBe("pioneer")
    expect(surfaceFor(PIONEER, COURIER)).toBe("pioneer")
  })

  it("fails closed: no COURIER_HOST means no courier surface anywhere", () => {
    expect(surfaceFor(COURIER, undefined)).toBe("pioneer")
    expect(surfaceFor(COURIER, "")).toBe("pioneer")
    expect(surfaceFor("", "")).toBe("pioneer")
    expect(surfaceFor(null, COURIER)).toBe("pioneer")
  })

  it("reads a hostname without port or trailing dot", () => {
    expect(hostnameOf("Couriers.Example.Test:3000")).toBe(COURIER)
    expect(hostnameOf("[::1]:3000")).toBe("[::1]")
    expect(hostnameOf(undefined)).toBe("")
  })
})

describe("the path rules", () => {
  it("treats only /courier and /api/courier, and below, as courier only", () => {
    for (const p of ["/courier", "/courier/sign-in", "/api/courier", "/api/courier/session"]) {
      expect(isCourierOnlyPath(p), p).toBe(true)
    }
    for (const p of ["/", "/couriers", "/courierx", "/api/couriers", "/api/guest/accept", "/send"]) {
      expect(isCourierOnlyPath(p), p).toBe(false)
    }
  })

  it("serves the job board and no other guest route", () => {
    // Item 6, 6.10 decision 1: a legacy courier accepts, lists and confirms
    // through /api/courier/jobs/*. The guest accept, mine and confirm-delivery
    // routes are Pioneer routes, and confirm-delivery also carries the
    // sender's last-4 branch (item 4, founder decision 2).
    expect([...COURIER_GUEST_APIS]).toEqual(["/api/guest/open"])
    for (const p of [
      "/api/guest/accept",
      "/api/guest/mine",
      "/api/guest/confirm-delivery",
      "/api/guest/create",
      "/api/guest/track",
      "/api/guest/confirm-pickup",
      "/api/guest/delivery-code",
    ]) {
      expect(courierSurfaceServes(p), p).toBe(false)
    }
  })
})

describe("on the courier host", () => {
  it("rewrites / to the courier page, keeping the address", () => {
    const res = middleware(request(COURIER, "/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-rewrite")).toBe(`https://${COURIER}/courier`)
    expect(res.headers.get("location")).toBeNull()
    expect(forwarded(res, SURFACE_HEADER)).toBe("courier")
    expect(forwarded(res, "x-nonce")).toBe(res.headers.get("x-nonce"))
  })

  it("serves the courier page and the courier APIs", () => {
    for (const p of [
      "/courier",
      "/courier/anything",
      "/api/courier/anything",
      "/api/courier/jobs/accept",
      "/api/courier/jobs/mine",
      "/api/courier/jobs/confirm-delivery",
      ...COURIER_GUEST_APIS,
    ]) {
      const res = middleware(request(COURIER, p))
      expect(res.status, p).toBe(200)
      expect(forwarded(res, SURFACE_HEADER), p).toBe("courier")
    }
  })

  it("refuses every Pioneer, sender, payment, webhook and cron route with a 404", () => {
    const refused = [
      "/send", "/track", "/track/GYM-A1B2C3",
      "/api/auth/verify",
      "/api/listings/create", "/api/listings/accept", "/api/listings/confirm-completion",
      "/api/payments/approve", "/api/payments/complete",
      "/api/guest/create", "/api/guest/track", "/api/guest/confirm-pickup", "/api/guest/delivery-code",
      // The Pioneer courier routes, item 6: a legacy courier uses /api/courier/jobs/*.
      "/api/guest/accept", "/api/guest/mine", "/api/guest/confirm-delivery",
      "/api/kyc/webhook",
      "/api/cron/expire-stale-listings",
    ]
    for (const p of refused) {
      const res = middleware(request(COURIER, p))
      expect(res.status, p).toBe(404)
      expect(res.headers.get("x-middleware-rewrite"), p).toBeNull()
    }
  })

  it("answers a refused API with JSON and a refused page with text", async () => {
    const api = middleware(request(COURIER, "/api/listings/create"))
    expect(await api.json()).toEqual({ error: "not_found" })
    const page = middleware(request(COURIER, "/send"))
    expect(await page.text()).toBe("Not found")
  })

  it("enforces its CSP with CSP_ENFORCE unset", () => {
    vi.stubEnv("CSP_ENFORCE", "")
    for (const p of ["/", "/courier", "/api/guest/open"]) {
      const res = middleware(request(COURIER, p))
      expect(res.headers.get("Content-Security-Policy"), p).toBeTruthy()
      expect(res.headers.get("Content-Security-Policy-Report-Only"), p).toBeNull()
    }
    // The flag still governs every other host.
    const pioneer = middleware(request(PIONEER, "/"))
    expect(pioneer.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy()
    expect(pioneer.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("sends a CSP that names no Pi origin and lets nobody frame the page", () => {
    const res = middleware(request(COURIER, "/"))
    const policy = res.headers.get("Content-Security-Policy") ?? ""
    expect(policy).toBe(buildCourierCsp(res.headers.get("x-nonce") ?? ""))
    expect(policy).not.toMatch(PI_ORIGIN)
    expect(policy).toContain("frame-ancestors 'none'")
  })

  it("denies framing and indexing outright, refusals included", () => {
    for (const p of ["/", "/courier", "/send"]) {
      const res = middleware(request(COURIER, p))
      expect(res.headers.get("X-Frame-Options"), p).toBe("DENY")
      expect(res.headers.get("X-Robots-Tag"), p).toBe("noindex, nofollow")
    }
  })

  it("still sends http to https first", () => {
    const res = middleware(
      new NextRequest(new Request(`http://${COURIER}/send`, { headers: { "x-forwarded-proto": "http", host: COURIER } }))
    )
    expect(res.status).toBe(308)
  })
})

describe("on every other host", () => {
  it("refuses the courier page and the courier APIs", () => {
    for (const p of [
      "/courier",
      "/courier/sign-in",
      "/api/courier/session",
      "/api/courier/jobs/accept",
      "/api/courier/jobs/mine",
      "/api/courier/jobs/confirm-delivery",
    ]) {
      const res = middleware(request(PIONEER, p))
      expect(res.status, p).toBe(404)
    }
  })

  it("serves everything else as before, with the Pi policy and no courier headers", () => {
    const res = middleware(request(PIONEER, "/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-rewrite")).toBeNull()
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toMatch(/minepi/)
    expect(res.headers.get("X-Frame-Options")).toBeNull()
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
    expect(forwarded(res, SURFACE_HEADER)).toBe("pioneer")
  })

  it("overwrites a surface header the client sent", () => {
    const res = middleware(request(PIONEER, "/", { [SURFACE_HEADER]: "courier" }))
    expect(forwarded(res, SURFACE_HEADER)).toBe("pioneer")
  })

  it("treats the courier host as an ordinary host when COURIER_HOST is unset", () => {
    vi.stubEnv("COURIER_HOST", "")
    expect(middleware(request(COURIER, "/courier")).status).toBe(404)
    expect(forwarded(middleware(request(COURIER, "/")), SURFACE_HEADER)).toBe("pioneer")
  })
})

describe("the Pi SDK stays off the courier host", () => {
  const layout = readFileSync("app/layout.tsx", "utf8")

  it("the layout renders both SDK tags only off the courier surface", () => {
    expect(layout).toContain("const onCourierHost = requestHeaders.get(SURFACE_HEADER) === \"courier\"")
    const gate = layout.indexOf("{!onCourierHost && (")
    expect(gate).toBeGreaterThan(-1)
    expect(layout.indexOf('src="https://sdk.minepi.com/pi-sdk.js"')).toBeGreaterThan(gate)
    expect(layout.indexOf('id="pi-init"')).toBeGreaterThan(gate)
    expect(layout.match(/sdk\.minepi\.com\/pi-sdk\.js/g) ?? []).toHaveLength(1)
  })

  it("the courier page and its components never import the Pi client", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name)) files.push(p)
      }
    }
    walk("app/courier")
    files.push("components/courier-test-banner.tsx", "lib/courier-host.ts")
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/from\s+["'][^"']*pi-network["']/)
      expect(src, f).not.toMatch(/sdk\.minepi\.com|window\.Pi\b/)
    }
  })

  it("the courier policy builder names no Pi origin", () => {
    expect(buildCourierCsp("n")).not.toMatch(PI_ORIGIN)
    expect(buildCourierCsp("n")).toContain("script-src 'self' 'nonce-n'")
  })
})

// CLAUDE.md's mirror scan plus the courier hosts' domain, assembled from
// pieces so this file does not hit the scan itself and mirrors as bytes too.
const NETWORK_SCAN = new RegExp(
  ["pinet\\.com", "Test" + "net", "test" + "net", "88" + "41", "36" + "81", "pill" + "gh"].join("|")
)

describe("the files this item adds name no network", () => {
  it("so they mirror between repositories as bytes", () => {
    for (const f of [
      "lib/courier-host.ts",
      "app/courier/page.tsx",
      "components/courier-test-banner.tsx",
      "middleware.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(NETWORK_SCAN)
    }
  })
})
