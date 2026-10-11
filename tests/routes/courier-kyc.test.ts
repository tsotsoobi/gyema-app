import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { AdminMock, adminModule } from "../helpers/admin-mock"

// POST /api/courier/kyc/start, POST /api/courier/kyc/refresh, and the
// decision they share with GET /api/courier/me (Phase 1 item 5 part (c),
// docs/anchoring-phase1-notes.md 5.4).
//
// PiVerify is a stubbed fetch and the database is the admin mock, which does
// not simulate the SQL: what courier_bind_piverify_session and
// courier_apply_kyc_status do to a row was probed against a throwaway
// postgres when their migrations were written. These pin what the routes
// send, in what order, and that nothing is written when PiVerify did not
// answer usefully.
//
// Placeholder hosts only, so this file names no network and mirrors as bytes.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

type CheckLimit = typeof import("@/lib/rate-limit").checkLimit
const checkLimit = vi.fn<CheckLimit>(async () => ({ ok: true as const }))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>()
  return { ...actual, checkLimit }
})

const kyc = await import("@/lib/courier-kyc")
const piverify = await import("@/lib/piverify")
const start = await import("@/app/api/courier/kyc/start/route")
const refresh = await import("@/app/api/courier/kyc/refresh/route")

const HOST = "couriers.example.test"
const API = "https://piverify.example.invalid"
const TOKEN = "gcs_" + "K".repeat(43)
const COOKIE = `__Host-gyema_courier=${TOKEN}`
const COURIER_ID = "0f1e2d3c-4b5a-4968-8776-655443322110"
const BOUND = "ks_bound0000000001"
const NEW = "ks_new000000000002"
const WINNER = "ks_winner000000003"
const NOW = Date.UTC(2026, 9, 9, 12, 34, 56)

const RESOLVED = {
  courier_id: COURIER_ID,
  status: "registered",
  piverify_status: null,
  piverify_allowed_action: null,
  kyc_approved_at: null,
}

type Row = import("@/lib/courier-kyc").CourierKycRow

function row(overrides: Partial<Row> = {}): Row {
  return {
    paused_reason: null,
    buffer_since: null,
    piverify_session_id: null,
    piverify_status: null,
    piverify_allowed_action: null,
    kyc_approved_at: null,
    ...overrides,
  }
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: NEW,
    external_user_id: COURIER_ID,
    status: "created",
    hosted_flow_url: `https://flow.example.invalid/${String(overrides.id ?? NEW)}`,
    rejection_reason: null,
    created_at: "2026-10-09T12:00:00Z",
    updated_at: "2026-10-09T12:00:00.123456Z",
    ...overrides,
  }
}

type Answer = { status?: number; body?: unknown }

/** PiVerify: POST /kyc_sessions answers create; GET /kyc_sessions/:id answers from byId. */
function piverifyAnswers(opts: { create?: Answer; byId?: Record<string, Answer> }) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const answer =
      (init?.method ?? "GET") === "POST"
        ? opts.create
        : opts.byId?.[decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))]
    if (!answer) return new Response("{}", { status: 404 })
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
}

type Opts = { body?: unknown; cookie?: string | null; surface?: string; origin?: string }

