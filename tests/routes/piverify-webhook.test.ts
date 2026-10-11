import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { AdminMock, adminModule } from "../helpers/admin-mock"

// POST /api/kyc/webhook.
//
// What these tests pin is the order of trust: the HMAC before anything, the
// re-fetched session over the payload, and nothing written unless PiVerify
// answered. What happens to a row (forward only, once per event, once per
// approval) lives in courier_apply_kyc_status and is tested against a real
// postgres, not here: the admin mock does not simulate the database.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const webhook = await import("@/app/api/kyc/webhook/route")

const SECRET = "whsec_test_only_not_a_real_secret"
const SESSION = "sess_0123456789"
const COURIER = "00000000-0000-4000-8000-000000000001"

function sign(raw: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
}

function event(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "kyc.session.approved",
    created_at: "2026-10-08T10:00:00Z",
    data: {
      session_id: SESSION,
      external_user_id: COURIER,
      status: "approved",
      rejection_reason: null,
      ...data,
    },
    ...overrides,
  }
}

function request(body: unknown, signature?: string | null): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const headers: Record<string, string> = { "content-type": "application/json" }
  const sig = signature === undefined ? sign(raw) : signature
  if (sig !== null) headers["x-piverify-signature"] = sig
  return new Request("http://localhost/api/kyc/webhook", { method: "POST", headers, body: raw })
}

/** PiVerify's GET /kyc_sessions/:id, answering with the given session. */
function piverifyAnswers(session: Record<string, unknown>, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(session), { status, headers: { "content-type": "application/json" } })
  )
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    external_user_id: COURIER,
    status: "started",
    hosted_flow_url: "https://example.invalid/flow",
    rejection_reason: null,
    created_at: "2026-10-08T09:00:00Z",
    updated_at: "2026-10-08T10:00:00Z",
    ...overrides,
  }
}

const rpcCalls = () => mock.calls.filter((c) => c.method === "rpc")

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  vi.unstubAllEnvs()
  vi.stubEnv("PIVERIFY_WEBHOOK_SECRET", SECRET)
  vi.stubEnv("PIVERIFY_API_BASE_URL", "https://piverify.example.invalid/")
  vi.stubEnv("PIVERIFY_API_KEY", "sbx_test_only")
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("POST /api/kyc/webhook: before anything is trusted", () => {
  it("refuses with 500 when the secret is not configured, and fetches nothing", async () => {
    vi.stubEnv("PIVERIFY_WEBHOOK_SECRET", "")
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls()).toHaveLength(0)
  })

  it("refuses a missing signature with 401, and fetches and writes nothing", async () => {
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    const res = await webhook.POST(request(event(), null) as never)
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls()).toHaveLength(0)
  })

  it("refuses a signature made with another key", async () => {
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    const raw = JSON.stringify(event())
    const res = await webhook.POST(request(raw, sign(raw, "some_other_key")) as never)
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses a body altered after signing", async () => {
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    const original = JSON.stringify(event())
    const tampered = JSON.stringify(event({}, { status: "approved", external_user_id: "someone-else" }))
    const res = await webhook.POST(request(tampered, sign(original)) as never)
    expect(res.status).toBe(401)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("refuses a signed body that is not JSON, or not the schema, with 400", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    expect((await webhook.POST(request("not json") as never)).status).toBe(400)
    expect((await webhook.POST(request(event({ id: "" })) as never)).status).toBe(400)
    expect((await webhook.POST(request({ id: "evt_1", type: "x", data: {} }) as never)).status).toBe(400)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("refuses an event id in the poll namespace with 400, before any read, fetch or write", async () => {
    // POST /api/courier/kyc/refresh records under poll:<session>:... ids with
    // type poll (item 5, 5.4). A delivered event must never occupy them, even
    // a correctly signed one.
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    const ids = [`poll:${SESSION}:started:-:2026-10-08T10:00:00Z`, "poll:", "  poll:x"]
    for (const id of ids) {
      const res = await webhook.POST(request(event({ id })) as never)
      expect(res.status, id).toBe(400)
      expect(await res.json()).toEqual({ ok: false, reason: "bad_payload" })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mock.calls).toEqual([])
  })

  it("refuses an event type of poll with 400, before any read, fetch or write", async () => {
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    for (const type of ["poll", " poll "]) {
      const res = await webhook.POST(request(event({ type })) as never)
      expect(res.status, type).toBe(400)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mock.calls).toEqual([])
  })

  it("still takes an event id that merely contains poll", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "registered" }], error: null })
    const res = await webhook.POST(request(event({ id: "evt_poll:1", type: "kyc.session.polling" })) as never)
    expect(res.status).toBe(200)
    expect(rpcCalls()).toHaveLength(1)
  })
})

