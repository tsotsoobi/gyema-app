import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { AdminMock, adminModule } from "../helpers/admin-mock"
import { hashDeliveryCode } from "@/lib/delivery-code"
import { MAX_CODE_ATTEMPTS } from "@/lib/guest-claim"

// The legacy courier's job routes on the courier host (Phase 1 item 6 part
// (c), docs/anchoring-phase1-notes.md 6.2 to 6.5):
//
//   POST /api/courier/jobs/accept            { trackingId }
//   POST /api/courier/jobs/mine              {}
//   POST /api/courier/jobs/confirm-delivery  { trackingId, code }
//
// The courier is the session cookie, resolved by courier_session_resolve. A
// legacy courier is matched on assigned_courier_id and NEVER on
// assigned_courier, which a legacy claim leaves null. These pin that, the
// both-null guard on the claim, the ladder, and what each route sends.
//
// The admin mock does not simulate the SQL. Placeholder hosts only, so this
// file names no network and mirrors as bytes.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

type CheckLimit = typeof import("@/lib/rate-limit").checkLimit
const checkLimit = vi.fn<CheckLimit>(async () => ({ ok: true as const }))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>()
  return { ...actual, checkLimit }
})

const accept = await import("@/app/api/courier/jobs/accept/route")
const mine = await import("@/app/api/courier/jobs/mine/route")
const confirm = await import("@/app/api/courier/jobs/confirm-delivery/route")

const HOST = "couriers.example.test"
const TOKEN = "gcs_" + "J".repeat(43)
const COOKIE = `__Host-gyema_courier=${TOKEN}`
const COURIER_ID = "0f1e2d3c-4b5a-4968-8776-655443322110"
const OTHER_ID = "99999999-8888-4777-8666-555555555555"
const JOB = "GYM-A1B2C3"
const CODE = "4821"
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const RESOLVED = {
  courier_id: COURIER_ID,
  status: "full",
  piverify_status: "approved",
  piverify_allowed_action: null,
  kyc_approved_at: "2026-10-01T00:00:00Z",
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
  return new Request(`https://${HOST}${path}`, { method: "POST", headers, body: JSON.stringify(opts.body ?? {}) })
}

const post = {
  accept: (body: unknown = { trackingId: JOB }, opts: Opts = {}) =>
    accept.POST(req("/api/courier/jobs/accept", { ...opts, body }) as never),
  mine: (opts: Opts = {}) => mine.POST(req("/api/courier/jobs/mine", { ...opts, body: {} }) as never),
  confirm: (body: unknown = { trackingId: JOB, code: CODE }, opts: Opts = {}) =>
    confirm.POST(req("/api/courier/jobs/confirm-delivery", { ...opts, body }) as never),
}

function signedIn() {
  mock.queueRpc({ data: [RESOLVED], error: null })
}

function rpcCalls(name?: string) {
  return mock.calls.filter((c) => c.method === "rpc" && (name === undefined || c.args[0] === name))
}

function writes() {
  return mock.calls.filter((c) => ["insert", "update", "delete", "upsert"].includes(c.method))
}

/** The builder calls made after the UPDATE: the claim's own guards. */
function updateGuards(): string[] {
  const at = mock.calls.findIndex((c) => c.method === "update")
  expect(at, "no UPDATE was sent").toBeGreaterThan(-1)
  return mock.trace().slice(at + 1)
}

/** The builder calls between the first from("guest_jobs") and the UPDATE: the claimable read. */
function claimableRead(): string[] {
  const trace = mock.trace()
  const from = trace.indexOf('from("guest_jobs")')
  const update = trace.findIndex((t) => t.startsWith("update("))
  return trace.slice(from, update === -1 ? undefined : update)
}

const CLAIMED = {
  tracking_id: JOB,
  pickup_area: "Osu",
  pickup_landmark: "Near the mall",
  dropoff_area: "Madina",
  dropoff_landmark: null,
  recipient_name: "Ama",
  recipient_phone: "0244000000",
  quote_cedis: 40,
  payment_type: "cash",
  remit_cedis: 3,
}

