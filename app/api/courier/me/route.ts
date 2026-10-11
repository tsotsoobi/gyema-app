import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierReference,
  courierRefusalResponse,
  resolveCourier,
} from "@/lib/courier-auth"
import { canStartKyc, readCourierKycRow } from "@/lib/courier-kyc"
import { effectiveTier } from "@/lib/courier-ladder"
import { checkLimit } from "@/lib/rate-limit"

// The signed-in courier's status card (Phase 1 item 5, 5.2).
//
// The courier page renders a neutral shell and asks this route who is signed
// in after load. The session cookie is SameSite=Strict, so it is not sent on
// the cross-site tap from WhatsApp that opens the page, but it is sent on
// this same-site fetch. No server component reads the cookie.
//
// WHAT IT RETURNS, AND NOTHING ELSE:
//
//   reference              the first 8 characters of the courier id, which
//                          the courier reads back to the founder on WhatsApp
//                          (5.1, decision 9). Never the whole id, and never
//                          accepted as input by any route.
//   status                 courier_registry.status
//   piverifyStatus         courier_registry.piverify_status
//   piverifyAllowedAction  courier_registry.piverify_allowed_action
//   canStartKyc            whether POST /api/courier/kyc/start would act
//                          rather than refuse: decided by canStartKyc in
//                          lib/courier-kyc.ts, the same table the route
//                          uses, so the page never offers a button the route
//                          would refuse. It needs paused_reason and the
//                          bound session id, which courier_session_resolve
//                          does not return, so the row is read here.
//   effectiveTier          full, buffer or none: effectiveTier in
//                          lib/courier-ladder.ts on status and buffer_since,
//                          with the server clock, the same rule
//                          /api/courier/jobs/accept applies. A buffer courier
//                          at 30 days or more reads none while status still
//                          says buffer (decision 7: status is changed by
//                          hand). The page decides from this, never from
//                          status, whether to offer jobs.
//
// GET, with nothing taken from the request but the cookie. Read only: the
// one write is courier_session_resolve bumping last_seen_at once an hour.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courier = verdict.courier

    const limit = await checkLimit("courier_me", courier.courier_id)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    const row = await readCourierKycRow(admin, courier.courier_id)
    if (row === "error") return courierJson({ ok: false, reason: "unavailable" }, 503)
    if (row === null) {
      console.error("[gyema] courier me: no registry row for the resolved courier")
      return courierJson({ ok: false, reason: "server_error" }, 500)
    }

    return courierJson({
      ok: true,
      courier: {
        reference: courierReference(courier.courier_id),
        status: courier.status,
        piverifyStatus: courier.piverify_status,
        piverifyAllowedAction: courier.piverify_allowed_action,
        canStartKyc: canStartKyc(row),
        effectiveTier: effectiveTier({ status: courier.status, buffer_since: row.buffer_since }, Date.now()).tier,
      },
    })
  } catch (err) {
    console.error("[gyema] courier me route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