describe("POST /api/kyc/webhook: the re-fetched session is the truth", () => {
  it("acts on PiVerify's current status, not the payload's", async () => {
    // The payload claims approved. PiVerify says the session is only started.
    const fetchSpy = piverifyAnswers(session({ status: "started" }))
    vi.stubGlobal("fetch", fetchSpy)
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "registered" }], error: null })

    const res = await webhook.POST(request(event({}, { status: "approved" })) as never)
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(
      `https://piverify.example.invalid/api/v1/kyc_sessions/${SESSION}`
    )
    const [name, params] = rpcCalls()[0].args as [string, Record<string, unknown>]
    expect(name).toBe("courier_apply_kyc_status")
    expect(params).toEqual({
      p_event_id: "evt_1",
      p_event_type: "kyc.session.approved",
      p_session_id: SESSION,
      p_external_user_id: COURIER,
      p_status: "started",
      p_allowed_action: null,
    })
  })

  it("passes allowed_action from the re-fetched session", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session({ status: "rejected", allowed_action: "RESUBMIT" })))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "paused" }], error: null })
    const res = await webhook.POST(request(event({ type: "kyc.session.rejected" })) as never)
    expect(res.status).toBe(200)
    const params = rpcCalls()[0].args[1] as Record<string, unknown>
    expect(params.p_status).toBe("rejected")
    expect(params.p_allowed_action).toBe("RESUBMIT")
  })

  it("never takes allowed_action from the payload", async () => {
    // The payload offers an appeal. PiVerify says the rejection is final.
    vi.stubGlobal("fetch", piverifyAnswers(session({ status: "rejected" })))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "paused" }], error: null })
    await webhook.POST(
      request(event({ type: "kyc.session.rejected" }, { status: "rejected", allowed_action: "APPEAL" })) as never
    )
    const params = rpcCalls()[0].args[1] as Record<string, unknown>
    expect(params.p_allowed_action).toBeNull()
  })

  it("takes external_user_id from the re-fetched session, not the payload", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session({ external_user_id: COURIER })))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "registered" }], error: null })
    await webhook.POST(request(event({}, { external_user_id: "attacker-chosen" })) as never)
    const params = rpcCalls()[0].args[1] as Record<string, unknown>
    expect(params.p_external_user_id).toBe(COURIER)
  })

  it("answers 503 and writes nothing when PiVerify cannot be asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }))
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(503)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("answers 503 and writes nothing when PiVerify answers with an error", async () => {
    vi.stubGlobal("fetch", piverifyAnswers({ error: "boom" }, 502))
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(503)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("answers 503 and writes nothing when the session comes back malformed", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session({ status: "teleported" })))
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(503)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("answers 503 and writes nothing when the session carries an unknown allowed_action", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session({ status: "rejected", allowed_action: "MAYBE" })))
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(503)
    expect(rpcCalls()).toHaveLength(0)
  })

  it("ignores, with 200 and no write, a re-fetch that returns a different session", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session({ id: "sess_other" })))
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" })
    expect(rpcCalls()).toHaveLength(0)
  })
})

describe("POST /api/kyc/webhook: what the function says", () => {
  it("passes a duplicate through as 200", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [{ outcome: "duplicate", courier_status: "full" }], error: null })
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: "duplicate" })
  })

  it("passes not_forward through as 200, so PiVerify stops retrying", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [{ outcome: "not_forward", courier_status: "full" }], error: null })
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(200)
  })

  it("answers 503 for session_not_bound, so PiVerify retries", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [{ outcome: "session_not_bound", courier_status: "registered" }], error: null })
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(503)
  })

  it("answers 500 when the function errors, so the rolled back event is retried", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: null, error: { message: "boom", code: "XX000" } })
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(500)
  })

  it("answers 500 when the function returns no row", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [], error: null })
    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(500)
  })

  it("never writes a table directly: the function is the only write path", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    mock.queueRpc({ data: [{ outcome: "applied", courier_status: "buffer" }], error: null })
    await webhook.POST(request(event()) as never)
    // One read, of the processed-event record. Nothing else.
    expect(mock.calls.filter((c) => c.method === "from").map((c) => c.args[0])).toEqual(["piverify_events"])
    for (const write of ["insert", "update", "upsert", "delete"]) {
      expect(mock.calls.filter((c) => c.method === write)).toHaveLength(0)
    }
  })
})

describe("POST /api/kyc/webhook: a replay costs no outbound call", () => {
  it("answers a stored event id as duplicate without calling PiVerify or the function", async () => {
    const fetchSpy = piverifyAnswers(session({ status: "approved" }))
    vi.stubGlobal("fetch", fetchSpy)
    mock.queue({ data: { event_id: "evt_1" }, error: null })

    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: "duplicate" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls()).toHaveLength(0)
    expect(mock.trace()).toEqual([
      'from("piverify_events")',
      'select("event_id")',
      'eq("event_id", "evt_1")',
      "maybeSingle()",
    ])
  })

  it("answers 500 without calling PiVerify when the record cannot be read", async () => {
    const fetchSpy = piverifyAnswers(session())
    vi.stubGlobal("fetch", fetchSpy)
    mock.queue({ data: null, error: { message: "boom", code: "XX000" } })

    const res = await webhook.POST(request(event()) as never)
    expect(res.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpcCalls()).toHaveLength(0)
  })

  it("does not read the record before the signature is checked", async () => {
    vi.stubGlobal("fetch", piverifyAnswers(session()))
    await webhook.POST(request(event(), null) as never)
    expect(mock.calls).toHaveLength(0)
  })
})

describe("the route source", () => {
  const source = readFileSync("app/api/kyc/webhook/route.ts", "utf8")

  it("never reads the payload's status, external_user_id or allowed_action", () => {
    expect(source).not.toMatch(/data\.status/)
    expect(source).not.toMatch(/data\.external_user_id/)
    expect(source).not.toMatch(/data\.allowed_action/)
    expect(source).toContain("p_allowed_action: session.allowed_action ?? null")
    expect(source).not.toMatch(/event\??\.data/)
  })

  it("no longer references the orphan tables, and reads only the event record", () => {
    expect(source).not.toMatch(/legacy_couriers/)
    expect(source.match(/\.from\("[a-z_]+"\)/g)).toEqual(['.from("piverify_events")'])
    expect(source).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    expect(readFileSync("lib/piverify.ts", "utf8")).not.toMatch(/legacy_couriers/)
  })

  it("carries the founder review marker", () => {
    expect(source).toContain("ATTESTATION WRITE: founder review required")
  })

  it("keeps upstream response bodies out of thrown errors", () => {
    const lib = readFileSync("lib/piverify.ts", "utf8")
    expect(lib).not.toMatch(/res\.text\(\)/)
  })
})
