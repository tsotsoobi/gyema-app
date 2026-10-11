import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { AdminMock, adminModule } from "./helpers/admin-mock"

// lib/courier-auth.ts and the three courier routes of Phase 1 item 5 part (b)
// (docs/anchoring-phase1-notes.md 5.2 and 5.3).
//
// The admin client is the mock in tests/helpers/admin-mock.ts. It does not
// simulate the SQL: courier_session_resolve tells an unknown, revoked,
// expired, idle or shredded session apart inside the database and answers
// every one of them with no row. So those cases arrive here as one shape, an
// empty result, and the tests below say so by name rather than pretending
// this file distinguishes them. The SQL behaviour was probed against a
// throwaway postgres when the migration was written.
//
// Placeholder hosts only, so this file names no network and mirrors as bytes.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => p,
  ipAddress: (input: Request | { headers: Headers }) =>
    ("headers" in input ? input.headers : input).get("x-real-ip") ?? undefined,
}))

type CheckLimit = typeof import("@/lib/rate-limit").checkLimit
const checkLimit = vi.fn<CheckLimit>(async () => ({ ok: true as const }))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>()
  return { ...actual, checkLimit }
})

const auth = await import("@/lib/courier-auth")
const signIn = await import("@/app/api/courier/sign-in/route")
const signOut = await import("@/app/api/courier/sign-out/route")
const me = await import("@/app/api/courier/me/route")

const HOST = "couriers.example.test"
const TOKEN = "gcs_" + "A".repeat(43)
const COURIER_ID = "0f1e2d3c-4b5a-4968-8776-655443322110"

function hex(text: string): string {
  return "\\x" + createHash("sha256").update(text, "utf8").digest("hex")
}

type Opts = {
  method?: "GET" | "POST"
  body?: unknown
  rawBody?: string
  cookie?: string | null
  surface?: string | null
  origin?: string | null
  contentType?: string | null
  headers?: Record<string, string>
}

function req(path: string, opts: Opts = {}): Request {
  const method = opts.method ?? "POST"
  const headers = new Headers(opts.headers)
  const surface = opts.surface === undefined ? "courier" : opts.surface
  if (surface !== null) headers.set("x-gyema-surface", surface)
  const cookie = opts.cookie === undefined ? null : opts.cookie
  if (cookie !== null) headers.set("cookie", cookie)
  if (method === "POST") {
    const origin = opts.origin === undefined ? `https://${HOST}` : opts.origin
    if (origin !== null) headers.set("origin", origin)
    const ct = opts.contentType === undefined ? "application/json" : opts.contentType
    if (ct !== null) headers.set("content-type", ct)
  }
  return new Request(`https://${HOST}${path}`, {
    method,
    headers,
    body: method === "POST" ? (opts.rawBody ?? JSON.stringify(opts.body ?? {})) : undefined,
  })
}

const LIVE_ROW = {
  courier_id: COURIER_ID,
  status: "registered",
  piverify_status: "rejected",
  piverify_allowed_action: "RESUBMIT",
  kyc_approved_at: null,
}

function rpcCalls(name?: string) {
  return mock.calls.filter((c) => c.method === "rpc" && (name === undefined || c.args[0] === name))
}

