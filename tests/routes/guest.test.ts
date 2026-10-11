import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { NextRequest } from "next/server"
import { AdminMock, adminModule, get, postJson } from "../helpers/admin-mock"

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const create = await import("@/app/api/guest/create/route")
const track = await import("@/app/api/guest/track/route")
const open = await import("@/app/api/guest/open/route")
const accept = await import("@/app/api/guest/accept/route")
const mine = await import("@/app/api/guest/mine/route")
const deliveryCode = await import("@/app/api/guest/delivery-code/route")
const confirmPickup = await import("@/app/api/guest/confirm-pickup/route")
const confirmDelivery = await import("@/app/api/guest/confirm-delivery/route")

const JOB = "GYM-A1B2C3"

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_GUEST_SEND_ENABLED", "true")
})

describe("POST /api/guest/create", () => {
  it("is closed when the flag is not exactly true", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUEST_SEND_ENABLED", "")
    const res = await create.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(403)
  })

  it("rejects a missing required field", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", { pickupArea: "Osu", packageSize: "small" }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "bad_request" })
  })

  it("rejects an area outside the bounded list", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Atlantis",
        dropoffArea: "Osu",
        packageSize: "small",
        senderPhone: "0244123456",
        declaredValueCedis: 150,
      }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "unbounded_city" })
  })

  it("rejects a package size outside the enum", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "enormous",
        senderPhone: "0244123456",
        declaredValueCedis: 150,
        offList: true,
      }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "bad_size" })
  })

  it("writes an unverified draft and returns only the tracking id and status", async () => {
    mock.queue(
      { data: null, error: null },
      { data: null, error: null },
      { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
    )
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "small",
        senderPhone: "0244123456",
        declaredValueCedis: 150,
        contentsNote: "  a note  ",
        offList: true,
      }) as never
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["ok", "status", "trackingId"])

    const insert = mock.calls.find((c) => c.method === "insert")
    const row = insert?.args[0] as Record<string, unknown>
    // phone_verified is false on every insert. Nothing in this codebase flips
    // it: the operator does that by hand in the Supabase dashboard.
    expect(row.phone_verified).toBe(false)
    // Free text is trimmed before it is stored, which is the fix for the
    // untrimmed area values found live on 21 August.
    expect(row.contents_note).toBe("a note")
    // Status is server derived, never taken from the body.
    expect(row.status).toBe("pending_quote")
  })

  // Item 7: the declared value. Required on every new job, refused above the
  // pilot cap, written server side, and never sent back (lib/declared-value.ts).
  describe("declared value", () => {
    const LISTED = {
      pickupArea: "Osu",
      dropoffArea: "Madina",
      packageSize: "small",
      senderPhone: "0244123456",
    }
    const OFF_LIST = {
      pickupArea: "Anywhere",
      dropoffArea: "Anywhere else",
      packageSize: "small",
      senderPhone: "0244123456",
      offList: true,
    }

    function queueCreate(status: string) {
      mock.queue(
        { data: null, error: null },
        { data: null, error: null },
        { data: { tracking_id: JOB, status }, error: null }
      )
    }

    it("writes it on a listed job, and only reads back the two fields the response uses", async () => {
      queueCreate("posted")
      const res = await create.POST(
        postJson("http://localhost/x", { ...LISTED, declaredValueCedis: 350 }) as never
      )
      expect(res.status).toBe(200)
      const row = mock.calls.find((c) => c.method === "insert")?.args[0] as Record<string, unknown>
      expect(row.declared_value_cedis).toBe(350)
      const selects = mock.calls.filter((c) => c.method === "select").map((c) => c.args)
      expect(selects).toContainEqual(["tracking_id, status"])
      // No bare select(), which would read the whole row back.
      expect(selects).not.toContainEqual([])
    })

    it("writes it on an off-list job too", async () => {
      queueCreate("pending_quote")
      const res = await create.POST(
        postJson("http://localhost/x", { ...OFF_LIST, declaredValueCedis: 0 }) as never
      )
      expect(res.status).toBe(200)
      const row = mock.calls.find((c) => c.method === "insert")?.args[0] as Record<string, unknown>
      expect(row.declared_value_cedis).toBe(0)
    })

    it("accepts the cap itself", async () => {
      queueCreate("posted")
      const res = await create.POST(
        postJson("http://localhost/x", { ...LISTED, declaredValueCedis: 500 }) as never
      )
      expect(res.status).toBe(200)
    })

    it("never puts it in the response", async () => {
      queueCreate("posted")
      const res = await create.POST(
        postJson("http://localhost/x", { ...LISTED, declaredValueCedis: 432 }) as never
      )
      const text = await res.text()
      expect(text).not.toContain("432")
      expect(text).not.toMatch(/declared/i)
    })

    it("refuses above the cap with its own reason, and writes nothing", async () => {
      const res = await create.POST(
        postJson("http://localhost/x", { ...LISTED, declaredValueCedis: 501 }) as never
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, reason: "declared_value_over_cap" })
      expect(mock.calls).toHaveLength(0)
    })

    for (const [label, value] of [
      ["missing", undefined],
      ["null", null],
      ["negative", -1],
      ["fractional", 1.5],
      ["a string", "150"],
    ] as const) {
      it(`refuses a value that is ${label}, and writes nothing`, async () => {
        const body: Record<string, unknown> = { ...OFF_LIST }
        if (value !== undefined) body.declaredValueCedis = value
        const res = await create.POST(postJson("http://localhost/x", body) as never)
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ ok: false, reason: "invalid_declared_value" })
        expect(mock.calls).toHaveLength(0)
      })
    }
  })
})

