import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { GuestMineBody, parseJsonBody } from "@/lib/schemas"
import { recordedSplit } from "@/lib/guest-commission"
import { readCourierJobs, recipientWithheld } from "@/lib/guest-claim"

// The courier's own accepted guest jobs. Before this route the accept sheet
// was the only view of a claimed job, so the job vanished when the sheet
// closed. This makes it durable: close the app, reopen it, the job is still
// there with everything needed to deliver it.
//
// READ ONLY, deliberately. No update, no insert, no status write, no
// confirmation. Pickup and delivery confirmations belong to the sender on the
// public tracker (/api/guest/confirm-pickup, /api/guest/confirm-delivery);
// this surface only reflects them.
//
// POST rather than GET because the Supabase session token travels in the
// body, keeping it out of URLs and access logs. It is still strictly a read.
//
// Runs with the service_role admin client because guest_jobs has RLS enabled
// with no public policy, same as every other guest route.
//
// The read and its column list live in lib/guest-claim.ts, shared with the
// legacy courier's own list on the courier host. This route matches on
// assigned_courier, the Pioneer's pi_username, as it always has. It does not
// consult the courier registry: a Pioneer always sees the jobs already
// assigned to them, whatever their tier (6.10 decision 8).
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, GuestMineBody)
    if (!parsed.ok) return parsed.response
    const { accessToken } = parsed.data

    const admin = createAdminClient()

    // Identity is derived here, server-side, from the session token alone.
    // The request body carries nothing but the token: no username, no uid.
    // pi_username is the right match key here, not pi_uid: Pi's authenticate()
    // returns different pi_uids for the same Pioneer across sessions on
    // Testnet (see lib/supabase-admin.ts), so a uid match would lose a courier
    // their jobs on the next sign-in, which is exactly the case this surface
    // exists to survive. Both values come from app_metadata, so neither is
    // something the caller could have chosen.
    // resolveCaller now says WHY it refused. A 401 means the caller is not who
    // they need to be; a 503 means we could not ask Supabase Auth, which is a
    // different thing and used to be reported as the first one.
    const verdict = await resolveCaller(admin, accessToken)
    if (!verdict.ok) return callerRefusalResponse(verdict)
    const caller = verdict.caller

    // Assignment is the ONLY filter. No status filter, so a job stays
    // findable through its whole life: accepted, in transit, delivered.
    const read = await readCourierJobs(admin, { column: "assigned_courier", value: caller.pi_username })
    if (!read.ok) return NextResponse.json({ ok: false }, { status: 500 })

    // Zero rows is a successful read, not a 404: a courier who has accepted
    // nothing yet gets ok:true with an empty list, and the UI renders no
    // section at all.
    const rows = read.rows
    return NextResponse.json({
      ok: true,
      jobs: rows.map((j) => {
        // As recorded at accept, never recomputed. A job accepted at an earlier
        // rate shows its recorded figure and no rate label; a job with nothing
        // recorded shows no split at all.
        const owed = recordedSplit(j.quote_cedis, j.remit_cedis)
        // A cancelled job keeps no recipient contact on the courier's screen
        // (6.5). The row is untouched; only this response withholds them.
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
    console.error("[gyema] guest courier jobs route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
