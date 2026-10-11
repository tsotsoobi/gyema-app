import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierRefusalResponse,
  courierWriteRefusal,
  onCourierSurface,
  resolveCourier,
} from "@/lib/courier-auth"
import { CourierJobsConfirmDeliveryBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit } from "@/lib/rate-limit"
import { confirmCourierCode } from "@/lib/guest-claim"

// ATTESTATION WRITE: founder review required. The courier_code delivery
// stamp for a legacy courier, on the courier host (item 6, 6.3).
//
// The courier is resolved from the session cookie and matched on
// assigned_courier_id, never on assigned_courier, which a legacy claim leaves
// null. The body is { trackingId, code } with no `via`: this route is only
// ever the courier_code stamp. The sender's stamp stays on
// /api/guest/confirm-delivery, which the courier host refuses.
//
// The stamp itself is confirmCourierCode in lib/guest-claim.ts, the same
// function the Pioneer courier branch of /api/guest/confirm-delivery calls:
// no_code and not_assigned before any attempt is counted, the five-attempt
// ceiling, guest_bump_delivery_code_attempts, the same idempotency, and
// guest_stamp_delivery(p_tracking_id, 'courier_code'). Applied functions,
// called unchanged.
//
// No ladder check. A paused courier can still finish a job they hold:
// refusing would strand a parcel already in their hands.
//
// ORDER: off the surface 404; CSRF 415 / 403; body 400; resolveCourier 401 /
// 503; courier_confirm 429 (30 an hour per courier, fails open: the Postgres
// ceiling is the control); then confirmCourierCode's answers.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierJobsConfirmDeliveryBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)
    const { trackingId, code } = parsed.data

    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courierId = verdict.courier.courier_id

    const limit = await checkLimit("courier_confirm", courierId)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    const result = await confirmCourierCode(admin, {
      trackingId,
      code,
      match: { column: "assigned_courier_id", value: courierId },
    })
    return courierJson(result.body, result.status)
  } catch (err) {
    console.error("[gyema] courier confirm-delivery route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
