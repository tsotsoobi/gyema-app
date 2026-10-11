import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { AdminMock, adminModule } from "../helpers/admin-mock"

// Two identity types, and neither resolver accepts the other's credential
// (Phase 1 item 5, docs/anchoring-phase1-notes.md 5.3).
//
//   pioneer  resolveCaller: accessToken from the JSON body, asked of GoTrue
//   courier  resolveCourier: the host-only session cookie, on the courier
//            surface, looked up by hash
//
// "Every Pioneer route" is a LIST, not a complement. ROUTES below classifies
// every route.ts under app/api, and a route missing from it fails the first
// test, so a new route has to be placed in a class before anything passes.
//
//   pioneer  acts for a Pioneer resolved by resolveCaller
//   courier  acts for a courier resolved from the session cookie, or ends one
//   public   no session at all: Pi sign-in, and the guest sender routes
//   server   server to server: an HMAC or a cron secret
//
// The proof is the absence of any courier lookup or write, not the status code
// alone. The admin mock holds a live courier session for the token throughout,
// so a Pioneer route that consulted it would find a courier.

const mock = new AdminMock()
const clients: ReturnType<AdminMock["client"]>[] = []
vi.mock("@/lib/supabase-admin", () => ({
  ...adminModule(mock),
  createAdminClient: () => {
    const c = mock.client()
    clients.push(c)
    return c
  },
}))

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => p,
  ipAddress: () => undefined,
}))

type Klass = "pioneer" | "courier" | "public" | "server"

const ROUTES: Record<string, Klass> = {
  "app/api/auth/verify/route.ts": "public",
  "app/api/courier/jobs/accept/route.ts": "courier",
  "app/api/courier/jobs/confirm-delivery/route.ts": "courier",
  "app/api/courier/jobs/mine/route.ts": "courier",
  "app/api/courier/kyc/refresh/route.ts": "courier",
  "app/api/courier/kyc/start/route.ts": "courier",
  "app/api/courier/me/route.ts": "courier",
  "app/api/courier/sign-in/route.ts": "courier",
  "app/api/courier/sign-out/route.ts": "courier",
  "app/api/cron/expire-stale-listings/route.ts": "server",
  "app/api/guest/accept/route.ts": "pioneer",
  "app/api/guest/confirm-delivery/route.ts": "pioneer",
  "app/api/guest/confirm-pickup/route.ts": "public",
  "app/api/guest/create/route.ts": "public",
  "app/api/guest/delivery-code/route.ts": "public",
  "app/api/guest/mine/route.ts": "pioneer",
  "app/api/guest/open/route.ts": "public",
  "app/api/guest/track/route.ts": "public",
  "app/api/kyc/webhook/route.ts": "server",
  "app/api/listings/accept/route.ts": "pioneer",
  "app/api/listings/cancel-matched/route.ts": "pioneer",
  "app/api/listings/cancel-open/route.ts": "pioneer",
  "app/api/listings/confirm-completion/route.ts": "pioneer",
  "app/api/listings/create/route.ts": "pioneer",
  "app/api/listings/mark-in-transit/route.ts": "pioneer",
  "app/api/listings/release/route.ts": "pioneer",
  "app/api/payments/approve/route.ts": "pioneer",
  "app/api/payments/complete/route.ts": "pioneer",
}

const HOST = "couriers.example.test"
const COURIER_TOKEN = "gcs_" + "B".repeat(43)
const COURIER_COOKIE = `__Host-gyema_courier=${COURIER_TOKEN}`
const PIONEER_TOKEN = "pioneer-session-token-placeholder"
const JOB = "GYM-A1B2C3"

const LIVE_COURIER = {
  courier_id: "0f1e2d3c-4b5a-4968-8776-655443322110",
  status: "registered",
  piverify_status: null,
  piverify_allowed_action: null,
  kyc_approved_at: null,
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return routeFiles(full)
    return entry === "route.ts" ? [full.replace(/\\/g, "/")] : []
  })
}

function ofClass(k: Klass): string[] {
  return Object.entries(ROUTES)
    .filter(([, v]) => v === k)
    .map(([f]) => f)
}