describe("GET /api/guest/track", () => {
  it("rejects a malformed tracking id", async () => {
    const req = new NextRequest("http://localhost/api/guest/track?trackingId=nope")
    const res = await track.GET(req)
    expect(res.status).toBe(400)
  })

  it("does not resolve an unverified draft", async () => {
    mock.queue({ data: null, error: null })
    const req = new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`)
    const res = await track.GET(req)
    expect(res.status).toBe(404)
    expect(mock.trace()).toContain('eq("phone_verified", true)')
  })

  it("returns a sanitized payload and never a phone, name, landmark or code", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        pickup_area: "Osu",
        dropoff_area: "Madina",
        status: "in_transit",
        created_at: "2026-09-01T00:00:00Z",
        assigned_courier: "courier_one",
        pickup_confirmed_at: null,
        delivery_confirmed_at: null,
        delivery_confirmed_by: null,
        delivery_code_hash: "abc123",
      },
      error: null,
    })
    const req = new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`)
    const res = await track.GET(req)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain("abc123")
    expect(JSON.parse(text).job.hasDeliveryCode).toBe(true)
    const selected = mock.selectedColumns()
    for (const forbidden of [
      "sender_phone",
      "recipient_phone",
      "recipient_name",
      "landmark",
      "quote_cedis",
    ]) {
      expect(selected).not.toContain(forbidden)
    }
  })

  // Item 8, 8.1: courier identity out, courierAssigned in. courierAssigned is
  // true when assigned_courier IS NOT NULL OR assigned_courier_id IS NOT NULL,
  // false when both are null, and neither column nor any value from them is
  // in the response.
  describe("courierAssigned", () => {
    const USERNAME = "pioneer_fixture_user"
    const COURIER_ID = "0b7e3c1a-5d2f-4a8e-9c61-3f2d8e7a9b10"

    async function trackRow(assigned_courier: string | null, assigned_courier_id: string | null) {
      mock.queue({
        data: {
          tracking_id: JOB,
          pickup_area: "Osu",
          dropoff_area: "Madina",
          status: "accepted",
          created_at: "2026-10-01T00:00:00Z",
          assigned_courier,
          assigned_courier_id,
          pickup_confirmed_at: null,
          delivery_confirmed_at: null,
          delivery_confirmed_by: null,
          delivery_code_hash: null,
        },
        error: null,
      })
      const res = await track.GET(
        new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`)
      )
      expect(res.status).toBe(200)
      const text = await res.text()
      return { text, job: JSON.parse(text).job as Record<string, unknown> }
    }

    function expectNoCourierIdentity(text: string, job: Record<string, unknown>) {
      expect(text).not.toContain(USERNAME)
      expect(text).not.toContain(COURIER_ID)
      expect(job).not.toHaveProperty("assignedCourier")
      expect(job).not.toHaveProperty("assigned_courier")
      expect(job).not.toHaveProperty("assigned_courier_id")
      expect(job).not.toHaveProperty("assignedCourierId")
    }

    it("is true on a Pioneer row claimed after item 6 (both columns set), with no username or id", async () => {
      const { text, job } = await trackRow(USERNAME, COURIER_ID)
      expect(job.courierAssigned).toBe(true)
      expectNoCourierIdentity(text, job)
    })

    it("is true on a Pioneer row claimed before item 6 (assigned_courier set, assigned_courier_id null), with no username", async () => {
      const { text, job } = await trackRow(USERNAME, null)
      expect(job.courierAssigned).toBe(true)
      expectNoCourierIdentity(text, job)
    })

    it("is true on a legacy row (assigned_courier null, assigned_courier_id set), with no id", async () => {
      const { text, job } = await trackRow(null, COURIER_ID)
      expect(job.courierAssigned).toBe(true)
      expectNoCourierIdentity(text, job)
    })

    it("is false when assigned_courier and assigned_courier_id are both null", async () => {
      const { text, job } = await trackRow(null, null)
      expect(job.courierAssigned).toBe(false)
      expectNoCourierIdentity(text, job)
    })

    it("selects assigned_courier and assigned_courier_id by name, never a bare or star select", async () => {
      await trackRow(null, null)
      const selected = mock.selectedColumns()
      expect(selected).toMatch(/\bassigned_courier\b/)
      expect(selected).toContain("assigned_courier_id")
      const selects = mock.calls.filter((c) => c.method === "select").map((c) => c.args)
      expect(selects).not.toContainEqual([])
      expect(selected).not.toContain("*")
    })

    it("pins in source that the route emits no courier field", () => {
      const src = readFileSync("app/api/guest/track/route.ts", "utf8")
      expect(src).not.toMatch(/assignedCourier\s*:/)
      expect(src).not.toMatch(/:\s*data\.assigned_courier(_id)?\s*,/)
    })
  })
})

describe("GET /api/guest/open", () => {
  it("lists only verified, posted, unassigned jobs and no contact data", async () => {
    mock.queue({
      data: [{ tracking_id: JOB, pickup_area: "Osu", dropoff_area: "Madina" }],
      error: null,
    })
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('eq("phone_verified", true)')
    expect(trace).toContain('eq("status", "posted")')
    expect(trace).toContain('is("assigned_courier", null)')
    const selected = mock.selectedColumns()
    expect(selected).not.toContain("sender_phone")
    expect(selected).not.toContain("delivery_code_hash")
  })

  // Item 6: a legacy claim leaves assigned_courier null, so unassigned means
  // both columns null.
  it("leaves a job a legacy courier claimed off the board", async () => {
    mock.queue({ data: [], error: null })
    await open.GET(get("http://localhost/api/guest/open") as never)
    const trace = mock.trace()
    expect(trace).toContain('is("assigned_courier", null)')
    expect(trace).toContain('is("assigned_courier_id", null)')
  })

  // Off-list option (a): accept refuses a job with no quote, so the board
  // never shows one.
  it("leaves a posted job with no quote off the board", async () => {
    mock.queue({ data: [], error: null })
    await open.GET(get("http://localhost/api/guest/open") as never)
    expect(mock.trace()).toContain('gt("quote_cedis", 0)')
  })

  it("previews the courier's split from the server function, never a remit column", async () => {
    mock.queue({
      data: [
        { tracking_id: JOB, quote_cedis: 50 },
        { tracking_id: "GYM-D4E5F6", quote_cedis: 25 },
      ],
      error: null,
    })
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    const { jobs } = await res.json()
    expect(jobs[0]).toMatchObject({ quoteCedis: 50, commissionCedis: 4, keepsCedis: 46, commissionRateLabel: "7.5%" })
    expect(jobs[1]).toMatchObject({ quoteCedis: 25, commissionCedis: 2, keepsCedis: 23, commissionRateLabel: "7.5%" })
    expect(mock.selectedColumns()).not.toContain("remit_")
  })
})

/** courier_find_pioneer's answer for a registered courier: one row, as PostgREST returns a table. */
function registry(row: Record<string, unknown>) {
  return {
    data: [{ id: "reg-1", buffer_since: null, paused_reason: null, kyc_approved_at: null, vouched_at: null, ...row }],
    error: null,
  }
}

const FULL = registry({ status: "full", vouched_at: "2026-10-10T09:00:00Z" })

describe("POST /api/guest/accept", () => {
  // Every Pioneer below is a registered full courier (item 6, decision A), so
  // the behaviour before the ladder stays pinned for exactly that courier.
  beforeEach(() => {
    mock.queueRpc(FULL)
  })

  it("rejects an unresolvable session token", async () => {
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "bad", trackingId: JOB }) as never
    )
    expect(res.status).toBe(401)
  })

  it("claims only a verified, posted, unassigned job and never selects sender_phone", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null })
    mock.queue({ data: { tracking_id: JOB, recipient_name: "Ama" }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('eq("status", "posted")')
    expect(trace).toContain('eq("phone_verified", true)')
    expect(trace).toContain('is("assigned_courier", null)')
    expect(mock.selectedColumns()).not.toContain("sender_phone")
    expect(mock.selectedColumns()).not.toContain("delivery_code_hash")
  })

  // S-4, now closed. The plaintext code used to be in this response, on the
  // reasoning that the client mapper dropped it. That is a UI decision, not a
  // control: it was one glance at a network tab away, hours before the courier
  // reached any door.
  it("never returns the delivery code to the accepter", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null })
    mock.queue({ data: { tracking_id: JOB }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.ok).toBe(true)
    expect(body.deliveryCode).toBeUndefined()
    // Not under another name either: no bare four digit string anywhere in it.
    expect(text).not.toMatch(/[0-9]{4}/)
  })

  it("still stores the hash, so the sender can be shown the code later", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null })
    mock.queue({ data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const update = mock.calls.find((c) => c.method === "update")
    const row = update?.args[0] as Record<string, unknown>
    expect(typeof row.delivery_code_hash).toBe("string")
    expect((row.delivery_code_hash as string).length).toBe(64)
  })

  // The commission is computed on the server from the quote on the row, and
  // written in the same UPDATE that assigns the courier.
  it("writes remit_cedis from the quote it read, in the claim itself, guarded on that quote", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue(
      { data: { quote_cedis: 70 }, error: null },
      { data: { tracking_id: JOB, quote_cedis: 70, remit_cedis: 5.5, payment_type: "momo" }, error: null }
    )
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const updates = mock.calls.filter((c) => c.method === "update")
    expect(updates).toHaveLength(1)
    const row = updates[0].args[0] as Record<string, unknown>
    expect(row.remit_cedis).toBe(5.5)
    expect(row.assigned_courier).toBe("courier_one")
    // The guard on the quote comes after the update, on the same statement.
    const trace = mock.trace()
    const updateAt = trace.findIndex((t) => t.startsWith("update("))
    expect(trace.indexOf('eq("quote_cedis", 70)')).toBeGreaterThan(updateAt)
    // The figures returned are the ones written, not a recomputation.
    const { job } = await res.json()
    expect(job).toMatchObject({ quote_cedis: 70, remit_cedis: 5.5, keeps_cedis: 64.5, commission_rate_label: "7.5%" })
  })

  it("takes no commission figure from the request body", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        trackingId: JOB,
        remitCedis: 0,
        remit_cedis: 0,
        quoteCedis: 1000,
      }) as never
    )
    // GuestAcceptBody is not strict, so the extra fields are stripped and the
    // claim runs. The write carries the server's figure for the quote it read.
    const row = mock.calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>
    expect(row.remit_cedis).toBe(3)
    expect(mock.trace().join(" ")).not.toContain("1000")
  })

  it("refuses a job with no quote and writes nothing", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: null }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("refuses a job that is not claimable and writes nothing", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: null, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("refuses when the quote changed between the read and the claim", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    // The read sees 40. The guarded update then matches nothing, which is what
    // PostgREST reports as an error on .single().
    mock.queue(
      { data: { quote_cedis: 40 }, error: null },
      { data: null, error: { code: "PGRST116", message: "no rows" } }
    )
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.trace()).toContain('eq("quote_cedis", 40)')
  })

  it("returns remit_cedis but no other remit column", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const selected = mock.selectedColumns()
    expect(selected).toContain("remit_cedis")
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_paid_at", "remit_ref"]) {
      expect(selected).not.toContain(hidden)
    }
  })
})

describe("POST /api/guest/accept: the courier registry and the ladder (item 6)", () => {
  const body = () => postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
  const DAY = 24 * 60 * 60 * 1000
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()

  function updates() {
    return mock.calls.filter((c) => c.method === "update")
  }

  it("looks the courier up by the session's pi_username, and by nothing in the body", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(FULL)
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        trackingId: JOB,
        pi_username: "someone_else",
        courierId: "reg-forged",
        tier: "full",
      }) as never
    )
    const rpc = mock.calls.filter((c) => c.method === "rpc")
    expect(rpc).toHaveLength(1)
    expect(rpc[0].args).toEqual(["courier_find_pioneer", { p_pi_username: "courier_one" }])
    expect(mock.trace().join(" ")).not.toContain("someone_else")
    expect(mock.trace().join(" ")).not.toContain("reg-forged")
  })

  it("does not look anyone up for an unresolvable token", async () => {
    const res = await accept.POST(body())
    expect(res.status).toBe(401)
    expect(mock.calls.some((c) => c.method === "rpc")).toBe(false)
  })

  it("answers 503 auth_unavailable on a lookup error, never falling through to no row, and reads nothing", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc({ data: null, error: { code: "PGRST202", message: "function not found" } })
    const res = await accept.POST(body())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(mock.calls.some((c) => c.method === "from")).toBe(false)
  })

  it("answers 503 when the lookup returns something that is not a table, or more than one row", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc({ data: { id: "reg-1", status: "full" }, error: null })
    expect((await accept.POST(body())).status).toBe(503)
    mock.queueRpc({ data: [{ id: "a", status: "full" }, { id: "b", status: "full" }], error: null })
    expect((await accept.POST(body())).status).toBe(503)
    expect(mock.calls.some((c) => c.method === "from")).toBe(false)
  })

  it("refuses a Pioneer with no registry row: 403 courier_not_registered, nothing read or written", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc({ data: [], error: null })
    const res = await accept.POST(body())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "courier_not_registered" })
    expect(mock.calls.some((c) => c.method === "from")).toBe(false)
  })

  it("treats a null lookup result as no row, never as registered", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc({ data: null, error: null })
    const res = await accept.POST(body())
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "courier_not_registered" })
  })

  const notActive: Array<[string, Record<string, unknown>]> = [
    ["registered", { status: "registered" }],
    ["paused", { status: "paused", paused_reason: "operator" }],
    ["buffer with no buffer_since", { status: "buffer", buffer_since: null }],
    ["buffer for 30 days", { status: "buffer", buffer_since: daysAgo(30) }],
    ["unknown-status", { status: "gold" }],
  ]
  for (const [label, row] of notActive) {
    it(`refuses a ${label} courier: 403 courier_not_active, nothing read or written`, async () => {
      mock.asPioneer("pi-uid-1", "courier_one")
      mock.queueRpc(registry(row))
      const res = await accept.POST(body())
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ ok: false, reason: "courier_not_active" })
      expect(mock.calls.some((c) => c.method === "from")).toBe(false)
    })
  }

  it("writes the registry id beside the username, and guards the read and the claim on both columns null", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(registry({ id: "reg-77", status: "full" }))
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    const res = await accept.POST(body())
    expect(res.status).toBe(200)
    const row = updates()[0].args[0] as Record<string, unknown>
    expect(row.assigned_courier).toBe("courier_one")
    expect(row.assigned_courier_id).toBe("reg-77")
    expect(row.status).toBe("accepted")
    const trace = mock.trace()
    const updateAt = trace.findIndex((t) => t.startsWith("update("))
    // Once on the read, once on the claim.
    expect(trace.filter((t) => t === 'is("assigned_courier_id", null)')).toHaveLength(2)
    expect(trace.lastIndexOf('is("assigned_courier_id", null)')).toBeGreaterThan(updateAt)
    expect(trace.lastIndexOf('is("assigned_courier", null)')).toBeGreaterThan(updateAt)
  })

  it("adds no buffer guard and no extra read for a full courier", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(FULL)
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(body())
    const trace = mock.trace()
    expect(trace.filter((t) => t.startsWith("from("))).toHaveLength(2)
    expect(trace.some((t) => t.startsWith("in(") || t.startsWith("lte("))).toBe(false)
  })

  it("claims for a buffer courier inside 30 days, with the buffer guards in the claim UPDATE itself", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(registry({ status: "buffer", buffer_since: daysAgo(29) }))
    mock.queue(
      { data: { quote_cedis: 40 }, error: null },
      { data: { tracking_id: JOB }, error: null }, // the eligibility read
      { data: { tracking_id: JOB }, error: null } // the claim
    )
    const res = await accept.POST(body())
    expect(res.status).toBe(200)
    const trace = mock.trace()
    const after = trace.slice(trace.findIndex((t) => t.startsWith("update(")))
    expect(after.some((t) => t.startsWith('in("pickup_area", ['))).toBe(true)
    expect(after.some((t) => t.startsWith('in("dropoff_area", ['))).toBe(true)
    expect(after).toContain('lte("declared_value_cedis", 200)')
    // The bounded list, exact names: an untrimmed off-list value is not on it.
    const areas = mock.calls.find((c) => c.method === "in" && c.args[0] === "pickup_area")?.args[1] as string[]
    expect(areas).toContain("Osu")
    expect(areas).not.toContain("Asylum down ")
  })

  it("refuses a buffer courier on a job outside the guards: 403 not_eligible, one reason, nothing written", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(registry({ status: "buffer", buffer_since: daysAgo(1) }))
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: null, error: null })
    const res = await accept.POST(body())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: "not_eligible" })
    expect(updates()).toHaveLength(0)
    // The eligibility read carries the guards and selects only the id.
    const trace = mock.trace()
    expect(trace).toContain('lte("declared_value_cedis", 200)')
    expect(trace).toContain('select("tracking_id")')
  })

  it("answers not_open, not not_eligible, to a buffer courier on a job that is not open", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(registry({ status: "buffer", buffer_since: daysAgo(1) }))
    mock.queue({ data: null, error: null })
    const res = await accept.POST(body())
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(updates()).toHaveLength(0)
  })

  it("answers not_open to a buffer courier who passed the guards and then lost the claim", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queueRpc(registry({ status: "buffer", buffer_since: daysAgo(1) }))
    mock.queue(
      { data: { quote_cedis: 40 }, error: null },
      { data: { tracking_id: JOB }, error: null },
      { data: null, error: { code: "PGRST116", message: "no rows" } }
    )
    const res = await accept.POST(body())
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
  })

  it("never selects or returns the declared value, for either tier", async () => {
    for (const row of [FULL, registry({ status: "buffer", buffer_since: daysAgo(0) })]) {
      mock.calls = []
      mock.results = []
      mock.asPioneer("pi-uid-1", "courier_one")
      mock.queueRpc(row)
      mock.queue(
        { data: { quote_cedis: 40 }, error: null },
        { data: { tracking_id: JOB }, error: null },
        { data: { tracking_id: JOB }, error: null }
      )
      const res = await accept.POST(body())
      expect(res.status).toBe(200)
      expect(mock.selectedColumns()).not.toMatch(/declared/i)
      expect(await res.text()).not.toMatch(/declared/i)
    }
  })
})

describe("POST /api/guest/mine", () => {
  it("rejects a request with no token", async () => {
    const res = await mine.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(400)
  })

  it("matches on the session username and emits code nullity, never the hash", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: [{ tracking_id: JOB, status: "accepted", delivery_code_hash: "abc123" }],
      error: null,
    })
    const res = await mine.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        pi_username: "someone_else",
      }) as never
    )
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain("abc123")
    expect(JSON.parse(text).jobs[0].hasDeliveryCode).toBe(true)
    // Identity comes from the token, not from the body.
    expect(mock.trace()).toContain('eq("assigned_courier", "courier_one")')
    expect(mock.trace().join(" ")).not.toContain("someone_else")
  })

  it("returns the commission as recorded, never recomputed at the current rate", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: [
        { tracking_id: JOB, status: "accepted", quote_cedis: 40, remit_cedis: 3, delivery_code_hash: null },
        // A 5% remit recorded before this rate. It stays 2.00, with no rate label.
        { tracking_id: "GYM-D4E5F6", status: "delivered", quote_cedis: 40, remit_cedis: 2, delivery_code_hash: null },
        // Nothing recorded: no split is shown at all.
        { tracking_id: "GYM-G7H8J9", status: "delivered", quote_cedis: 40, remit_cedis: null, delivery_code_hash: null },
      ],
      error: null,
    })
    const res = await mine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    const { jobs } = await res.json()
    expect(jobs[0]).toMatchObject({ remitCedis: 3, keepsCedis: 37, commissionRateLabel: "7.5%" })
    expect(jobs[1]).toMatchObject({ remitCedis: 2, keepsCedis: 38, commissionRateLabel: null })
    expect(jobs[2]).toMatchObject({ remitCedis: null, keepsCedis: null, commissionRateLabel: null })
    const selected = mock.selectedColumns()
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_paid_at", "remit_ref"]) {
      expect(selected).not.toContain(hidden)
    }
  })

  // Item 6, 6.5: a cancelled job keeps no recipient contact on the courier's
  // screen. Every other status shows them, expired included (decision 5).
  it("withholds the recipient's name and phone on a cancelled job, and only there", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    const statuses = ["posted", "accepted", "in_transit", "delivered", "expired", "cancelled"]
    mock.queue({
      data: statuses.map((status, i) => ({
        tracking_id: `GYM-00000${i}`,
        status,
        recipient_name: "Ama",
        recipient_phone: "0244999888",
        pickup_landmark: "Blue gate",
        delivery_code_hash: null,
      })),
      error: null,
    })
    const res = await mine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    const { jobs } = await res.json()
    expect(jobs).toHaveLength(statuses.length)
    for (const job of jobs) {
      if (job.status === "cancelled") {
        expect(job.recipientName, job.status).toBeNull()
        expect(job.recipientPhone, job.status).toBeNull()
      } else {
        expect(job.recipientName, job.status).toBe("Ama")
        expect(job.recipientPhone, job.status).toBe("0244999888")
      }
      // Landmarks are not part of the rule (deferred to a later privacy pass).
      expect(job.pickupLandmark, job.status).toBe("Blue gate")
    }
    // A response rule only: nothing is written.
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("does not consult the courier registry, so a paused Pioneer still sees their jobs", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: [], error: null })
    const res = await mine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    expect(res.status).toBe(200)
    expect(mock.calls.some((c) => c.method === "rpc")).toBe(false)
    expect(mock.trace()).toContain('eq("assigned_courier", "courier_one")')
    expect(mock.selectedColumns()).not.toMatch(/declared/i)
  })

  it("answers 500 on a read error", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: null, error: { code: "XX000", message: "boom" } })
    const res = await mine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    expect(res.status).toBe(500)
  })
})

describe("POST /api/guest/delivery-code", () => {
  it("rejects a malformed last4", async () => {
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "12" }) as never
    )
    expect(res.status).toBe(400)
  })

  it("refuses a wrong last4", async () => {
    mock.queue({
      data: { tracking_id: JOB, sender_phone: "0244123456", delivery_code_hash: "x" },
      error: null,
    })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "guard_failed" })
  })

  // The attempt ceiling on this guard has its own file:
  // tests/routes/last4-guard.test.ts (S-2).
})

describe("POST /api/guest/confirm-pickup", () => {
  it("rejects a malformed tracking id", async () => {
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: "bad", last4: "3456" }) as never
    )
    expect(res.status).toBe(400)
  })

  it("refuses a wrong last4 and never reveals the phone", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "accepted",
        sender_phone: "0244123456",
        pickup_confirmed_at: null,
      },
      error: null,
    })
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "9999" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("0244123456")
  })

  it("is idempotent once confirmed", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "accepted",
        sender_phone: "0244123456",
        pickup_confirmed_at: "2026-09-01T10:00:00Z",
      },
      error: null,
    })
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, already: true })
  })
})

describe("POST /api/guest/confirm-delivery", () => {
  it("refuses a request with no via discriminator", async () => {
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "invalid_via" })
  })

  it("requires a session on the courier code path", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
      }) as never
    )
    expect(res.status).toBe(401)
  })

  it("refuses a courier who is not the assigned one", async () => {
    mock.asPioneer("pi-uid-2", "courier_two")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_assigned" })
  })

  it("locks the code path once the attempt budget is spent", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 5,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "code_locked", attemptsLeft: 0 })
  })

  it("bumps the counter through the RPC on a wrong code", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "not-the-hash-of-1234",
        delivery_code_attempts: 1,
      },
      error: null,
    })
    mock.queueRpc({ data: 2, error: null })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "wrong_code", attemptsLeft: 3 })
    expect(mock.calls.find((c) => c.method === "rpc")?.args[0]).toBe(
      "guest_bump_delivery_code_attempts"
    )
  })

  // Item 6 part (c): the courier branch is confirmCourierCode, matched on
  // assigned_courier. A job a legacy courier claimed carries only
  // assigned_courier_id, so no Pioneer can stamp it, and no attempt is spent.
  it("refuses a Pioneer on a legacy-claimed job, before any attempt is counted", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        assigned_courier: null,
        assigned_courier_id: "0f1e2d3c-4b5a-4968-8776-655443322110",
        delivery_confirmed_at: null,
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", { trackingId: JOB, via: "courier_code", code: "1234", accessToken: "good" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_assigned" })
    expect(mock.calls.filter((c) => c.method === "rpc")).toEqual([])
  })

  it("resolves the caller before it reads the job on the courier code path", async () => {
    mock.asAnonymousFailure()
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", { trackingId: JOB, via: "courier_code", code: "1234", accessToken: "bad" }) as never
    )
    expect(res.status).toBe(401)
    expect(mock.calls.filter((c) => c.method === "from")).toEqual([])
  })
})

// Finding S-17, the guest half. The Pioneer rail moved to randomBytes when
// creation became a server route; this rail always minted server side and was
// simply missed. A GYM- ID is the entry ticket to every public guest route, so
// a predictable one is the front half of an attack on the sender-side guards.
describe("the tracking id the guest rail mints", () => {
  it("keeps the GYM- plus six hex shape, so nothing downstream moves", async () => {
    mock.queue(
      { data: null, error: null },
      { data: null, error: null },
      { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
    )
    await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "small",
        senderPhone: "0244123456",
        declaredValueCedis: 150,
        offList: true,
      }) as never
    )
    const insert = mock.calls.find((c) => c.method === "insert")
    const minted = String((insert?.args[0] as Record<string, unknown>).tracking_id)
    // The same shape lib/schemas.ts accepts and every stored ID already has.
    expect(minted).toMatch(/^GYM-[0-9A-F]{6}$/)
  })

  it("does not repeat itself across many mints", async () => {
    // Not a randomness test, which a unit test cannot do. This catches the
    // failure that would actually matter: a mint that is constant, or seeded
    // per call from something like a truncated timestamp.
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      mock.calls = []
      mock.results = []
      mock.queue(
        { data: null, error: null },
        { data: null, error: null },
        { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
      )
      await create.POST(
        postJson("http://localhost/x", {
          pickupArea: "Anywhere",
          dropoffArea: "Anywhere else",
          packageSize: "small",
          senderPhone: "0244123456",
          declaredValueCedis: 150,
          offList: true,
        }) as never
      )
      const insert = mock.calls.find((c) => c.method === "insert")
      seen.add(String((insert?.args[0] as Record<string, unknown>).tracking_id))
    }
    expect(seen.size).toBe(40)
  })

  it("mints from the CSPRNG, not from Math.random", () => {
    // Asserted against the source because the property is about WHERE the
    // bytes come from, and no black-box test on 40 samples can tell a CSPRNG
    // from Math.random. The same reasoning tests/csp.test.ts uses when it
    // asserts a comment is present.
    const source = readFileSync("app/api/guest/create/route.ts", "utf8")
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")
    expect(code).toContain("randomBytes")
    expect(code).not.toContain("Math.random")
  })
})
