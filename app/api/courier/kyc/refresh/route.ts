import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierRefusalResponse,
  courierWriteRefusal,
  onCourierSurface,
  resolveCourier,
} from "@/lib/courier-auth"
import { kycPollSkipped, readCourierKycRow } from "@/lib/courier-kyc"
import {
  getPiVerifySession,
  isPiVerifySessionId,
  PiVerifyHttpError,
  pollEventId,
  type PiVerifySession,
} from "@/lib/piverify"
import { CourierKycRefreshBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit } from "@/lib/rate-limit"

// The polling fallback for a missed webhook (Phase 1 item 5,
// docs/anchoring-phase1-notes.md 5.4). PiVerify retries a webhook only five
// times, so a courier whose deliveries were all lost would otherwise be
// stranded at their last applied status.
//
// There is no scheduler in Phase 1. The courier page calls this on load
// while the result is unsettled, and every 60 seconds while the waiting
// screen is open. A courier who never opens the page is not polled.
//
// It re-fetches the courier's bound session from PiVerify and records what
// it sees through courier_apply_kyc_status, the same function the webhook
// calls, under a deterministic event id:
//
//   poll:<session_id>:<status>:<allowed_action or ->:<updated_at>
//
// with event type "poll" (lib/piverify.ts, pollEventId). The same
// observation polled twice reads duplicate; a new one applies once; a state
// the webhook already applied reads not_forward. The webhook refuses event
// ids starting "poll:" and the type "poll", so the namespace is the poll's.
//
// ORDER, and what each step answers:
//
//   off the courier surface    404  not_found
//   not JSON / wrong Origin    415 / 403  the CSRF check, before Redis
//   body not the schema        400  the body is an empty object
//   no session                 401 / 503  resolveCourier
//   courier_kyc_refresh        429  2 a minute per courier, fails closed
//   row read failed            503  verification_unavailable
//   nothing to learn           200  skipped: no bound session, approved, a
//                                   final rejection, or failed. No call.
//   stored id has a bad shape  200  ignored, logged, no call
//   re-fetch failed            503  verification_unavailable, nothing
//                                   written (a 402 included)
//   another session came back  200  ignored, logged, nothing written
//   event id over 128          200  ignored, logged, nothing written: never
//                                   truncated
//   function error             500  server_error
//   anything else              200  with the function's outcome
//
// ATTESTATION WRITE: founder review required. This route and
// POST /api/kyc/webhook are the only callers of courier_apply_kyc_status.
export const runtime = "nodejs"

/** Eight characters of an identifier: enough to find it, not enough to be it. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

type ApplyRow = { outcome: string; courier_status: string | null }

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierKycRefreshBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)

    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courierId = verdict.courier.courier_id

    const limit = await checkLimit("courier_kyc_refresh", courierId)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    const row = await readCourierKycRow(admin, courierId)
    if (row === "error") return courierJson({ ok: false, reason: "verification_unavailable" }, 503)
    if (row === null) {
      console.error("[gyema] courier kyc refresh: no registry row for", shortId(courierId))
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    if (kycPollSkipped(row)) return courierJson({ ok: true, outcome: "skipped" })

    const sessionId = row.piverify_session_id
    if (!isPiVerifySessionId(sessionId)) {
      console.error("[gyema] courier kyc refresh: bound session id has an unexpected shape for", shortId(courierId))
      return courierJson({ ok: true, outcome: "ignored" })
    }

    let session: PiVerifySession
    try {
      session = await getPiVerifySession(sessionId)
    } catch (err) {
      const what = err instanceof PiVerifyHttpError ? `${err.op} HTTP ${err.status}` : err instanceof Error ? err.name : "unknown"
      console.error("[gyema] courier kyc refresh: re-fetch failed for", shortId(sessionId), what)
      return courierJson({ ok: false, reason: "verification_unavailable" }, 503)
    }

    if (session.id !== sessionId) {
      console.warn("[gyema] courier kyc refresh: re-fetched session disagrees, ignored:", shortId(sessionId))
      return courierJson({ ok: true, outcome: "ignored" })
    }

    const eventId = pollEventId(session)
    if (eventId === null) {
      console.error("[gyema] courier kyc refresh: poll event id over 128 characters, refused for", shortId(sessionId))
      return courierJson({ ok: true, outcome: "ignored" })
    }

    const { data, error } = await admin.rpc("courier_apply_kyc_status", {
      p_event_id: eventId,
      p_event_type: "poll",
      p_session_id: sessionId,
      p_external_user_id: session.external_user_id,
      p_status: session.status,
      p_allowed_action: session.allowed_action ?? null,
    })
    if (error) {
      console.error(`[gyema] courier kyc refresh: apply failed: code=${(error as { code?: string }).code ?? "none"}`)
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    const applied = (Array.isArray(data) ? data[0] : data) as ApplyRow | null | undefined
    const outcome = applied?.outcome ?? "no_result"
    console.log("[gyema] courier kyc refresh:", outcome, "session", shortId(sessionId))
    if (outcome === "no_result") return courierJson({ ok: false, reason: "server_error" }, 500)
    return courierJson({ ok: true, outcome })
  } catch (err) {
    console.error("[gyema] courier kyc refresh route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