/** A body that passes each Pioneer route's schema, so the request reaches resolveCaller. */
function pioneerBody(file: string, token: string): Record<string, unknown> {
  switch (file) {
    case "app/api/listings/create/route.ts":
      return {
        accessToken: token,
        kind: "trip",
        fromCity: "Accra",
        toCity: "Kumasi",
        whatsapp: "0244123456",
        travelDate: "2026-12-01",
        capacity: "small",
        pricePi: 1,
      }
    case "app/api/payments/approve/route.ts":
      return { accessToken: token, paymentId: "pay_1" }
    case "app/api/payments/complete/route.ts":
      return { accessToken: token, paymentId: "pay_1", txid: "a".repeat(64) }
    case "app/api/guest/accept/route.ts":
      return { accessToken: token, trackingId: JOB }
    case "app/api/guest/mine/route.ts":
      return { accessToken: token }
    case "app/api/guest/confirm-delivery/route.ts":
      return { accessToken: token, trackingId: JOB, via: "courier_code", code: "1234" }
    default:
      return { accessToken: token, listingId: "listing_1_abcdef" }
  }
}

function courierRequest(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const method = init.method ?? "POST"
  return new Request(`https://${HOST}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: `https://${HOST}`, ...init.headers },
    body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
  })
}

function rpcs() {
  return mock.calls.filter((c) => c.method === "rpc")
}

function writes() {
  return mock.calls.filter((c) => ["insert", "update", "delete", "upsert"].includes(c.method))
}

