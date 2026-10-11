import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  clearedSessionCookie,
  courierJson,
  courierWriteRefusal,
  isSessionTokenShape,
  onCourierSurface,
  readSessionToken,
  sha256Bytea,
} from "@/lib/courier-auth"
import { CourierSignOutBody, parseJsonBody } from "@/lib/schemas"

// Courier sign-out (Phase 1 item 5, 5.2): revokes the caller's own session,
// found by the hash of the token in their cookie, and clears the cookie.
//
// The body is an empty object; nothing in it names a session. Only the
// session in this request's cookie can be ended here, which is why this
// route needs no resolveCourier first: the token is its own authority.
//
// ORDER, and what each step answers:
//
//   off the courier surface    404  not_found, as middleware answers there
//   not JSON / wrong Origin    415 / 403  the CSRF check
//   body not an empty object   400
//   no cookie, or not gcs_     200  nothing to end; the cookie is cleared
//   function error             503  signout_unavailable. The cookie is KEPT,
//                                   so the courier can try again: clearing it
//                                   would leave a live session behind with no
//                                   way left to end it from this device.
//   ended true or false        200  and the cookie is cleared. false means the
//                                   session was already revoked or unknown,
//                                   which the courier does not need told.
//
// IDENTITY WRITE: founder review required. This route is the only caller of
// courier_end_session.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierSignOutBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)

    const token = readSessionToken(request)
    if (isSessionTokenShape(token)) {
      const admin = createAdminClient()
      const { error } = await admin.rpc("courier_end_session", { p_token_hash: sha256Bytea(token) })
      if (error) {
        console.error(`[gyema] courier sign-out: end session failed: code=${(error as { code?: string }).code ?? "none"}`)
        return courierJson({ ok: false, reason: "signout_unavailable" }, 503)
      }
    }

    const response = courierJson({ ok: true })
    response.headers.append("Set-Cookie", clearedSessionCookie())
    return response
  } catch (err) {
    console.error("[gyema] courier sign-out route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
