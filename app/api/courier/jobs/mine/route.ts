import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierRefusalResponse,
  courierWriteRefusal,
  onCourierSurface,
  resolveCourier,
} from "@/lib/courier-auth"
import { CourierJobsMineBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit } from "@/lib/rate-limit"
import { recordedSplit } from "@/lib/guest-commission"
import { readCourierJobs, recipientWithheld } from "@/lib/guest-claim"

// The legacy courier's own guest jobs, on the courier host (item 6, 6.2). The
// courier host's counterpart of /api/guest/mine, with the same response shape.
//
// READ ONLY. No update, no insert, no status write, no confirmation. The one
// write is courier_session_resolve bumping last_seen_at once an hour.
//
// MATCHED ON assigned_courier_id, the courier id resolveCourier derived from
// the session cookie, and never on assigned_courier: a legacy claim leaves
// that column null. No registry lookup and no ladder: a courier always sees
// the jobs already assigned to them, whatever their tier (6.10 decision 8).
// Assignment is the only filter, so a job stays findable through its whole
// life.
//
// A cancelled job's recipient name and phone are withheld (6.5); the row is
// untouched.
//
// POST with an empty body, like the kyc routes: the CSRF check is the same for
// every courier POST, and the courier is the cookie.
//
// ORDER: off the surface 404; CSRF 415 / 403; body 400; resolveCourier 401 /
// 503; courier_me 429 (shared with /api/courier/me, 60 per 10 minutes, fails
// open); read failed 500; otherwise 200 with the list, empty included.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierJobsMineBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)

    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courierId = verdict.courier.courier_id

    const limit = await checkLimit("courier_me", courierId)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    const read = await readCourierJobs(admin, { column: "assigned_courier_id", value: courierId })
    if (!read.ok) return courierJson({ ok: false, reason: "server_error" }, 500)

    return courierJson({
      ok: true,
      jobs: read.rows.map((j) => {
        // As recorded at accept, never recomputed.
        const owed = recordedSplit(j.quote_cedis, j.remit_cedis)
        const withheld = recipientWithheld(j.status)
        return {
          kind: "guest",
          trackingId: j.tracking_id,
          pickupArea: j.pickup_area,
          pickupLandmark: j.pickup_landmark,
          dropoffArea: j.dropoff_area,
          dropoffLandmark: j.dropoff_landmark,
          packageSize: j.package_size,
          recipientName: withheld ? null : j.recipient_name,
          recipientPhone: withheld ? null : j.recipient_phone,
          quoteCedis: j.quote_cedis,
          remitCedis: owed?.commissionCedis ?? null,
          keepsCedis: owed?.keepsCedis ?? null,
          commissionRateLabel: owed?.rateLabel ?? null,
          paymentType: j.payment_type,
          whenPref: j.when_pref,
          scheduledDate: j.scheduled_date,
          status: j.status,
          pickupConfirmedAt: j.pickup_confirmed_at,
          pickupConfirmedBy: j.pickup_confirmed_by,
          deliveryConfirmedAt: j.delivery_confirmed_at,
          deliveryConfirmedBy: j.delivery_confirmed_by,
          // Nullity only. The hash itself stops here.
          hasDeliveryCode: j.delivery_code_hash !== null,
        }
      }),
    })
  } catch (err) {
    console.error("[gyema] courier jobs mine route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