/** A signed-in courier with this registry row, a claimable job at 40 GHS, and a claim that lands. */
function acceptFixture(row: Record<string, unknown> | null, extra: Array<{ data: unknown; error: unknown }> = []) {
  signedIn()
  mock.queue({ data: row, error: null })
  mock.queue({ data: { quote_cedis: 40 }, error: null })
  mock.queue(...extra)
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  checkLimit.mockReset()
  checkLimit.mockImplementation(async () => ({ ok: true as const }))
  vi.stubEnv("COURIER_HOST", HOST)
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

describe("POST /api/courier/jobs/accept", () => {
  it("claims for a full courier: the courier id, no username, no WhatsApp, both-null guards", async () => {
    acceptFixture({ status: "full", buffer_since: null, shredded_at: null }, [{ data: CLAIMED, error: null }])
    const res = await post.accept()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, job: { tracking_id: JOB, remit_cedis: 3, keeps_cedis: 37 } })
    expect(JSON.stringify(json)).not.toMatch(/delivery_code|sender_phone|declared/)
    expect(res.headers.get("cache-control")).toBe("no-store")

    expect(checkLimit).toHaveBeenCalledWith("courier_accept", COURIER_ID)
    // The registry row is read by the session's courier id.
    expect(mock.trace()).toContain('from("courier_registry")')
    expect(mock.trace()).toContain(`eq("id", "${COURIER_ID}")`)

    const written = writes()[0].args[0] as Record<string, unknown>
    expect(written).toMatchObject({
      status: "accepted",
      assigned_courier: null,
      assigned_courier_id: COURIER_ID,
      assigned_courier_whatsapp: null,
      remit_cedis: 3,
    })

    // Unassigned means BOTH columns null, on the read and on the UPDATE.
    for (const part of [claimableRead(), updateGuards()]) {
      expect(part).toContain('is("assigned_courier", null)')
      expect(part).toContain('is("assigned_courier_id", null)')
    }
    expect(updateGuards()).toContain('eq("status", "posted")')
    expect(updateGuards()).toContain('eq("quote_cedis", 40)')
    // A full claim carries no buffer guard.
    expect(updateGuards().some((t) => t.startsWith("lte("))).toBe(false)
  })

  it("refuses a body with anything beyond the tracking id, before any lookup", async () => {
    for (const body of [
      { trackingId: JOB, accepterWhatsapp: "0244123456" },
      { trackingId: JOB, courierId: OTHER_ID },
      { trackingId: JOB, tier: "full" },
    ]) {
      const res = await post.accept(body)
      expect(res.status).toBe(400)
    }
    expect(rpcCalls()).toEqual([])
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })

  const refusals: Array<[string, Record<string, unknown> | null, string]> = [
    ["no registry row", null, "courier_not_registered"],
    ["a shredded row", { status: "full", buffer_since: null, shredded_at: "2026-10-01T00:00:00Z" }, "unavailable"],
    ["registered", { status: "registered", buffer_since: null, shredded_at: null }, "courier_not_active"],
    ["paused", { status: "paused", buffer_since: null, shredded_at: null }, "courier_not_active"],
    ["buffer with no buffer_since", { status: "buffer", buffer_since: null, shredded_at: null }, "courier_not_active"],
    [
      "buffer at 30 days",
      { status: "buffer", buffer_since: new Date(NOW - 30 * DAY).toISOString(), shredded_at: null },
      "courier_not_active",
    ],
  ]

  for (const [name, row, reason] of refusals) {
    it(`answers 403 ${reason} for ${name}, and never reads the job`, async () => {
      signedIn()
      mock.queue({ data: row, error: null })
      const res = await post.accept()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ ok: false, reason })
      expect(mock.trace()).not.toContain('from("guest_jobs")')
      expect(writes()).toEqual([])
    })
  }

  it("answers 503 auth_unavailable on a registry read error, never 'no row'", async () => {
    signedIn()
    mock.queue({ data: null, error: { code: "08006", message: "down" } })
    const res = await post.accept()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(writes()).toEqual([])
  })

  it("answers not_open, writing nothing, for a job that is not claimable", async () => {
    signedIn()
    mock.queue({ data: { status: "full", buffer_since: null, shredded_at: null }, error: null })
    mock.queue({ data: null, error: null })
    const res = await post.accept()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: "not_open" })
    expect(writes()).toEqual([])
  })

  it("answers not_open when the guarded claim matches nothing", async () => {
    acceptFixture({ status: "full", buffer_since: null, shredded_at: null }, [
      { data: null, error: { code: "PGRST116", message: "no rows" } },
    ])
    const res = await post.accept()
    expect(await res.json()).toEqual({ ok: false, reason: "not_open" })
  })

  const BUFFER = { status: "buffer", buffer_since: new Date(NOW - 10 * DAY).toISOString(), shredded_at: null }

  it("claims for a buffer courier inside 30 days, with the buffer guards in the UPDATE", async () => {
    acceptFixture(BUFFER, [
      { data: { tracking_id: JOB }, error: null },
      { data: CLAIMED, error: null },
    ])
    const res = await post.accept()
    expect(res.status).toBe(200)
    expect(updateGuards()).toContain('lte("declared_value_cedis", 200)')
    expect(updateGuards().filter((t) => t.startsWith("in("))).toHaveLength(2)
    expect(updateGuards()).toContain('is("assigned_courier_id", null)')
  })

  it("answers 403 not_eligible for a buffer courier on a job outside the guards, writing nothing", async () => {
    acceptFixture(BUFFER, [{ data: null, error: null }])
    const res = await post.accept()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "not_eligible" })
    expect(writes()).toEqual([])
  })

  it("is refused at 429 by courier_accept, before the registry is read", async () => {
    signedIn()
    checkLimit.mockImplementation(async () => ({ ok: false as const, reason: "rate_limited", retryAfterSeconds: 60 }))
    const res = await post.accept()
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// mine
// ---------------------------------------------------------------------------

function myJob(overrides: Record<string, unknown> = {}) {
  return {
    tracking_id: JOB,
    pickup_area: "Osu",
    pickup_landmark: null,
    dropoff_area: "Madina",
    dropoff_landmark: null,
    package_size: "small",
    recipient_name: "Ama",
    recipient_phone: "0244000000",
    quote_cedis: 40,
    payment_type: "cash",
    remit_cedis: 4,
    when_pref: "now",
    scheduled_date: null,
    status: "accepted",
    pickup_confirmed_at: null,
    pickup_confirmed_by: null,
    delivery_confirmed_at: null,
    delivery_confirmed_by: null,
    delivery_code_hash: "a".repeat(64),
    ...overrides,
  }
}

describe("POST /api/courier/jobs/mine", () => {
  it("matches on assigned_courier_id, the session's courier, and never on assigned_courier", async () => {
    signedIn()
    mock.queue({ data: [myJob()], error: null })
    const res = await post.mine()
    expect(res.status).toBe(200)
    expect(mock.trace()).toContain(`eq("assigned_courier_id", "${COURIER_ID}")`)
    expect(mock.trace().some((t) => t.startsWith('eq("assigned_courier",'))).toBe(false)
    expect(checkLimit).toHaveBeenCalledWith("courier_me", COURIER_ID)

    const json = await res.json()
    expect(json.jobs[0]).toMatchObject({
      trackingId: JOB,
      recipientName: "Ama",
      recipientPhone: "0244000000",
      remitCedis: 4,
      keepsCedis: 36,
      hasDeliveryCode: true,
    })
    // Nullity only: the hash stops at the route.
    expect(JSON.stringify(json)).not.toContain("a".repeat(64))
    expect(writes()).toEqual([])
  })

  it("withholds the recipient on a cancelled job only", async () => {
    for (const status of ["accepted", "in_transit", "delivered", "expired", "cancelled"]) {
      mock.calls = []
      signedIn()
      mock.queue({ data: [myJob({ status })], error: null })
      const job = (await (await post.mine()).json()).jobs[0]
      const withheld = status === "cancelled"
      expect(job.recipientName, status).toBe(withheld ? null : "Ama")
      expect(job.recipientPhone, status).toBe(withheld ? null : "0244000000")
    }
  })

  it("answers 500 on a read error, and ok with an empty list for no jobs", async () => {
    signedIn()
    mock.queue({ data: null, error: { code: "08006" } })
    expect((await post.mine()).status).toBe(500)
    signedIn()
    mock.queue({ data: [], error: null })
    expect(await (await post.mine()).json()).toEqual({ ok: true, jobs: [] })
  })
})

// ---------------------------------------------------------------------------
// confirm-delivery
// ---------------------------------------------------------------------------

function codedJob(overrides: Record<string, unknown> = {}) {
  return {
    tracking_id: JOB,
    status: "in_transit",
    assigned_courier: null,
    assigned_courier_id: COURIER_ID,
    delivery_confirmed_at: null,
    delivery_confirmed_by: null,
    delivery_code_hash: hashDeliveryCode(CODE),
    delivery_code_attempts: 0,
    ...overrides,
  }
}

describe("POST /api/courier/jobs/confirm-delivery", () => {
  it("stamps courier_code for the courier the job's assigned_courier_id names", async () => {
    signedIn()
    mock.queue({ data: codedJob(), error: null })
    mock.queueRpc({
      data: [{ status: "in_transit", delivery_confirmed_at: "2026-10-11T12:00:00Z", delivery_confirmed_by: "courier_code" }],
      error: null,
    })
    const res = await post.confirm()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      confirmedAt: "2026-10-11T12:00:00Z",
      delivered: false,
      awaitingSender: true,
      awaitingCode: false,
    })
    expect(checkLimit).toHaveBeenCalledWith("courier_confirm", COURIER_ID)
    expect(rpcCalls("guest_stamp_delivery")[0].args[1]).toEqual({ p_tracking_id: JOB, p_via: "courier_code" })
  })

  it("refuses not_assigned when assigned_courier_id is another courier, even with assigned_courier equal to this id", async () => {
    // A route matching on assigned_courier would let this through.
    signedIn()
    mock.queue({ data: codedJob({ assigned_courier: COURIER_ID, assigned_courier_id: OTHER_ID }), error: null })
    const res = await post.confirm()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "not_assigned" })
    expect(rpcCalls("guest_bump_delivery_code_attempts")).toEqual([])
    expect(rpcCalls("guest_stamp_delivery")).toEqual([])
  })

  it("refuses not_assigned for a Pioneer-claimed job, before any attempt is counted", async () => {
    signedIn()
    mock.queue({ data: codedJob({ assigned_courier: "pioneer_one", assigned_courier_id: null }), error: null })
    const res = await post.confirm({ trackingId: JOB, code: "0000" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "not_assigned" })
    expect(rpcCalls("guest_bump_delivery_code_attempts")).toEqual([])
  })

  it("bumps the counter on a wrong code, and locks at the ceiling", async () => {
    signedIn()
    mock.queue({ data: codedJob({ delivery_code_attempts: 1 }), error: null })
    mock.queueRpc({ data: 2, error: null })
    const res = await post.confirm({ trackingId: JOB, code: "0000" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - 2 })

    signedIn()
    mock.queue({ data: codedJob({ delivery_code_attempts: MAX_CODE_ATTEMPTS }), error: null })
    const locked = await post.confirm()
    expect(await locked.json()).toEqual({ ok: false, reason: "code_locked", attemptsLeft: 0 })
  })

  it("refuses a via field, or anything beyond the tracking id and the code", async () => {
    for (const body of [
      { trackingId: JOB, code: CODE, via: "courier_code" },
      { trackingId: JOB, code: CODE, last4: "3456" },
      { trackingId: JOB, code: "12345" },
    ]) {
      expect((await post.confirm(body)).status).toBe(400)
    }
    expect(rpcCalls()).toEqual([])
  })

  it("answers 429 when courier_confirm refuses, before the job is read", async () => {
    signedIn()
    checkLimit.mockImplementation(async () => ({ ok: false as const, reason: "rate_limited", retryAfterSeconds: 120 }))
    const res = await post.confirm()
    expect(res.status).toBe(429)
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// All three
// ---------------------------------------------------------------------------

describe("every jobs route", () => {
  const calls: Array<[string, (o: Opts) => Promise<Response>]> = [
    ["accept", (o) => post.accept({ trackingId: JOB }, o)],
    ["mine", (o) => post.mine(o)],
    ["confirm-delivery", (o) => post.confirm({ trackingId: JOB, code: CODE }, o)],
  ]

  for (const [name, call] of calls) {
    it(`${name}: 404 off the courier surface, 403 on a foreign Origin, 401 without a cookie, all without a lookup`, async () => {
      expect((await call({ surface: "pioneer" })).status).toBe(404)
      expect((await call({ origin: "https://evil.example.test" })).status).toBe(403)
      expect((await call({ cookie: null })).status).toBe(401)
      expect(rpcCalls()).toEqual([])
      expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
    })
  }

  it("share one attempt ceiling with the Pioneer route: MAX_CODE_ATTEMPTS is defined in lib/guest-claim.ts only", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e).replace(/\\/g, "/")
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e) ? [p] : []
      })
    const defining = [...walk("app"), ...walk("lib")].filter((f) =>
      /\bMAX_CODE_ATTEMPTS\s*=/.test(readFileSync(f, "utf8"))
    )
    expect(defining).toEqual(["lib/guest-claim.ts"])
    for (const f of ["app/api/guest/confirm-delivery/route.ts", "app/api/courier/jobs/confirm-delivery/route.ts"]) {
      expect(readFileSync(f, "utf8"), f).toContain("confirmCourierCode(")
    }
  })

  it("never match a job on assigned_courier (static)", () => {
    const dir = "app/api/courier/jobs"
    const files = readdirSync(dir).flatMap((d) => {
      const p = join(dir, d, "route.ts")
      return statSync(join(dir, d)).isDirectory() ? [p] : []
    })
    expect(files).toHaveLength(3)
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/\.eq\(\s*["']assigned_courier["']/)
      expect(src, f).not.toMatch(/column:\s*["']assigned_courier["']/)
    }
  })
})

// ---------------------------------------------------------------------------
// Item 10, option B: the accept route reads the two operator columns
// ---------------------------------------------------------------------------

describe("POST /api/courier/jobs/accept, item 10", () => {
  it("reads operator_checked_at and operator_check_deadline, never operator_checked_by", async () => {
    acceptFixture({ status: "full", buffer_since: null, shredded_at: null }, [{ data: CLAIMED, error: null }])
    await post.accept()
    expect(mock.trace()).toContain('select("status, buffer_since, shredded_at, operator_checked_at, operator_check_deadline")')
    expect(mock.trace().join("\n")).not.toContain("operator_checked_by")
  })

  it("a courier in buffer through the check claims on day 40 while no deadline is set, under the buffer guards", async () => {
    const t = new Date(NOW - 40 * DAY).toISOString()
    acceptFixture(
      { status: "buffer", buffer_since: t, shredded_at: null, operator_checked_at: t, operator_check_deadline: null },
      [{ data: CLAIMED, error: null }]
    )
    const res = await post.accept()
    expect(res.status).toBe(200)
    expect(updateGuards().some((g) => g.startsWith("lte("))).toBe(true)
  })

  it("is refused courier_not_active at and after the deadline, without reading the job", async () => {
    const t = new Date(NOW - 10 * DAY).toISOString()
    for (const deadline of [new Date(NOW).toISOString(), new Date(NOW - DAY).toISOString()]) {
      mock.calls = []
      signedIn()
      mock.queue({
        data: { status: "buffer", buffer_since: t, shredded_at: null, operator_checked_at: t, operator_check_deadline: deadline },
        error: null,
      })
      const res = await post.accept()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ ok: false, reason: "courier_not_active" })
      expect(mock.trace()).not.toContain('from("guest_jobs")')
    }
  })
})
