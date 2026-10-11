import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import {
  ACCEPT_NOT_ACTIVE_MESSAGE,
  ACCEPT_NOT_OPEN_MESSAGE,
  ACCEPT_NOT_REGISTERED_MESSAGE,
  acceptRefusalMessage,
} from "@/lib/guest-accept-message"

// The Pioneer guest job sheet's refusal line (item 8, 8.5 and 8.10).
// acceptGuestJobAsync now returns the route's reason, and the sheet maps it
// through acceptRefusalMessage instead of showing every refusal as "taken".

const session = vi.hoisted(() => ({ token: "good" as string | null }))
vi.mock("@/lib/pi-network", () => ({
  getSupabaseSession: () => (session.token ? { accessToken: session.token } : null),
}))

const { acceptGuestJobAsync } = await import("@/lib/guest-jobs")

describe("acceptRefusalMessage", () => {
  it("tells an unregistered Pioneer to contact Gyema to register", () => {
    expect(acceptRefusalMessage("courier_not_registered")).toBe(ACCEPT_NOT_REGISTERED_MESSAGE)
    expect(ACCEPT_NOT_REGISTERED_MESSAGE).toMatch(/contact Gyema to register as a courier/)
  })

  it("tells a paused Pioneer the account is paused", () => {
    expect(acceptRefusalMessage("courier_not_active")).toBe(ACCEPT_NOT_ACTIVE_MESSAGE)
    expect(ACCEPT_NOT_ACTIVE_MESSAGE).toMatch(/paused/)
  })

  it("keeps the existing line for not_open", () => {
    expect(acceptRefusalMessage("not_open")).toBe(
      "This job is no longer available. Another courier may have taken it."
    )
  })

  it("falls back to the not_open line for a reason it does not map", () => {
    expect(acceptRefusalMessage("something_new")).toBe(ACCEPT_NOT_OPEN_MESSAGE)
  })

  it("falls back to the not_open line for null and undefined", () => {
    expect(acceptRefusalMessage(null)).toBe(ACCEPT_NOT_OPEN_MESSAGE)
    expect(acceptRefusalMessage(undefined)).toBe(ACCEPT_NOT_OPEN_MESSAGE)
  })

  it("gives each mapped reason its own line", () => {
    const lines = new Set([
      ACCEPT_NOT_OPEN_MESSAGE,
      ACCEPT_NOT_REGISTERED_MESSAGE,
      ACCEPT_NOT_ACTIVE_MESSAGE,
    ])
    expect(lines.size).toBe(3)
  })
})

describe("acceptGuestJobAsync", () => {
  beforeEach(() => {
    session.token = "good"
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function respond(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    )
  }

  it("returns the route's reason on a refusal", async () => {
    respond(403, { ok: false, reason: "courier_not_registered" })
    expect(await acceptGuestJobAsync({ trackingId: "GYM-A1B2C3", accepterWhatsapp: "0244" })).toEqual({
      ok: false,
      reason: "courier_not_registered",
    })
  })

  it("returns not_open as given, on a 200 refusal", async () => {
    respond(200, { ok: false, reason: "not_open" })
    expect(await acceptGuestJobAsync({ trackingId: "GYM-A1B2C3", accepterWhatsapp: "0244" })).toEqual({
      ok: false,
      reason: "not_open",
    })
  })

  it("returns a null reason on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    expect(await acceptGuestJobAsync({ trackingId: "GYM-A1B2C3", accepterWhatsapp: "0244" })).toEqual({
      ok: false,
      reason: null,
    })
  })

  it("returns a null reason with no session, and sends nothing", async () => {
    session.token = null
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    expect(await acceptGuestJobAsync({ trackingId: "GYM-A1B2C3", accepterWhatsapp: "0244" })).toEqual({
      ok: false,
      reason: null,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns the job as before on success", async () => {
    respond(200, {
      ok: true,
      job: {
        tracking_id: "GYM-A1B2C3",
        pickup_area: "Osu",
        pickup_landmark: "the gate",
        dropoff_area: "Madina",
        dropoff_landmark: null,
        recipient_name: "Ama",
        recipient_phone: "0244000000",
        quote_cedis: 40,
        payment_type: "momo",
        remit_cedis: 3,
        keeps_cedis: 37,
        commission_rate_label: "7.5%",
      },
    })
    expect(await acceptGuestJobAsync({ trackingId: "GYM-A1B2C3", accepterWhatsapp: "0244" })).toEqual({
      ok: true,
      job: {
        trackingId: "GYM-A1B2C3",
        pickupArea: "Osu",
        pickupLandmark: "the gate",
        dropoffArea: "Madina",
        dropoffLandmark: null,
        recipientName: "Ama",
        recipientPhone: "0244000000",
        quoteCedis: 40,
        paymentType: "momo",
        remitCedis: 3,
        keepsCedis: 37,
        commissionRateLabel: "7.5%",
      },
    })
  })
})

describe("static pins", () => {
  it("the sheet maps refusals through acceptRefusalMessage and hard-codes no refusal line", () => {
    const src = readFileSync("components/guest-job-sheet.tsx", "utf8")
    expect(src).toMatch(/acceptRefusalMessage\(result\.reason\)/)
    expect(src).not.toMatch(/no longer available/)
  })

  it("the mapping module imports nothing", () => {
    const src = readFileSync("lib/guest-accept-message.ts", "utf8")
    expect(src).not.toMatch(/^\s*import\b/m)
  })
})