function writes() {
  return mock.calls.filter((c) => ["insert", "update", "delete", "upsert"].includes(c.method))
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  checkLimit.mockReset()
  checkLimit.mockImplementation(async () => ({ ok: true as const }))
  vi.stubEnv("COURIER_HOST", HOST)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// The token, the hash and the cookie
// ---------------------------------------------------------------------------

describe("session token", () => {
  it("is gcs_ plus 43 base64url characters, 47 in all, and never repeats", () => {
    const a = auth.newSessionToken()
    const b = auth.newSessionToken()
    expect(a).toMatch(/^gcs_[A-Za-z0-9_-]{43}$/)
    expect(a).toHaveLength(47)
    expect(a).not.toBe(b)
    expect(auth.isSessionTokenShape(a)).toBe(true)
  })

  it("refuses anything else by shape, a JWT included", () => {
    for (const bad of [
      "",
      "gcs_",
      "gcs_" + "A".repeat(42),
      "gcs_" + "A".repeat(44),
      "gcs_" + "A".repeat(42) + "=",
      "GCS_" + "A".repeat(43),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      null,
      undefined,
      42,
    ]) {
      expect(auth.isSessionTokenShape(bad), String(bad)).toBe(false)
    }
  })

  it("hashes to PostgREST's bytea text form: \\x and 64 hex characters", () => {
    expect(auth.sha256Bytea(TOKEN)).toBe(hex(TOKEN))
    expect(auth.sha256Bytea(TOKEN)).toMatch(/^\\x[0-9a-f]{64}$/)
  })
})

describe("cookie", () => {
  it("is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, with no Domain", () => {
    const c = auth.sessionCookie(TOKEN, 7776000)
    expect(c.startsWith(`__Host-gyema_courier=${TOKEN};`)).toBe(true)
    for (const flag of ["Path=/", "Max-Age=7776000", "HttpOnly", "Secure", "SameSite=Strict"]) {
      expect(c.split("; ")).toContain(flag)
    }
    expect(c).not.toMatch(/domain=/i)
  })

  it("clears with the same name, Secure and Path=/, and Max-Age=0", () => {
    const c = auth.clearedSessionCookie()
    expect(c.startsWith("__Host-gyema_courier=;")).toBe(true)
    for (const flag of ["Path=/", "Max-Age=0", "HttpOnly", "Secure", "SameSite=Strict"]) {
      expect(c.split("; ")).toContain(flag)
    }
    expect(c).not.toMatch(/domain=/i)
  })

  it("is read from the Cookie header alone", () => {
    expect(auth.readSessionToken(req("/x", { cookie: `a=1; __Host-gyema_courier=${TOKEN}; b=2` }))).toBe(TOKEN)
    expect(auth.readSessionToken(req("/x", { cookie: `gyema_courier=${TOKEN}` }))).toBeNull()
    expect(
      auth.readSessionToken(req("/x", { headers: { authorization: `Bearer ${TOKEN}` }, body: { token: TOKEN } }))
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveCourier
// ---------------------------------------------------------------------------

describe("resolveCourier", () => {
  async function resolve(r: Request) {
    return auth.resolveCourier(mock.client() as never, r)
  }

  it("resolves a live session to the legacy courier, by the hash of the cookie", async () => {
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    const verdict = await resolve(req("/api/courier/me", { method: "GET", cookie: `__Host-gyema_courier=${TOKEN}` }))
    expect(verdict).toEqual({ ok: true, courier: { kind: "legacy", ...LIVE_ROW } })
    expect(rpcCalls()).toEqual([
      { method: "rpc", args: ["courier_session_resolve", { p_token_hash: hex(TOKEN) }] },
    ])
  })

  it("answers no_session off the courier surface without touching the database", async () => {
    for (const surface of ["pioneer", null, "Courier", ""]) {
      const verdict = await resolve(
        req("/api/courier/me", { method: "GET", surface, cookie: `__Host-gyema_courier=${TOKEN}` })
      )
      expect(verdict, String(surface)).toEqual({ ok: false, reason: "no_session", status: 401 })
    }
    expect(mock.calls).toEqual([])
  })

  it("answers no_session for a missing or malformed cookie without touching the database", async () => {
    for (const cookie of [null, "__Host-gyema_courier=", "__Host-gyema_courier=not-a-token", `__Host-gyema_courier=${TOKEN}x`]) {
      const verdict = await resolve(req("/api/courier/me", { method: "GET", cookie }))
      expect(verdict, String(cookie)).toEqual({ ok: false, reason: "no_session", status: 401 })
    }
    expect(mock.calls).toEqual([])
  })

  it("never reads the token from Authorization or the body", async () => {
    const verdict = await resolve(
      req("/api/courier/me", { headers: { authorization: `Bearer ${TOKEN}` }, body: { accessToken: TOKEN } })
    )
    expect(verdict).toEqual({ ok: false, reason: "no_session", status: 401 })
    expect(mock.calls).toEqual([])
  })

  it("answers no_session when the function returns no row (unknown, revoked, expired, idle or shredded)", async () => {
    for (const data of [[], null]) {
      mock.queueRpc({ data, error: null })
      const verdict = await resolve(req("/api/courier/me", { method: "GET", cookie: `__Host-gyema_courier=${TOKEN}` }))
      expect(verdict).toEqual({ ok: false, reason: "no_session", status: 401 })
    }
  })

  it("answers 503 auth_unavailable on a database error, so a blip is not 'signed out'", async () => {
    mock.queueRpc({ data: null, error: { code: "57014", message: "canceling statement" } })
    const verdict = await resolve(req("/api/courier/me", { method: "GET", cookie: `__Host-gyema_courier=${TOKEN}` }))
    expect(verdict).toEqual({ ok: false, reason: "auth_unavailable", status: 503 })
  })

  it("answers 503 when the client throws, and logs neither the token nor its hash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = mock.client()
    ;(client as { rpc: unknown }).rpc = () => Promise.reject(new TypeError("fetch failed"))
    const verdict = await auth.resolveCourier(
      client as never,
      req("/api/courier/me", { method: "GET", cookie: `__Host-gyema_courier=${TOKEN}` })
    )
    expect(verdict).toEqual({ ok: false, reason: "auth_unavailable", status: 503 })
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain(hex(TOKEN).slice(2))
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// POST /api/courier/sign-in
// ---------------------------------------------------------------------------

describe("POST /api/courier/sign-in", () => {
  const CODE = "7K3QM-9XD2P"
  const future = () => new Date(Date.now() + 90 * 86400 * 1000).toISOString()

  it("normalises and hashes the code, hashes a fresh token, and sets the cookie on ok", async () => {
    mock.queueRpc({ data: [{ outcome: "ok", courier_id: COURIER_ID, expires_at: future() }], error: null })
    const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: " 7k3qm-9xd2p " } }) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get("cache-control")).toBe("no-store")

    const [call] = rpcCalls("courier_redeem_signin_code")
    const params = call.args[1] as { p_code_hash: string; p_token_hash: string }
    expect(params.p_code_hash).toBe(hex("7K3QM9XD2P"))
    expect(params.p_token_hash).toMatch(/^\\x[0-9a-f]{64}$/)
    expect(Object.keys(params).sort()).toEqual(["p_code_hash", "p_token_hash"])

    const setCookie = res.headers.get("set-cookie") ?? ""
    const token = /^__Host-gyema_courier=(gcs_[A-Za-z0-9_-]{43});/.exec(setCookie)?.[1]
    expect(token).toBeDefined()
    expect(hex(token!)).toBe(params.p_token_hash)
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
    expect(maxAge).toBeGreaterThan(90 * 86400 - 60)
    expect(maxAge).toBeLessThanOrEqual(90 * 86400)
  })

  it("reads O as 0 and I and L as 1, as the SQL does", async () => {
    mock.queueRpc({ data: [{ outcome: "no_match", courier_id: null, expires_at: null }], error: null })
    await signIn.POST(req("/api/courier/sign-in", { body: { code: "oil01 ab2cd" } }) as never)
    const params = rpcCalls("courier_redeem_signin_code")[0].args[1] as { p_code_hash: string }
    expect(params.p_code_hash).toBe(hex("01101AB2CD"))
  })

  it.each([
    ["no_match", 401],
    ["expired", 401],
    ["unavailable", 403],
  ])("answers %s with %i and sets no cookie", async (outcome, status) => {
    mock.queueRpc({ data: [{ outcome, courier_id: null, expires_at: null }], error: null })
    const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: CODE } }) as never)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason: outcome })
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("answers 500 on a function error, an unknown outcome, or ok without a usable expiry, with no cookie", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const cases = [
      { data: null, error: { code: "42883", message: "function does not exist" } },
      { data: [{ outcome: "something_new", courier_id: null, expires_at: null }], error: null },
      { data: [], error: null },
      { data: [{ outcome: "ok", courier_id: COURIER_ID, expires_at: null }], error: null },
      { data: [{ outcome: "ok", courier_id: COURIER_ID, expires_at: "2000-01-01T00:00:00Z" }], error: null },
    ]
    for (const result of cases) {
      mock.queueRpc(result)
      const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: CODE } }) as never)
      expect(res.status, JSON.stringify(result)).toBe(500)
      expect(res.headers.get("set-cookie")).toBeNull()
    }
    vi.mocked(console.error).mockRestore()
  })

  it("refuses a code that cannot exist with 400 invalid_code, before the global bucket or the database", async () => {
    for (const code of ["", "7K3QM-9XD2", "7K3QM-9XD2PP", "7K3QU-9XD2P", "7K3QM_9XD2P", "7K3QM-9XD2ß", "x".repeat(33), 12345]) {
      const res = await signIn.POST(req("/api/courier/sign-in", { body: { code } }) as never)
      expect(res.status, String(code)).toBe(400)
      expect(await res.json()).toEqual({ ok: false, reason: "invalid_code" })
    }
    expect(rpcCalls()).toEqual([])
    expect(checkLimit.mock.calls.map((c) => c[0])).not.toContain("courier_signin_global")
  })

  it("refuses any key beyond the code", async () => {
    const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: CODE, courier_id: COURIER_ID } }) as never)
    expect(res.status).toBe(400)
    expect(rpcCalls()).toEqual([])
  })

  it("is 404 off the courier surface, with no limiter call and no database call", async () => {
    const res = await signIn.POST(req("/api/courier/sign-in", { surface: "pioneer", body: { code: CODE } }) as never)
    expect(res.status).toBe(404)
    expect(checkLimit).not.toHaveBeenCalled()
    expect(mock.calls).toEqual([])
  })

  describe("CSRF: JSON and an Origin on COURIER_HOST, checked before Redis", () => {
    it.each([
      ["no Origin", { origin: null }, 403, "bad_origin"],
      ["another host", { origin: "https://evil.example.test" }, 403, "bad_origin"],
      ["a lookalike", { origin: `https://${HOST}.evil.example.test` }, 403, "bad_origin"],
      ["Origin null", { origin: "null" }, 403, "bad_origin"],
      ["a form post", { contentType: "application/x-www-form-urlencoded" }, 415, "unsupported_media_type"],
      ["text/plain", { contentType: "text/plain" }, 415, "unsupported_media_type"],
      ["no content type", { contentType: null }, 415, "unsupported_media_type"],
    ] as const)("refuses %s", async (_label, opts, status, reason) => {
      const res = await signIn.POST(req("/api/courier/sign-in", { ...opts, body: { code: CODE } }) as never)
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ ok: false, reason })
      expect(checkLimit).not.toHaveBeenCalled()
      expect(mock.calls).toEqual([])
    })

    it("accepts the courier host's own origin with a port and a charset", async () => {
      mock.queueRpc({ data: [{ outcome: "no_match", courier_id: null, expires_at: null }], error: null })
      const res = await signIn.POST(
        req("/api/courier/sign-in", {
          origin: `http://${HOST.toUpperCase()}:3000`,
          contentType: "application/json; charset=utf-8",
          body: { code: CODE },
        }) as never
      )
      expect(res.status).toBe(401)
    })

    it("refuses everything when COURIER_HOST is unset", async () => {
      vi.stubEnv("COURIER_HOST", "")
      const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: CODE } }) as never)
      expect(res.status).toBe(403)
      expect(mock.calls).toEqual([])
    })
  })

  describe("limits", () => {
    it("checks the IP bucket before the body and the global bucket after it, on the normal path", async () => {
      mock.queueRpc({ data: [{ outcome: "ok", courier_id: COURIER_ID, expires_at: future() }], error: null })
      const res = await signIn.POST(
        req("/api/courier/sign-in", { headers: { "x-real-ip": "203.0.113.7" }, body: { code: CODE } }) as never
      )
      expect(res.status).toBe(200)
      expect(checkLimit.mock.calls).toEqual([
        ["courier_signin_ip", "203.0.113.7"],
        ["courier_signin_global", "all"],
      ])
    })

    it("limits malformed bodies by IP too", async () => {
      await signIn.POST(req("/api/courier/sign-in", { rawBody: "not json" }) as never)
      expect(checkLimit.mock.calls.map((c) => c[0])).toEqual(["courier_signin_ip"])
    })

    it.each(["courier_signin_ip", "courier_signin_global"])(
      "answers 429 with Retry-After when %s refuses, and never reaches the database",
      async (bucket) => {
        for (const reason of ["rate_limited", "limiter_unavailable"] as const) {
          checkLimit.mockImplementation(async (name) =>
            name === bucket ? { ok: false as const, reason, retryAfterSeconds: 90 } : { ok: true as const }
          )
          const res = await signIn.POST(req("/api/courier/sign-in", { body: { code: CODE } }) as never)
          expect(res.status).toBe(429)
          expect(res.headers.get("retry-after")).toBe("90")
          expect(await res.json()).toEqual({ ok: false, reason })
        }
        expect(rpcCalls()).toEqual([])
      }
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/courier/sign-out
// ---------------------------------------------------------------------------

describe("POST /api/courier/sign-out", () => {
  it("ends the session in the cookie, by its hash, and clears the cookie", async () => {
    mock.queueRpc({ data: [{ ended: true }], error: null })
    const res = await signOut.POST(req("/api/courier/sign-out", { cookie: `__Host-gyema_courier=${TOKEN}` }) as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBe(auth.clearedSessionCookie())
    expect(rpcCalls()).toEqual([{ method: "rpc", args: ["courier_end_session", { p_token_hash: hex(TOKEN) }] }])
  })

  it("answers the same when the session was already ended", async () => {
    mock.queueRpc({ data: [{ ended: false }], error: null })
    const res = await signOut.POST(req("/api/courier/sign-out", { cookie: `__Host-gyema_courier=${TOKEN}` }) as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBe(auth.clearedSessionCookie())
  })

  it("clears the cookie with no database call when there is no usable cookie", async () => {
    for (const cookie of [null, "__Host-gyema_courier=junk"]) {
      const res = await signOut.POST(req("/api/courier/sign-out", { cookie }) as never)
      expect(res.status).toBe(200)
      expect(res.headers.get("set-cookie")).toBe(auth.clearedSessionCookie())
    }
    expect(mock.calls).toEqual([])
  })

  it("keeps the cookie and answers 503 when the session could not be ended", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mock.queueRpc({ data: null, error: { code: "08006", message: "connection failure" } })
    const res = await signOut.POST(req("/api/courier/sign-out", { cookie: `__Host-gyema_courier=${TOKEN}` }) as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "signout_unavailable" })
    expect(res.headers.get("set-cookie")).toBeNull()
    vi.mocked(console.error).mockRestore()
  })

  it("takes an empty object and nothing else", async () => {
    const res = await signOut.POST(
      req("/api/courier/sign-out", { cookie: `__Host-gyema_courier=${TOKEN}`, body: { token: TOKEN } }) as never
    )
    expect(res.status).toBe(400)
    expect(mock.calls).toEqual([])
  })

  it("runs the CSRF check and is 404 off the courier surface", async () => {
    const cookie = `__Host-gyema_courier=${TOKEN}`
    expect((await signOut.POST(req("/api/courier/sign-out", { cookie, origin: "https://evil.example.test" }) as never)).status).toBe(403)
    expect((await signOut.POST(req("/api/courier/sign-out", { cookie, contentType: "text/plain" }) as never)).status).toBe(415)
    expect((await signOut.POST(req("/api/courier/sign-out", { cookie, surface: "pioneer" }) as never)).status).toBe(404)
    expect(mock.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GET /api/courier/me
// ---------------------------------------------------------------------------

describe("GET /api/courier/me", () => {
  const cookie = `__Host-gyema_courier=${TOKEN}`

  /** The courier_registry row canStartKyc reads, matching LIVE_ROW. */
  const KYC_ROW = {
    paused_reason: "rejected",
    piverify_session_id: "ks_0123456789abcdef",
    piverify_status: "rejected",
    piverify_allowed_action: "RESUBMIT",
    kyc_approved_at: null,
  }

  it("returns the reference, status, piverify status, allowed action and canStartKyc, and nothing else", async () => {
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    mock.queue({ data: KYC_ROW, error: null })
    const res = await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      courier: {
        reference: "0f1e2d3c",
        status: "registered",
        piverifyStatus: "rejected",
        piverifyAllowedAction: "RESUBMIT",
        canStartKyc: true,
        effectiveTier: "none",
      },
    })
    // Never the whole id.
    expect(JSON.stringify(body)).not.toContain(COURIER_ID)
    // The row is read by the resolved courier id: the KYC columns and
    // buffer_since for the ladder, in one read.
    expect(mock.trace()).toContain('from("courier_registry")')
    expect(mock.trace()).toContain(`eq("id", "${COURIER_ID}")`)
    expect(mock.selectedColumns()).toBe(
      "paused_reason, buffer_since, piverify_session_id, piverify_status, piverify_allowed_action, kyc_approved_at"
    )
  })

  describe("effectiveTier, from the ladder on the server clock", () => {
    const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)
    const WINDOW = 30 * 24 * 60 * 60 * 1000

    async function tierFor(status: string, bufferSince: string | null): Promise<unknown> {
      vi.spyOn(Date, "now").mockReturnValue(NOW)
      mock.queueRpc({ data: [{ ...LIVE_ROW, status }], error: null })
      mock.queue({ data: { ...KYC_ROW, buffer_since: bufferSince }, error: null })
      const body = await (await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)).json()
      vi.mocked(Date.now).mockRestore()
      return body.courier
    }

    it("is buffer one millisecond inside 30 days, and none at exactly 30 days, while status still says buffer", async () => {
      expect(await tierFor("buffer", new Date(NOW - WINDOW + 1).toISOString())).toMatchObject({
        status: "buffer",
        effectiveTier: "buffer",
      })
      expect(await tierFor("buffer", new Date(NOW - WINDOW).toISOString())).toMatchObject({
        status: "buffer",
        effectiveTier: "none",
      })
      expect(await tierFor("buffer", new Date(NOW - WINDOW - 1).toISOString())).toMatchObject({
        status: "buffer",
        effectiveTier: "none",
      })
    })

    it("fails closed on a buffer row with no buffer_since, and follows the 6.4 table otherwise", async () => {
      expect(await tierFor("buffer", null)).toMatchObject({ effectiveTier: "none" })
      expect(await tierFor("full", null)).toMatchObject({ effectiveTier: "full" })
      expect(await tierFor("registered", null)).toMatchObject({ effectiveTier: "none" })
      expect(await tierFor("paused", null)).toMatchObject({ effectiveTier: "none" })
    })

    it("uses effectiveTier from lib/courier-ladder.ts, not a copy of the rule", () => {
      const src = readFileSync("app/api/courier/me/route.ts", "utf8")
      expect(src).toMatch(/import \{ effectiveTier \} from "@\/lib\/courier-ladder"/)
      expect(src).toContain("Date.now()")
    })
  })

  it("says canStartKyc false when approved, or paused by the operator, from the same table kyc/start uses", async () => {
    for (const row of [
      { ...KYC_ROW, piverify_status: "approved", piverify_allowed_action: null, paused_reason: null, kyc_approved_at: "2026-10-01T00:00:00Z" },
      { ...KYC_ROW, paused_reason: "operator" },
    ]) {
      mock.queueRpc({ data: [LIVE_ROW], error: null })
      mock.queue({ data: row, error: null })
      const res = await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
      expect((await res.json()).courier.canStartKyc).toBe(false)
    }
  })

  it("answers 503 when the registry row cannot be read, and 500 when there is none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    mock.queue({ data: null, error: { code: "57014" } })
    expect((await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)).status).toBe(503)
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    mock.queue({ data: null, error: null })
    expect((await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)).status).toBe(500)
    vi.mocked(console.warn).mockRestore()
    vi.mocked(console.error).mockRestore()
  })

  it("keys courier_me on the courier the session resolved to", async () => {
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
    expect(checkLimit.mock.calls).toEqual([["courier_me", COURIER_ID]])
  })

  it("answers 429 with Retry-After when courier_me refuses", async () => {
    checkLimit.mockImplementation(async () => ({ ok: false as const, reason: "rate_limited", retryAfterSeconds: 30 }))
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    const res = await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
  })

  it("answers 401 no_session without a session, before any limiter call", async () => {
    const res = await me.GET(req("/api/courier/me", { method: "GET" }) as never)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, reason: "no_session" })
    expect(checkLimit).not.toHaveBeenCalled()
  })

  it("answers 503 auth_unavailable on a database error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mock.queueRpc({ data: null, error: { code: "57014" } })
    const res = await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "auth_unavailable" })
    vi.mocked(console.warn).mockRestore()
  })

  it("never writes a table", async () => {
    mock.queueRpc({ data: [LIVE_ROW], error: null })
    mock.queue({ data: KYC_ROW, error: null })
    const res = await me.GET(req("/api/courier/me", { method: "GET", cookie }) as never)
    expect(res.status).toBe(200)
    expect(writes()).toEqual([])
    expect(rpcCalls().map((c) => c.args[0])).toEqual(["courier_session_resolve"])
  })
})

// ---------------------------------------------------------------------------
// Mirroring
// ---------------------------------------------------------------------------

// CLAUDE.md's mirror scan plus the courier hosts' domain, assembled from
// pieces so this file does not hit the scan itself and mirrors as bytes too.
const NETWORK_SCAN = new RegExp(
  ["pinet\\.com", "Test" + "net", "test" + "net", "88" + "41", "36" + "81", "pill" + "gh"].join("|")
)

describe("the files part (b) adds name no network", () => {
  it("so they mirror between repositories as bytes", () => {
    for (const f of [
      "lib/courier-auth.ts",
      "lib/courier-code.ts",
      "app/api/courier/sign-in/route.ts",
      "app/api/courier/sign-out/route.ts",
      "app/api/courier/me/route.ts",
      "app/courier/page.tsx",
      "app/courier/courier-panel.tsx",
      "tests/courier-auth.test.ts",
      "tests/courier-code-parity.test.ts",
      "tests/routes/identity-separation.test.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(NETWORK_SCAN)
    }
  })
})