function req(path: string, opts: Opts = {}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin: opts.origin ?? `https://${HOST}`,
    "x-gyema-surface": opts.surface ?? "courier",
  })
  const cookie = opts.cookie === undefined ? COOKIE : opts.cookie
  if (cookie !== null) headers.set("cookie", cookie)
  return new Request(`https://${HOST}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  })
}

/** A signed-in courier whose registry row reads as given. */
function signedIn(r: Row) {
  mock.queueRpc({ data: [RESOLVED], error: null })
  mock.queue({ data: r, error: null })
}

function rpcCalls(name?: string) {
  return mock.calls.filter((c) => c.method === "rpc" && (name === undefined || c.args[0] === name))
}

function writes() {
  return mock.calls.filter((c) => ["insert", "update", "delete", "upsert"].includes(c.method))
}

/** Every line logged, joined, for checks on what never reaches a log. */
function logged(): string {
  return [console.log, console.warn, console.error]
    .flatMap((f) => vi.mocked(f).mock.calls)
    .map((args) => args.map(String).join(" "))
    .join("\n")
}

function expectedKey(courierId: string, bound: string | null, nowMs: number): string {
  const window = Math.floor(Math.floor(nowMs / 1000) / 600)
  return "gyema_" + createHash("sha256").update(`${courierId}:${bound ?? "none"}:${window}`).digest("hex").slice(0, 32)
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  checkLimit.mockReset()
  checkLimit.mockImplementation(async () => ({ ok: true as const }))
  vi.stubEnv("COURIER_HOST", HOST)
  vi.stubEnv("PIVERIFY_API_BASE_URL", `${API}/`)
  vi.stubEnv("PIVERIFY_API_KEY", "sbx_test_only")
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The shared decision
// ---------------------------------------------------------------------------

describe("decideKycStart: the 5.4 table", () => {
  it("refuses an approved courier first, even when paused", () => {
    expect(kyc.decideKycStart(row({ kyc_approved_at: "2026-10-01T00:00:00Z", paused_reason: "operator" }))).toEqual({
      kind: "already_verified",
    })
  })

  it("refuses an operator pause, whatever the session", () => {
    for (const status of [null, "started", "failed"]) {
      expect(
        kyc.decideKycStart(row({ paused_reason: "operator", piverify_session_id: status && BOUND, piverify_status: status }))
      ).toEqual({ kind: "paused" })
    }
  })

  it("continues a live session: created, started, pending_review, or a rejection with an action", () => {
    for (const r of [
      row({ piverify_session_id: BOUND, piverify_status: "created" }),
      row({ piverify_session_id: BOUND, piverify_status: "started" }),
      row({ piverify_session_id: BOUND, piverify_status: "pending_review", paused_reason: "pending_timeout" }),
      row({ piverify_session_id: BOUND, piverify_status: "rejected", piverify_allowed_action: "RESUBMIT", paused_reason: "rejected" }),
      row({ piverify_session_id: BOUND, piverify_status: "rejected", piverify_allowed_action: "APPEAL", paused_reason: "rejected" }),
    ]) {
      expect(kyc.decideKycStart(r), JSON.stringify(r)).toEqual({ kind: "continue", sessionId: BOUND })
    }
  })

  it("creates for no session, a final rejection, or a failure, expecting the bound id", () => {
    expect(kyc.decideKycStart(row())).toEqual({ kind: "create", expectedSessionId: null })
    for (const r of [
      row({ piverify_session_id: BOUND, piverify_status: "rejected", paused_reason: "rejected" }),
      row({ piverify_session_id: BOUND, piverify_status: "failed", paused_reason: "failed" }),
    ]) {
      expect(kyc.decideKycStart(r)).toEqual({ kind: "create", expectedSessionId: BOUND })
    }
  })

  it("canStartKyc is true exactly when the route would continue or create", () => {
    expect(kyc.canStartKyc(row())).toBe(true)
    expect(kyc.canStartKyc(row({ piverify_session_id: BOUND, piverify_status: "started" }))).toBe(true)
    expect(kyc.canStartKyc(row({ kyc_approved_at: "2026-10-01T00:00:00Z" }))).toBe(false)
    expect(kyc.canStartKyc(row({ paused_reason: "operator" }))).toBe(false)
  })

  it("is the function GET /api/courier/me and kyc/start both import", () => {
    expect(readFileSync("app/api/courier/me/route.ts", "utf8")).toMatch(/import \{[^}]*canStartKyc[^}]*\} from "@\/lib\/courier-kyc"/)
    expect(readFileSync("app/api/courier/kyc/start/route.ts", "utf8")).toMatch(/import \{[^}]*decideKycStart[^}]*\} from "@\/lib\/courier-kyc"/)
  })
})

describe("the idempotency key", () => {
  it("is gyema_ plus the first 32 hex of sha256(courier_id:bound or none:floor(seconds / 600)), 38 characters", () => {
    const key = kyc.kycIdempotencyKey(COURIER_ID, null, NOW)
    expect(key).toBe(expectedKey(COURIER_ID, null, NOW))
    expect(key).toMatch(/^gyema_[0-9a-f]{32}$/)
    expect(key).toHaveLength(38)
    expect(kyc.kycIdempotencyKey(COURIER_ID, BOUND, NOW)).toBe(expectedKey(COURIER_ID, BOUND, NOW))
  })

  it("repeats inside a 10-minute window and changes across one", () => {
    const windowStart = Math.floor(NOW / 600_000) * 600_000
    const a = kyc.kycIdempotencyKey(COURIER_ID, null, windowStart)
    expect(kyc.kycIdempotencyKey(COURIER_ID, null, windowStart + 599_999)).toBe(a)
    expect(kyc.kycIdempotencyKey(COURIER_ID, null, windowStart + 600_000)).not.toBe(a)
    expect(kyc.kycIdempotencyKey(COURIER_ID, BOUND, windowStart)).not.toBe(a)
  })
})

describe("lib/piverify additions", () => {
  it("throws a typed PiVerifyHttpError carrying op and status, and no upstream body", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 402, body: { error: "payment_required", secret: "UPSTREAM-BODY" } } }))
    const err = await piverify
      .createPiVerifySession({ external_user_id: COURIER_ID, idempotency_key: "k" })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(piverify.PiVerifyHttpError)
    expect(err).toMatchObject({ op: "createSession", status: 402 })
    expect(String((err as Error).message)).toBe("[piverify] createSession failed: HTTP 402")
    expect(JSON.stringify(err) + String(err)).not.toContain("UPSTREAM-BODY")
  })

  it("refuses a session with no updated_at, or an empty one", async () => {
    for (const updated_at of [undefined, "", 12]) {
      vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: session({ id: BOUND, updated_at }) } } }))
      await expect(piverify.getPiVerifySession(BOUND)).rejects.toThrow(/updated_at/)
    }
  })

  it("checks the session id shape: at most 64 of A-Z a-z 0-9 _ -, no ':'", () => {
    for (const ok of ["ks_abc", "A", "x".repeat(64), "a-b_C9"]) expect(piverify.isPiVerifySessionId(ok), ok).toBe(true)
    for (const bad of ["", "x".repeat(65), "ks:1", "ks 1", "ks/1", "ks.1", null, 7]) {
      expect(piverify.isPiVerifySessionId(bad), String(bad)).toBe(false)
    }
  })

  it("builds poll:<session_id>:<status>:<allowed_action or ->:<updated_at>, updated_at verbatim", () => {
    expect(
      piverify.pollEventId({ id: BOUND, status: "pending_review", allowed_action: null, updated_at: "2026-10-09T12:00:00.123456Z" })
    ).toBe(`poll:${BOUND}:pending_review:-:2026-10-09T12:00:00.123456Z`)
    expect(piverify.pollEventId({ id: BOUND, status: "rejected", allowed_action: "APPEAL", updated_at: "2026-10-09 12:00:00+00" })).toBe(
      `poll:${BOUND}:rejected:APPEAL:2026-10-09 12:00:00+00`
    )
  })

  it("refuses rather than truncates a poll id over 128 characters", () => {
    const base = { id: "x".repeat(64), status: "pending_review" as const, allowed_action: null }
    const prefix = `poll:${"x".repeat(64)}:pending_review:-:`
    expect(piverify.pollEventId({ ...base, updated_at: "u".repeat(128 - prefix.length) })).toHaveLength(128)
    expect(piverify.pollEventId({ ...base, updated_at: "u".repeat(129 - prefix.length) })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// POST /api/courier/kyc/start
// ---------------------------------------------------------------------------

describe("POST /api/courier/kyc/start: refusals before PiVerify", () => {
  it("answers 409 already_verified for an approved courier, with no PiVerify call and no RPC but the resolve", async () => {
    const fetchSpy = piverifyAnswers({})
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "approved", kyc_approved_at: "2026-10-01T00:00:00Z" }))
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: "already_verified" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls().map((c) => c.args[0])).toEqual(["courier_session_resolve"])
  })

  it("answers 403 paused for an operator pause, with no PiVerify call", async () => {
    const fetchSpy = piverifyAnswers({})
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ paused_reason: "operator", piverify_session_id: BOUND, piverify_status: "failed" }))
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "paused" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("is 404 off the courier surface, and runs the CSRF check, before the limiter or the database", async () => {
    expect((await start.POST(req("/api/courier/kyc/start", { surface: "pioneer" }) as never)).status).toBe(404)
    expect((await start.POST(req("/api/courier/kyc/start", { origin: "https://elsewhere.example.test" }) as never)).status).toBe(403)
    expect(checkLimit).not.toHaveBeenCalled()
    expect(mock.calls).toEqual([])
  })

  it("takes an empty object and nothing else: no courier or session id from the body", async () => {
    const res = await start.POST(req("/api/courier/kyc/start", { body: { courierId: COURIER_ID } }) as never)
    expect(res.status).toBe(400)
    expect(mock.calls).toEqual([])
  })

  it("answers 401 with no session, before the limiter", async () => {
    const res = await start.POST(req("/api/courier/kyc/start", { cookie: null }) as never)
    expect(res.status).toBe(401)
    expect(checkLimit).not.toHaveBeenCalled()
  })

  it("keys courier_kyc_start on the resolved courier, and answers 429 with Retry-After before reading the row", async () => {
    checkLimit.mockImplementation(async () => ({ ok: false as const, reason: "rate_limited", retryAfterSeconds: 3600 }))
    mock.queueRpc({ data: [RESOLVED], error: null })
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("3600")
    expect(checkLimit.mock.calls).toEqual([["courier_kyc_start", COURIER_ID]])
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })

  it("allows ten starts a day, failing closed (founder decision, 9 Oct 2026)", async () => {
    // Raised from three so a courier on unreliable mobile data is not locked
    // out mid-flow. Every call past resolveCourier still spends it.
    const { LIMITS } = await import("@/lib/rate-limit")
    expect(LIMITS.courier_kyc_start).toEqual({ limit: 10, window: "1 d", onError: "closed" })
  })

  it("answers 503 when the row cannot be read", async () => {
    mock.queueRpc({ data: [RESOLVED], error: null })
    mock.queue({ data: null, error: { code: "57014" } })
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "verification_unavailable" })
  })
})

describe("POST /api/courier/kyc/start: continuing a live session", () => {
  it("re-fetches the bound session and returns its hosted_flow_url, creating and binding nothing", async () => {
    const url = "https://flow.example.invalid/bound"
    const fetchSpy = piverifyAnswers({ byId: { [BOUND]: { body: session({ id: BOUND, status: "started", hosted_flow_url: url }) } } })
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hostedFlowUrl: url })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${API}/api/v1/kyc_sessions/${BOUND}`)
    expect(rpcCalls("courier_bind_piverify_session")).toEqual([])
    expect(writes()).toEqual([])
  })

  it("continues a reopened rejection on the same session", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: session({ id: BOUND, status: "rejected", allowed_action: "RESUBMIT" }) } } }))
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "rejected", piverify_allowed_action: "RESUBMIT", paused_reason: "rejected" }))
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(200)
    expect(rpcCalls("courier_bind_piverify_session")).toEqual([])
  })

  it("answers 503 when the re-fetch fails or the URL is not https", async () => {
    for (const answer of [{ status: 502 }, { body: session({ id: BOUND, hosted_flow_url: "http://flow.example.invalid/x" }) }]) {
      vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: answer } }))
      signedIn(row({ piverify_session_id: BOUND, piverify_status: "created" }))
      const res = await start.POST(req("/api/courier/kyc/start") as never)
      expect(res.status).toBe(503)
    }
  })
})

