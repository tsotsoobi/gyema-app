import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierWriteRefusal,
  newSessionToken,
  onCourierSurface,
  sessionCookie,
  sha256Bytea,
} from "@/lib/courier-auth"
import { CourierSignInBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit, ipIdentifier } from "@/lib/rate-limit"

// Courier sign-in with an operator-issued code (Phase 1 item 5, 5.2).
//
// The courier types the code the founder sent on WhatsApp. This route
// normalises it, hashes it, mints a session token, hashes that, and hands
// both hashes to courier_redeem_signin_code, which in one transaction checks
// the code, consumes it, revokes the courier's other sessions and inserts the
// new one (db/migrations/2026-10-08_courier_signin.sql). The courier id comes
// back from the code row, never from the request (invariant 1). The plaintext
// token goes to the courier's cookie and nowhere else: not to a log, not to
// the response body.
//
// ORDER, and what each step answers:
//
//   off the courier surface    404  not_found, as middleware answers there
//   not JSON / wrong Origin    415 / 403  the CSRF check, before Redis
//   courier_signin_ip          429  before the body is read
//   body not the schema        400  invalid_code: not ten alphabet characters
//   courier_signin_global      429  only a well-formed code spends it
//   function error             500  server_error (also until P11 exists)
//   no_match                   401  unknown, used or revoked code
//   expired                    401  a real code past its 15 minutes
//   unavailable                403  the courier is shredded or not legacy
//   ok                         200  and the cookie, for the life the SQL set
//
// No outcome but ok sets a cookie.
//
// IDENTITY WRITE: founder review required. This route is the only caller of
// courier_redeem_signin_code.
export const runtime = "nodejs"

type RedeemRow = { outcome: string; courier_id: string | null; expires_at: string | null }

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const ipLimit = await checkLimit("courier_signin_ip", ipIdentifier(request))
    if (!ipLimit.ok) {
      return courierJson({ ok: false, reason: ipLimit.reason }, 429, ipLimit.retryAfterSeconds)
    }

    const parsed = await parseJsonBody(request, CourierSignInBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)

    const globalLimit = await checkLimit("courier_signin_global", "all")
    if (!globalLimit.ok) {
      return courierJson({ ok: false, reason: globalLimit.reason }, 429, globalLimit.retryAfterSeconds)
    }

    const token = newSessionToken()
    const admin = createAdminClient()
    const { data, error } = await admin.rpc("courier_redeem_signin_code", {
      p_code_hash: sha256Bytea(parsed.data.code),
      p_token_hash: sha256Bytea(token),
    })
    if (error) {
      console.error(`[gyema] courier sign-in: redeem failed: code=${(error as { code?: string }).code ?? "none"}`)
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    const row = (Array.isArray(data) ? data[0] : data) as RedeemRow | null | undefined
    switch (row?.outcome) {
      case "ok":
        break
      case "no_match":
      case "expired":
        return courierJson({ ok: false, reason: row.outcome }, 401)
      case "unavailable":
        return courierJson({ ok: false, reason: "unavailable" }, 403)
      default:
        console.error(`[gyema] courier sign-in: unexpected redeem outcome: ${String(row?.outcome)}`)
        return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    // The cookie lives exactly as long as the session row: Max-Age is the
    // absolute lifetime the SQL set from now(). A missing or past expiry is a
    // shape this route does not understand, so no cookie is set.
    const maxAge = Math.floor((Date.parse(row.expires_at ?? "") - Date.now()) / 1000)
    if (!Number.isFinite(maxAge) || maxAge <= 0 || typeof row.courier_id !== "string") {
      console.error("[gyema] courier sign-in: redeem answered ok without a usable expiry")
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    const response = courierJson({ ok: true })
    response.headers.append("Set-Cookie", sessionCookie(token, maxAge))
    return response
  } catch (err) {
    console.error("[gyema] courier sign-in route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