function getUserCalls(): unknown[][] {
  return clients.flatMap((c) => (c.auth.getUser as unknown as { mock: { calls: unknown[][] } }).mock.calls)
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  clients.length = 0
  vi.stubEnv("COURIER_HOST", HOST)
  vi.stubEnv("PI_API_KEY", "test-pi-api-key")
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("the classification table", () => {
  it("lists every route.ts under app/api, and nothing that is not one", () => {
    expect(routeFiles("app/api").sort()).toEqual(Object.keys(ROUTES).sort())
  })

  it("has twelve Pioneer routes, every one of which calls resolveCaller", () => {
    const pioneer = ofClass("pioneer")
    expect(pioneer).toHaveLength(12)
    for (const f of pioneer) {
      expect(readFileSync(f, "utf8"), f).toContain("resolveCaller(")
    }
  })

  it("has no route outside the Pioneer class calling resolveCaller", () => {
    for (const f of Object.keys(ROUTES).filter((f) => ROUTES[f] !== "pioneer")) {
      expect(readFileSync(f, "utf8"), f).not.toContain("resolveCaller")
    }
  })

  it("puts every route under app/api/courier, and only those, in the courier class", () => {
    for (const [f, k] of Object.entries(ROUTES)) {
      expect(k === "courier", f).toBe(f.startsWith("app/api/courier/"))
    }
  })
})

describe("a courier credential reaches no Pioneer route", () => {
  for (const file of ofClass("pioneer")) {
    it(`${file} answers 401 to the courier token as cookie, body token and Bearer, with no courier lookup`, async () => {
      // GoTrue's answer to a token that is not a JWT.
      mock.asAnonymousFailure()
      // Held throughout: a route that consulted the session table would find a courier.
      mock.queueRpc({ data: [LIVE_COURIER], error: null })
      if (file === "app/api/guest/confirm-delivery/route.ts") {
        // Its courier branch asks who the caller is before it reads the job
        // (item 6 part (c)). A coded job is queued all the same, so a route
        // that read first would still carry the request to resolveCaller.
        mock.queue({
          data: {
            tracking_id: JOB,
            status: "in_transit",
            sender_phone: "0244123456",
            assigned_courier: "real_courier",
            delivery_confirmed_at: null,
            delivery_confirmed_by: null,
            delivery_code_hash: "a".repeat(64),
            delivery_code_attempts: 0,
            last4_attempts: 0,
          },
          error: null,
        })
      }

      const route = await import(/* @vite-ignore */ `@/${file.replace(/\.ts$/, "")}`)
      const res = await route.POST(
        courierRequest("/api/x", {
          body: pioneerBody(file, COURIER_TOKEN),
          headers: {
            cookie: COURIER_COOKIE,
            authorization: `Bearer ${COURIER_TOKEN}`,
            "x-gyema-surface": "courier",
          },
        })
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" })
      // It went to GoTrue with the body token, which refused it...
      expect(getUserCalls()).toEqual([[COURIER_TOKEN]])
      // ...and nothing else happened: no courier lookup, no RPC, no write.
      expect(rpcs()).toEqual([])
      expect(writes()).toEqual([])
    })
  }
})

describe("a Pioneer credential reaches no courier route", () => {
  const pioneerHeaders = { authorization: `Bearer ${PIONEER_TOKEN}`, "x-gyema-surface": "courier" }

  it("me answers 401 to a Pioneer token in Authorization, with no cookie, and never asks GoTrue", async () => {
    mock.asPioneer()
    const route = await import("@/app/api/courier/me/route")
    const res = await route.GET(courierRequest("/api/courier/me", { method: "GET", headers: pioneerHeaders }) as never)
    expect(res.status).toBe(401)
    expect(getUserCalls()).toEqual([])
    expect(rpcs()).toEqual([])
  })

  it("sign-in refuses a Pioneer token in the body, sets no cookie and never asks GoTrue", async () => {
    mock.asPioneer()
    const route = await import("@/app/api/courier/sign-in/route")
    const res = await route.POST(
      courierRequest("/api/courier/sign-in", { body: { accessToken: PIONEER_TOKEN }, headers: pioneerHeaders }) as never
    )
    // Not a credential here at all: the body takes a code and nothing else.
    expect(res.status).toBe(400)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(getUserCalls()).toEqual([])
    expect(rpcs()).toEqual([])
  })

  it("sign-out with a Pioneer token and no cookie ends nothing and never asks GoTrue", async () => {
    mock.asPioneer()
    const route = await import("@/app/api/courier/sign-out/route")
    const res = await route.POST(courierRequest("/api/courier/sign-out", { body: {}, headers: pioneerHeaders }) as never)
    // No session in the cookie, so there is nothing to end: the cookie is
    // cleared and the answer is the same as for an already ended session.
    expect(res.status).toBe(200)
    expect(getUserCalls()).toEqual([])
    expect(rpcs()).toEqual([])
  })

  for (const name of ["start", "refresh"] as const) {
    it(`kyc/${name} answers 401 to a Pioneer token in the body and Authorization, with no cookie, and never asks GoTrue`, async () => {
      mock.asPioneer()
      const route = await import(/* @vite-ignore */ `@/app/api/courier/kyc/${name}/route`)
      const res = await route.POST(
        courierRequest(`/api/courier/kyc/${name}`, { body: {}, headers: pioneerHeaders }) as never
      )
      expect(res.status).toBe(401)
      expect(getUserCalls()).toEqual([])
      expect(rpcs()).toEqual([])
      expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
    })
  }

  // Item 6 part (c). A body that passes each jobs route's strict schema, so a
  // Pioneer token in Authorization reaches resolveCourier and nothing else.
  const JOBS: Array<[string, Record<string, unknown>]> = [
    ["accept", { trackingId: JOB }],
    ["mine", {}],
    ["confirm-delivery", { trackingId: JOB, code: "1234" }],
  ]

  for (const [name, body] of JOBS) {
    it(`jobs/${name} answers 401 to a Pioneer token in Authorization, with no cookie, and never asks GoTrue`, async () => {
      mock.asPioneer()
      const route = await import(/* @vite-ignore */ `@/app/api/courier/jobs/${name}/route`)
      const res = await route.POST(courierRequest(`/api/courier/jobs/${name}`, { body, headers: pioneerHeaders }) as never)
      expect(res.status).toBe(401)
      expect(getUserCalls()).toEqual([])
      expect(rpcs()).toEqual([])
      expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
    })

    it(`jobs/${name} refuses a Pioneer token in the body: the strict schema, before any lookup`, async () => {
      mock.asPioneer()
      const route = await import(/* @vite-ignore */ `@/app/api/courier/jobs/${name}/route`)
      const res = await route.POST(
        courierRequest(`/api/courier/jobs/${name}`, { body: { ...body, accessToken: PIONEER_TOKEN }, headers: pioneerHeaders }) as never
      )
      expect(res.status).toBe(400)
      expect(getUserCalls()).toEqual([])
      expect(rpcs()).toEqual([])
      expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
    })

    it(`jobs/${name} is refused on the pioneer surface with a valid courier cookie, with no RPC`, async () => {
      mock.queueRpc({ data: [LIVE_COURIER], error: null })
      const route = await import(/* @vite-ignore */ `@/app/api/courier/jobs/${name}/route`)
      const res = await route.POST(
        courierRequest(`/api/courier/jobs/${name}`, {
          body,
          headers: { cookie: COURIER_COOKIE, "x-gyema-surface": "pioneer" },
        }) as never
      )
      expect(res.status).toBe(404)
      expect(rpcs()).toEqual([])
      expect(writes()).toEqual([])
    })
  }

  it("a valid courier cookie on the pioneer surface gets 401 from me, with no RPC", async () => {
    mock.queueRpc({ data: [LIVE_COURIER], error: null })
    const route = await import("@/app/api/courier/me/route")
    const res = await route.GET(
      courierRequest("/api/courier/me", {
        method: "GET",
        headers: { cookie: COURIER_COOKIE, "x-gyema-surface": "pioneer" },
      }) as never
    )
    expect(res.status).toBe(401)
    expect(rpcs()).toEqual([])
  })

  it("sign-in, sign-out and both kyc routes are refused on the pioneer surface, with no RPC", async () => {
    const signIn = await import("@/app/api/courier/sign-in/route")
    const signOut = await import("@/app/api/courier/sign-out/route")
    const headers = { cookie: COURIER_COOKIE, "x-gyema-surface": "pioneer" }
    expect((await signIn.POST(courierRequest("/api/courier/sign-in", { body: { code: "7K3QM-9XD2P" }, headers }) as never)).status).toBe(404)
    expect((await signOut.POST(courierRequest("/api/courier/sign-out", { body: {}, headers }) as never)).status).toBe(404)
    for (const name of ["start", "refresh"]) {
      const route = await import(/* @vite-ignore */ `@/app/api/courier/kyc/${name}/route`)
      expect((await route.POST(courierRequest(`/api/courier/kyc/${name}`, { body: {}, headers }) as never)).status).toBe(404)
    }
    expect(rpcs()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

/** Local modules a file imports, resolved to repository paths. @/ and relative only. */
function localImports(file: string): string[] {
  const src = readFileSync(file, "utf8")
  const out: string[] = []
  // from-imports and re-exports, bare side-effect imports, and import("...").
  const re = /(?:import|export)[^'"]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3]
    let base: string
    if (spec.startsWith("@/")) base = spec.slice(2)
    else if (spec.startsWith(".")) base = normalize(join(dirname(file), spec)).replace(/\\/g, "/")
    else continue
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      try {
        if (statSync(candidate).isFile()) {
          out.push(candidate)
          break
        }
      } catch {
        // not this candidate
      }
    }
  }
  return out
}

/** A file without its comment lines: the code it runs. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
}

/** Every local module reachable from a file, the file included. */
function importGraph(file: string): Set<string> {
  const seen = new Set<string>()
  const stack = [file]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    stack.push(...localImports(f))
  }
  return seen
}

describe("static: the two resolvers stay apart", () => {
  it("no Pioneer route reaches lib/courier-auth, directly or through anything it imports", () => {
    for (const f of ofClass("pioneer")) {
      const graph = importGraph(f)
      expect(graph.has("lib/route-auth.ts"), f).toBe(true)
      expect(graph.has("lib/courier-auth.ts"), f).toBe(false)
    }
  })

  it("lib/route-auth.ts does not reach lib/courier-auth, nor the other way", () => {
    expect(importGraph("lib/route-auth.ts").has("lib/courier-auth.ts")).toBe(false)
    expect(importGraph("lib/courier-auth.ts").has("lib/route-auth.ts")).toBe(false)
  })

  it("no Pioneer route reads a cookie", () => {
    for (const f of ofClass("pioneer")) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/cookies\(|request\.cookies|req\.cookies|get\(\s*["']cookie["']\s*\)/)
    }
  })

  it("no courier route reaches resolveCaller or calls auth.getUser", () => {
    for (const f of ofClass("courier")) {
      for (const g of importGraph(f)) {
        expect(g === "lib/route-auth.ts", `${f} reaches lib/route-auth.ts`).toBe(false)
        expect(codeOf(g), `${f} via ${g}`).not.toMatch(/resolveCaller|auth\.getUser/)
      }
    }
  })

  it("lib/courier-auth reads no body and no Authorization header", () => {
    expect(codeOf("lib/courier-auth.ts")).not.toMatch(/\.json\(\)|\.text\(\)|formData\(|get\(\s*["']authorization["']\s*\)/i)
  })
})