describe("POST /api/courier/kyc/start: create, then bind", () => {
  it("creates with the courier id and the key, binds with the expected session, and returns the new URL", async () => {
    const fetchSpy = piverifyAnswers({ create: { status: 201, body: session() } })
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "failed", paused_reason: "failed" }))
    mock.queueRpc({ data: [{ outcome: "bound", current_session_id: NEW }], error: null })

    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hostedFlowUrl: session().hosted_flow_url })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API}/api/v1/kyc_sessions`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      external_user_id: COURIER_ID,
      idempotency_key: expectedKey(COURIER_ID, BOUND, NOW),
    })

    const [name, params] = rpcCalls("courier_bind_piverify_session")[0].args
    expect(name).toBe("courier_bind_piverify_session")
    expect(params).toEqual({
      p_courier_id: COURIER_ID,
      p_expected_session_id: BOUND,
      p_new_session_id: NEW,
      p_status: "created",
    })
    expect(writes()).toEqual([])
  })

  it("uses none in the key when no session is bound, and passes a null expected session", async () => {
    const fetchSpy = piverifyAnswers({ create: { status: 201, body: session() } })
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row())
    mock.queueRpc({ data: [{ outcome: "bound", current_session_id: NEW }], error: null })
    await start.POST(req("/api/courier/kyc/start") as never)
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.idempotency_key).toBe(expectedKey(COURIER_ID, null, NOW))
    expect((rpcCalls("courier_bind_piverify_session")[0].args[1] as Record<string, unknown>).p_expected_session_id).toBeNull()
  })

  it("answers a 402 with 503 verification_unavailable, logs that the account needs credit, and writes nothing", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 402, body: { error: "payment_required" } } }))
    signedIn(row())
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "verification_unavailable" })
    expect(vi.mocked(console.error).mock.calls).toContainEqual([
      "[gyema] piverify createSession 402: PiVerify account needs credit",
    ])
    expect(rpcCalls("courier_bind_piverify_session")).toEqual([])
    expect(writes()).toEqual([])
  })

  it("answers 502, 429 and a timeout-shaped failure with 503 too, binding nothing", async () => {
    for (const status of [502, 429, 500]) {
      vi.stubGlobal("fetch", piverifyAnswers({ create: { status } }))
      signedIn(row())
      const res = await start.POST(req("/api/courier/kyc/start") as never)
      expect(res.status, String(status)).toBe(503)
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError") }))
    signedIn(row())
    expect((await start.POST(req("/api/courier/kyc/start") as never)).status).toBe(503)
    expect(rpcCalls("courier_bind_piverify_session")).toEqual([])
  })

  it("refuses a created session with a bad id, another external_user_id or a non-https URL, binding nothing", async () => {
    for (const odd of [
      session({ id: "ks:has:colons" }),
      session({ id: "x".repeat(65) }),
      session({ external_user_id: "someone-else" }),
      session({ hosted_flow_url: "http://flow.example.invalid/x" }),
      session({ hosted_flow_url: "javascript:alert(1)" }),
    ]) {
      vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 201, body: odd } }))
      signedIn(row())
      const res = await start.POST(req("/api/courier/kyc/start") as never)
      expect(res.status, JSON.stringify(odd)).toBe(503)
    }
    expect(rpcCalls("courier_bind_piverify_session")).toEqual([])
  })

  it("on conflict returns the URL of the session that won, never its own", async () => {
    const winnerUrl = "https://flow.example.invalid/winner"
    const fetchSpy = piverifyAnswers({
      create: { status: 201, body: session() },
      byId: { [WINNER]: { body: session({ id: WINNER, hosted_flow_url: winnerUrl }) } },
    })
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row())
    mock.queueRpc({ data: [{ outcome: "conflict", current_session_id: WINNER }], error: null })
    const res = await start.POST(req("/api/courier/kyc/start") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, hostedFlowUrl: winnerUrl })
    expect(JSON.stringify(body)).not.toContain(NEW)
    expect(String(fetchSpy.mock.calls[1][0])).toBe(`${API}/api/v1/kyc_sessions/${WINNER}`)
  })

  it("treats session_live like conflict", async () => {
    const winnerUrl = "https://flow.example.invalid/winner"
    vi.stubGlobal("fetch", piverifyAnswers({
      create: { status: 201, body: session() },
      byId: { [WINNER]: { body: session({ id: WINNER, hosted_flow_url: winnerUrl }) } },
    }))
    signedIn(row())
    mock.queueRpc({ data: [{ outcome: "session_live", current_session_id: WINNER }], error: null })
    expect(await (await start.POST(req("/api/courier/kyc/start") as never)).json()).toEqual({ ok: true, hostedFlowUrl: winnerUrl })
  })

  it("maps the other bind outcomes, and a function error", async () => {
    const cases: [unknown, number, string][] = [
      [{ data: [{ outcome: "already_full", current_session_id: BOUND }], error: null }, 409, "already_verified"],
      [{ data: [{ outcome: "shredded", current_session_id: null }], error: null }, 403, "unavailable"],
      [{ data: [{ outcome: "bad_status", current_session_id: null }], error: null }, 503, "verification_unavailable"],
      [{ data: [{ outcome: "session_taken", current_session_id: null }], error: null }, 503, "verification_unavailable"],
      [{ data: [], error: null }, 503, "verification_unavailable"],
      [{ data: null, error: { code: "42883" } }, 500, "server_error"],
    ]
    for (const [result, status, reason] of cases) {
      vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 201, body: session() } }))
      signedIn(row())
      mock.queueRpc(result as { data: unknown; error: unknown })
      const res = await start.POST(req("/api/courier/kyc/start") as never)
      expect(res.status, JSON.stringify(result)).toBe(status)
      expect((await res.json()).reason).toBe(reason)
    }
  })

  it("never logs a hosted_flow_url or the whole courier id", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 201, body: session() } }))
    signedIn(row())
    mock.queueRpc({ data: [{ outcome: "bound", current_session_id: NEW }], error: null })
    await start.POST(req("/api/courier/kyc/start") as never)
    vi.stubGlobal("fetch", piverifyAnswers({ create: { status: 201, body: session({ external_user_id: "x" }) } }))
    signedIn(row())
    await start.POST(req("/api/courier/kyc/start") as never)
    expect(logged()).not.toContain("flow.example.invalid")
    expect(logged()).not.toContain(COURIER_ID)
  })
})

// ---------------------------------------------------------------------------
// POST /api/courier/kyc/refresh
// ---------------------------------------------------------------------------

describe("POST /api/courier/kyc/refresh", () => {
  it("skips a courier with nothing left to learn, with no PiVerify call and no apply", async () => {
    const fetchSpy = piverifyAnswers({})
    vi.stubGlobal("fetch", fetchSpy)
    for (const r of [
      row(),
      row({ piverify_session_id: BOUND, piverify_status: "approved", kyc_approved_at: "2026-10-01T00:00:00Z" }),
      row({ piverify_session_id: BOUND, piverify_status: "rejected", paused_reason: "rejected" }),
      row({ piverify_session_id: BOUND, piverify_status: "failed", paused_reason: "failed" }),
    ]) {
      signedIn(r)
      const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, outcome: "skipped" })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls("courier_apply_kyc_status")).toEqual([])
  })

  it("re-fetches the bound session and applies it under the poll id, with event type poll", async () => {
    const fetchSpy = piverifyAnswers({
      byId: { [BOUND]: { body: session({ id: BOUND, status: "pending_review", updated_at: "2026-10-09T12:00:00.123456Z" }) } },
    })
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "buffer" }], error: null })

    const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: "applied" })
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${API}/api/v1/kyc_sessions/${BOUND}`)
    expect(rpcCalls("courier_apply_kyc_status")[0].args[1]).toEqual({
      p_event_id: `poll:${BOUND}:pending_review:-:2026-10-09T12:00:00.123456Z`,
      p_event_type: "poll",
      p_session_id: BOUND,
      p_external_user_id: COURIER_ID,
      p_status: "pending_review",
      p_allowed_action: null,
    })
    expect(checkLimit.mock.calls).toEqual([["courier_kyc_refresh", COURIER_ID]])
    expect(writes()).toEqual([])
  })

  it("builds the same id for the same observation, and passes a reopened rejection's action", async () => {
    const observed = session({ id: BOUND, status: "rejected", allowed_action: "APPEAL", updated_at: "2026-10-09T13:00:00Z" })
    for (let i = 0; i < 2; i++) {
      vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: observed } } }))
      signedIn(row({ piverify_session_id: BOUND, piverify_status: "pending_review" }))
      mock.queueRpc({ data: [{ outcome: i === 0 ? "applied" : "duplicate", courier_status: "paused" }], error: null })
      await refresh.POST(req("/api/courier/kyc/refresh") as never)
    }
    const ids = rpcCalls("courier_apply_kyc_status").map((c) => (c.args[1] as Record<string, unknown>).p_event_id)
    expect(ids).toEqual([`poll:${BOUND}:rejected:APPEAL:2026-10-09T13:00:00Z`, `poll:${BOUND}:rejected:APPEAL:2026-10-09T13:00:00Z`])
    expect((rpcCalls("courier_apply_kyc_status")[0].args[1] as Record<string, unknown>).p_allowed_action).toBe("APPEAL")
  })

  it("answers 503 and writes nothing when the re-fetch fails, a 402 included, or the session has no updated_at", async () => {
    for (const answer of [{ status: 402 }, { status: 502 }, { body: session({ id: BOUND, updated_at: "" }) }]) {
      vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: answer } }))
      signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
      const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
      expect(res.status, JSON.stringify(answer)).toBe(503)
      expect(await res.json()).toEqual({ ok: false, reason: "verification_unavailable" })
    }
    expect(rpcCalls("courier_apply_kyc_status")).toEqual([])
  })

  it("ignores a re-fetch naming another session, writing nothing", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: session({ id: WINNER }) } } }))
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
    const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" })
    expect(rpcCalls("courier_apply_kyc_status")).toEqual([])
  })

  it("refuses, never truncates, a poll id over 128 characters, and logs it", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: session({ id: BOUND, status: "started", updated_at: "9".repeat(120) }) } } }))
    signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
    const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" })
    expect(rpcCalls("courier_apply_kyc_status")).toEqual([])
    expect(logged()).toMatch(/over 128 characters/)
  })

  it("does not poll a stored session id of the wrong shape", async () => {
    const fetchSpy = piverifyAnswers({})
    vi.stubGlobal("fetch", fetchSpy)
    signedIn(row({ piverify_session_id: "ks:bad", piverify_status: "started" }))
    const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("answers 500 on a function error or no result", async () => {
    for (const result of [{ data: null, error: { code: "23514" } }, { data: [], error: null }]) {
      vi.stubGlobal("fetch", piverifyAnswers({ byId: { [BOUND]: { body: session({ id: BOUND, status: "started" }) } } }))
      signedIn(row({ piverify_session_id: BOUND, piverify_status: "started" }))
      mock.queueRpc(result)
      expect((await refresh.POST(req("/api/courier/kyc/refresh") as never)).status).toBe(500)
    }
  })

  it("answers 429 from courier_kyc_refresh before reading the row or calling PiVerify", async () => {
    const fetchSpy = piverifyAnswers({})
    vi.stubGlobal("fetch", fetchSpy)
    checkLimit.mockImplementation(async () => ({ ok: false as const, reason: "rate_limited", retryAfterSeconds: 60 }))
    mock.queueRpc({ data: [RESOLVED], error: null })
    const res = await refresh.POST(req("/api/courier/kyc/refresh") as never)
    expect(res.status).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })

  it("is 404 off the courier surface, runs the CSRF check, and takes an empty object only", async () => {
    expect((await refresh.POST(req("/api/courier/kyc/refresh", { surface: "pioneer" }) as never)).status).toBe(404)
    expect((await refresh.POST(req("/api/courier/kyc/refresh", { origin: "https://elsewhere.example.test" }) as never)).status).toBe(403)
    expect((await refresh.POST(req("/api/courier/kyc/refresh", { body: { sessionId: BOUND } }) as never)).status).toBe(400)
    expect(mock.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The courier panel and mirroring
// ---------------------------------------------------------------------------

describe("the courier panel", () => {
  const panel = readFileSync("app/courier/courier-panel.tsx", "utf8")

  it("shows the button only on canStartKyc, polls refresh, and navigates to https only", () => {
    expect(panel).toContain("courier.canStartKyc && !waiting")
    expect(panel).toContain('"/api/courier/kyc/start"')
    expect(panel).toContain('"/api/courier/kyc/refresh"')
    expect(panel).toContain("POLL_INTERVAL_MS = 60_000")
    expect(panel).toMatch(/url\.startsWith\("https:\/\/"\)[\s\S]*window\.location\.assign\(url\)/)
  })
})

// CLAUDE.md's mirror scan plus the courier hosts' domain, assembled from
// pieces so this file does not hit the scan itself.
const NETWORK_SCAN = new RegExp(
  ["pinet\\.com", "Test" + "net", "test" + "net", "88" + "41", "36" + "81", "pill" + "gh"].join("|")
)

describe("the files part (c) adds or changes name no network", () => {
  it("so they mirror between repositories as bytes", () => {
    for (const f of [
      "lib/courier-kyc.ts",
      "lib/piverify.ts",
      "app/api/courier/kyc/start/route.ts",
      "app/api/courier/kyc/refresh/route.ts",
      "app/api/courier/me/route.ts",
      "app/api/kyc/webhook/route.ts",
      "app/courier/courier-panel.tsx",
      "tests/routes/courier-kyc.test.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(NETWORK_SCAN)
    }
  })
})
