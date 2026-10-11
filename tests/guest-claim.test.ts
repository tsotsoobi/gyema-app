import { describe, it, expect, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { AdminMock } from "./helpers/admin-mock"
import { hashDeliveryCode } from "@/lib/delivery-code"
import {
  MAX_CODE_ATTEMPTS,
  claimGuestJob,
  confirmCourierCode,
  readCourierJobs,
  recipientWithheld,
} from "@/lib/guest-claim"

// lib/guest-claim.ts on its own, with the match the legacy routes will pass
// (assigned_courier_id). The Pioneer routes' use of it is pinned in
// tests/routes/guest.test.ts.

const JOB = "GYM-A1B2C3"
const COURIER = "11111111-2222-4333-8444-555555555555"
const CODE = "4821"

let mock: AdminMock
let admin: SupabaseClient

beforeEach(() => {
  mock = new AdminMock()
  admin = mock.client() as unknown as SupabaseClient
})

describe("claimGuestJob", () => {
  it("writes a legacy assignment: no username, no WhatsApp, the courier id", async () => {
    mock.queue({ data: { tracking_id: JOB }, error: null })
    const row = await claimGuestJob(admin, {
      trackingId: JOB,
      quoteCedis: 40,
      remitCedis: 3,
      assignment: { assigned_courier: null, assigned_courier_id: COURIER, assigned_courier_whatsapp: null },
      tier: "full",
    })
    expect(row).toEqual({ tracking_id: JOB })
    const written = mock.calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>
    expect(written).toMatchObject({
      status: "accepted",
      assigned_courier: null,
      assigned_courier_id: COURIER,
      assigned_courier_whatsapp: null,
      remit_cedis: 3,
    })
    expect((written.delivery_code_hash as string).length).toBe(64)
  })

  it("returns null when the guarded UPDATE matches no row, with the buffer guards on a buffer claim", async () => {
    mock.queue({ data: null, error: { code: "PGRST116", message: "no rows" } })
    const row = await claimGuestJob(admin, {
      trackingId: JOB,
      quoteCedis: 40,
      remitCedis: 3,
      assignment: { assigned_courier: null, assigned_courier_id: COURIER, assigned_courier_whatsapp: null },
      tier: "buffer",
    })
    expect(row).toBeNull()
    expect(mock.trace()).toContain('lte("declared_value_cedis", 200)')
  })
})

describe("readCourierJobs", () => {
  it("matches on the column and value it is given, newest first, at most 20", async () => {
    mock.queue({ data: [], error: null })
    const read = await readCourierJobs(admin, { column: "assigned_courier_id", value: COURIER })
    expect(read).toEqual({ ok: true, rows: [] })
    const trace = mock.trace()
    expect(trace).toContain(`eq("assigned_courier_id", "${COURIER}")`)
    expect(trace).toContain('limit(20)')
    expect(mock.selectedColumns()).not.toMatch(/sender_phone|declared|remit_pi/)
  })

  it("reports a read error as not ok", async () => {
    mock.queue({ data: null, error: { code: "XX000" } })
    expect(await readCourierJobs(admin, { column: "assigned_courier", value: "a" })).toEqual({ ok: false })
  })
})

describe("recipientWithheld", () => {
  it("is true for cancelled only", () => {
    expect(recipientWithheld("cancelled")).toBe(true)
    for (const s of ["posted", "accepted", "in_transit", "delivered", "expired", "Cancelled", ""]) {
      expect(recipientWithheld(s), s).toBe(false)
    }
  })
})

describe("confirmCourierCode", () => {
  function job(over: Record<string, unknown> = {}) {
    return {
      data: {
        tracking_id: JOB,
        status: "in_transit",
        assigned_courier: null,
        assigned_courier_id: COURIER,
        delivery_confirmed_at: null,
        delivery_confirmed_by: null,
        delivery_code_hash: hashDeliveryCode(CODE),
        delivery_code_attempts: 0,
        ...over,
      },
      error: null,
    }
  }
  const byId = { column: "assigned_courier_id", value: COURIER } as const
  const rpcs = () => mock.calls.filter((c) => c.method === "rpc").map((c) => c.args[0])

  it("never selects the sender's phone", async () => {
    mock.queue(job())
    await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(mock.selectedColumns()).not.toContain("sender_phone")
    expect(mock.trace()).toContain('eq("phone_verified", true)')
  })

  it("answers 404 for an unknown job and 500 on a read error", async () => {
    mock.queue({ data: null, error: null })
    expect((await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })).status).toBe(404)
    mock.queue({ data: null, error: { code: "XX000" } })
    expect(await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })).toEqual({
      status: 500,
      body: { ok: false, reason: "lookup_failed" },
    })
  })

  it("refuses an uncoded job with 409 no_code", async () => {
    mock.queue(job({ delivery_code_hash: null }))
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 409, body: { ok: false, reason: "no_code" } })
    expect(rpcs()).toEqual([])
  })

  it("refuses another courier, and an unassigned job, with 403 not_assigned before counting an attempt", async () => {
    mock.queue(job({ assigned_courier_id: "99999999-2222-4333-8444-555555555555" }))
    let r = await confirmCourierCode(admin, { trackingId: JOB, code: "0000", match: byId })
    expect(r).toEqual({ status: 403, body: { ok: false, reason: "not_assigned" } })
    mock.queue(job({ assigned_courier_id: null }))
    r = await confirmCourierCode(admin, { trackingId: JOB, code: "0000", match: byId })
    expect(r.body).toMatchObject({ reason: "not_assigned" })
    expect(rpcs()).toEqual([])
  })

  it("does not let a Pioneer username match stand in for the courier id", async () => {
    // A Pioneer-claimed job: assigned_courier set, assigned_courier_id set to
    // the Pioneer's registry row. A legacy match by id on another id fails.
    mock.queue(job({ assigned_courier: "pioneer_one", assigned_courier_id: "reg-pioneer" }))
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r.body).toMatchObject({ reason: "not_assigned" })
  })

  it("refuses a locked job before comparing, even with the right code", async () => {
    mock.queue(job({ delivery_code_attempts: MAX_CODE_ATTEMPTS }))
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 403, body: { ok: false, reason: "code_locked", attemptsLeft: 0 } })
    expect(rpcs()).toEqual([])
  })

  it("bumps the counter atomically on a wrong code", async () => {
    mock.queue(job({ delivery_code_attempts: 2 }))
    mock.queueRpc({ data: 3, error: null })
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: "0000", match: byId })
    expect(r).toEqual({ status: 403, body: { ok: false, reason: "wrong_code", attemptsLeft: 2 } })
    expect(mock.calls.find((c) => c.method === "rpc")?.args).toEqual([
      "guest_bump_delivery_code_attempts",
      { p_tracking_id: JOB },
    ])
  })

  it("answers code_locked on the wrong code that spends the last attempt", async () => {
    mock.queue(job({ delivery_code_attempts: 4 }))
    mock.queueRpc({ data: 5, error: null })
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: "0000", match: byId })
    expect(r.body).toEqual({ ok: false, reason: "code_locked", attemptsLeft: 0 })
  })

  it("is idempotent once the courier's stamp is in", async () => {
    mock.queue(job({ delivery_confirmed_by: "courier_code", delivery_confirmed_at: "2026-10-10T10:00:00Z" }))
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 200, body: { ok: true, confirmedAt: "2026-10-10T10:00:00Z", already: true } })
    expect(rpcs()).toEqual([])
  })

  it("refuses a job not in transit with 409 not_confirmable", async () => {
    mock.queue(job({ status: "accepted" }))
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 409, body: { ok: false, reason: "not_confirmable" } })
    expect(rpcs()).toEqual([])
  })

  it("stamps courier_code through the applied function, unchanged", async () => {
    mock.queue(job())
    mock.queueRpc({
      data: [{ status: "in_transit", delivery_confirmed_at: "2026-10-10T11:00:00Z", delivery_confirmed_by: "courier_code" }],
      error: null,
    })
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(mock.calls.find((c) => c.method === "rpc")?.args).toEqual([
      "guest_stamp_delivery",
      { p_tracking_id: JOB, p_via: "courier_code" },
    ])
    expect(r).toEqual({
      status: 200,
      body: {
        ok: true,
        confirmedAt: "2026-10-10T11:00:00Z",
        delivered: false,
        awaitingSender: true,
        awaitingCode: false,
      },
    })
    // The code and its hash never come back.
    expect(JSON.stringify(r)).not.toContain(CODE)
    expect(JSON.stringify(r)).not.toContain(hashDeliveryCode(CODE))
  })

  it("answers 409 state_changed when the stamp function returns no row", async () => {
    mock.queue(job())
    mock.queueRpc({ data: [], error: null })
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 409, body: { ok: false, reason: "state_changed" } })
  })

  it("answers 500 when the stamp function errors", async () => {
    mock.queue(job())
    mock.queueRpc({ data: null, error: { code: "XX000" } })
    const r = await confirmCourierCode(admin, { trackingId: JOB, code: CODE, match: byId })
    expect(r).toEqual({ status: 500, body: { ok: false, reason: "update_failed" } })
  })
})
