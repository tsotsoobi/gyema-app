import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierRefusalResponse,
  courierWriteRefusal,
  onCourierSurface,
  resolveCourier,
} from "@/lib/courier-auth"
import { decideKycStart, isHttpsUrl, kycIdempotencyKey, readCourierKycRow } from "@/lib/courier-kyc"
import {
  createPiVerifySession,
  getPiVerifySession,
  isPiVerifySessionId,
  PiVerifyHttpError,
  type PiVerifySession,
} from "@/lib/piverify"
import { CourierKycStartBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit } from "@/lib/rate-limit"

// Start, or carry on with, PiVerify verification for the signed-in courier
// (Phase 1 item 5, docs/anchoring-phase1-notes.md 5.4).
//
// The courier is resolved from the session cookie, and everything else is
// read from their courier_registry row: nothing in the body names a courier
// or a session (invariant 1). decideKycStart in lib/courier-kyc.ts applies
// the 5.4 table, the same function GET /api/courier/me uses for canStartKyc.
//
// ORDER, and what each step answers:
//
//   off the courier surface    404  not_found, as middleware answers there
//   not JSON / wrong Origin    415 / 403  the CSRF check, before Redis
//   body not the schema        400  the body is an empty object
//   no session                 401 / 503  resolveCourier
//   courier_kyc_start          429  10 a day per courier, fails closed
//   row read failed            503  verification_unavailable
//   kyc_approved_at set        409  already_verified, no PiVerify call
//   operator pause             403  paused, no PiVerify call
//   bound session still live   200  its hosted_flow_url, re-fetched; no new
//                                   session (a reopened rejection continues
//                                   on the same one)
//   otherwise                  create, then bind:
//     create failed            503  verification_unavailable, nothing
//                                   written. A 402 (the PiVerify account
//                                   needs credit) is logged as such.
//     created session odd      503  a malformed id, another external_user_id
//                                   or a non-https hosted_flow_url; logged,
//                                   nothing bound
//     bound                    200  the new session's hosted_flow_url
//     conflict / session_live  200  the hosted_flow_url of the session that
//                                   won, re-fetched; never this request's own
//     already_full             409  already_verified
//     shredded                 403  unavailable
//     anything else            503  logged
//     function error           500  server_error (also until P12 exists)
//
// The idempotency key is gyema_ plus 32 hex characters of a sha256 over the
// courier id, the bound session id or "none", and the 10-minute window
// (lib/courier-kyc.ts). A double tap gets the same session back from
// PiVerify; two requests racing past each other both reach the bind, and the
// loser returns the winner's URL.
//
// The log carries the first 8 characters of an id, never the whole of one,
// and never a hosted_flow_url.
//
// ATTESTATION WRITE: founder review required. This route is the only caller
// of courier_bind_piverify_session, which moves the courier ladder.
export const runtime = "nodejs"

/** Eight characters of an identifier: enough to find it, not enough to be it. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

type BindRow = { outcome: string; current_session_id: string | null }

const UNAVAILABLE = { ok: false, reason: "verification_unavailable" } as const

/** The hosted flow URL of a session bound to this courier, re-fetched, or null. */
async function hostedUrlOf(sessionId: string | null): Promise<string | null> {
  if (!isPiVerifySessionId(sessionId)) {
    console.error("[gyema] courier kyc start: bound session id has an unexpected shape")
    return null
  }
  let session: PiVerifySession
  try {
    session = await getPiVerifySession(sessionId)
  } catch (err) {
    console.error("[gyema] courier kyc start: re-fetch failed for", shortId(sessionId), describe(err))
    return null
  }
  if (session.id !== sessionId || !isHttpsUrl(session.hosted_flow_url)) {
    console.error("[gyema] courier kyc start: re-fetched session unusable for", shortId(sessionId))
    return null
  }
  return session.hosted_flow_url
}

/** What a caught PiVerify failure says in a log: the op and status, never a body. */
function describe(err: unknown): string {
  if (err instanceof PiVerifyHttpError) return `${err.op} HTTP ${err.status}`
  return err instanceof Error ? err.name : "unknown"
}

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierKycStartBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)

    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courierId = verdict.courier.courier_id

    const limit = await checkLimit("courier_kyc_start", courierId)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    const row = await readCourierKycRow(admin, courierId)
    if (row === "error") return courierJson(UNAVAILABLE, 503)
    if (row === null) {
      console.error("[gyema] courier kyc start: no registry row for", shortId(courierId))
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    const decision = decideKycStart(row)
    switch (decision.kind) {
      case "already_verified":
        return courierJson({ ok: false, reason: "already_verified" }, 409)
      case "paused":
        return courierJson({ ok: false, reason: "paused" }, 403)
      case "continue": {
        const url = await hostedUrlOf(decision.sessionId)
        if (!url) return courierJson(UNAVAILABLE, 503)
        return courierJson({ ok: true, hostedFlowUrl: url })
      }
      case "create":
        break
    }

    // Create. Nothing is written if this fails.
    let created: PiVerifySession
    try {
      created = await createPiVerifySession({
        external_user_id: courierId,
        idempotency_key: kycIdempotencyKey(courierId, decision.expectedSessionId, Date.now()),
      })
    } catch (err) {
      if (err instanceof PiVerifyHttpError && err.status === 402) {
        console.error("[gyema] piverify createSession 402: PiVerify account needs credit")
      } else {
        console.error("[gyema] courier kyc start: create failed:", describe(err))
      }
      return courierJson(UNAVAILABLE, 503)
    }

    if (
      !isPiVerifySessionId(created.id) ||
      created.external_user_id !== courierId ||
      !isHttpsUrl(created.hosted_flow_url)
    ) {
      console.error("[gyema] courier kyc start: created session refused before bind for", shortId(courierId))
      return courierJson(UNAVAILABLE, 503)
    }

    const { data, error } = await admin.rpc("courier_bind_piverify_session", {
      p_courier_id: courierId,
      p_expected_session_id: decision.expectedSessionId,
      p_new_session_id: created.id,
      p_status: created.status,
    })
    if (error) {
      console.error(`[gyema] courier kyc start: bind failed: code=${(error as { code?: string }).code ?? "none"}`)
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    const bind = (Array.isArray(data) ? data[0] : data) as BindRow | null | undefined
    const outcome = bind?.outcome ?? "no_result"
    console.log("[gyema] courier kyc start:", outcome, "session", shortId(created.id))

    switch (outcome) {
      case "bound":
        return courierJson({ ok: true, hostedFlowUrl: created.hosted_flow_url })
      case "conflict":
      case "session_live": {
        // Another request bound first. Its session, never this one.
        const url = await hostedUrlOf(bind?.current_session_id ?? null)
        if (!url) return courierJson(UNAVAILABLE, 503)
        return courierJson({ ok: true, hostedFlowUrl: url })
      }
      case "already_full":
        return courierJson({ ok: false, reason: "already_verified" }, 409)
      case "shredded":
        return courierJson({ ok: false, reason: "unavailable" }, 403)
      default:
        // session_taken, bad_status, or a shape this route does not know.
        return courierJson(UNAVAILABLE, 503)
    }
  } catch (err) {
    console.error("[gyema] courier kyc start route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
