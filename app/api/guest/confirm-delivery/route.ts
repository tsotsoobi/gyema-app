import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { STAMP_SENDER, STAMP_COURIER_CODE, hasStamp } from "@/lib/delivery-stamps"
import { verifyLast4 } from "@/lib/last4-guard"
import { GuestConfirmDeliveryBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit, ipIdentifier, retryAfterHeaders } from "@/lib/rate-limit"
import { confirmCourierCode } from "@/lib/guest-claim"
export const runtime = "nodejs"

// Delivery sign-off for guest jobs (handshake Part 2, closing end).
//
// TWO paths, discriminated by an explicit `via` field in the body. Never by
// which optional fields happen to be present: the branch a reviewer has to
// trust should be the one they can see.
//
//   via: "sender"       last 4 digits of the sender phone, as it always was.
//                       Symmetric counterpart to confirm-pickup. Stamps
//                       delivery_confirmed_by = "sender".
//
//   via: "courier_code" the 4-digit delivery code, spoken by the recipient at
//                       the door. The courier's proof of physical presence.
//                       Stamps "courier_code". Requires the courier's session
//                       and a match against assigned_courier. The whole
//                       branch is confirmCourierCode in lib/guest-claim.ts,
//                       shared with the legacy courier's route on the courier
//                       host, so the five-attempt ceiling is written once.
//
// Delivered gating branches on delivery_code_hash nullity:
//   null      one stamp closes the delivery, exactly as before. Jobs posted
//             before this feature are completely unaffected, down to running
//             the same UPDATE statement they always ran.
//   non-null  BOTH stamps are required, in either order. The two share one
//             (delivery_confirmed_at, delivery_confirmed_by) pair, so the
//             merge and the delivered flip happen inside a locking RPC rather
//             than a read-modify-write from here (see guest_stamp_delivery).
//
// Idempotent on re-confirm from either side. Never expose sender_phone, any
// contact field, or delivery_code_hash in any response.

export async function POST(req: NextRequest) {
  // The shared last-4 bucket, checked before the body is read so both paths
  // through this route are covered by one budget: a hundred and twenty an
  // hour per address across all three sender-side routes, because they are one
  // handshake by one person. The courier path shares it rather than getting
  // its own, since a courier and a sender behind the same carrier NAT are
  // indistinguishable from here and the number is set well above either.
  //
  // Fails OPEN on a Redis error. Both paths already carry a permanent attempt
  // ceiling in Postgres (ten on the last-4 side, five on the code side), and
  // those are the controls. Refusing a courier at a door because a cache is
  // unreachable would cost more than it protects.
  const limit = await checkLimit("guest_last4", ipIdentifier(req))
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: retryAfterHeaders(limit.retryAfterSeconds) }
    )
  }

  // GuestConfirmDeliveryBody carries the discriminator rule: `via` must be one
  // of the two stamps, and it decides whether last4 or code is required. There
  // is no default, because inferring one would put the discriminator back into
  // the shape of the payload rather than the value of a field.
  const parsed = await parseJsonBody(req, GuestConfirmDeliveryBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const { trackingId, via } = body
  const last4 = body.last4 ?? ""

  const admin = createAdminClient()

  if (via === STAMP_COURIER_CODE) {
    // Identity is derived server-side from the session token, never from the
    // body, same as /api/guest/mine. This is not belt-and-braces: without it
    // anyone holding a tracking ID could spend the courier's five attempts on
    // wrong guesses and lock the real courier out of their own delivery.
    //
    // The caller is resolved before the job is read, so the job is read once,
    // inside confirmCourierCode. A request with no valid session is refused
    // here, whatever the job's state.
    if (!body.accessToken) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }
    // resolveCaller now says WHY it refused. A 401 means the caller is not who
    // they need to be; a 503 means we could not ask Supabase Auth, which is a
    // different thing and used to be reported as the first one.
    const verdict = await resolveCaller(admin, body.accessToken)
    if (!verdict.ok) return callerRefusalResponse(verdict)

    // no_code and not_assigned before any attempt is counted, then the
    // attempt ceiling, the compare, the idempotent re-confirm and the stamp
    // under its row lock. Matched on assigned_courier, the Pioneer's
    // pi_username, as this branch always has been.
    const result = await confirmCourierCode(admin, {
      trackingId,
      code: body.code ?? "",
      match: { column: "assigned_courier", value: verdict.caller.pi_username },
    })
    return NextResponse.json(result.body, { status: result.status })
  }

  const { data, error } = await admin
    .from("guest_jobs")
    .select(
      "tracking_id, status, sender_phone, delivery_confirmed_at, delivery_confirmed_by, delivery_code_hash, last4_attempts"
    )
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()
  if (error) {
    console.error("[gyema] confirm-delivery lookup error:", error)
    return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 })
  }

  const coded = data.delivery_code_hash !== null

  // Sender path. Last-4 guard, with the same ten attempt ceiling the other two
  // sender side routes use (lib/last4-guard.ts). The courier path has its own
  // five attempt budget on the code; the two counters are separate, so burning
  // one does not spend the other.
  const verdict = await verifyLast4({
    admin,
    trackingId,
    senderPhone: data.sender_phone,
    attemptsSoFar: data.last4_attempts,
    last4,
  })
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, reason: verdict.reason, attemptsLeft: verdict.attemptsLeft },
      { status: verdict.status }
    )
  }

  // Idempotent: already signed off by THIS side is a success, not an error.
  // For a coded job that means checking this side's stamp specifically. The
  // old test would have read the courier's stamp as the sender's and locked
  // the sender out of a delivery they never signed for.
  if (coded) {
    if (hasStamp(data.delivery_confirmed_by, via)) {
      return NextResponse.json({ ok: true, confirmedAt: data.delivery_confirmed_at, already: true })
    }
  } else if (data.delivery_confirmed_at) {
    return NextResponse.json({ ok: true, confirmedAt: data.delivery_confirmed_at, already: true })
  }
  if (data.status !== "in_transit") {
    return NextResponse.json({ ok: false, reason: "not_confirmable" }, { status: 409 })
  }

  // Uncoded jobs: the original statement, unchanged. One stamp, no status
  // write, no RPC. Nothing about an old job's write path moves.
  if (!coded) {
    const { data: updated, error: updErr } = await admin
      .from("guest_jobs")
      .update({ delivery_confirmed_at: new Date().toISOString(), delivery_confirmed_by: "sender" })
      .eq("tracking_id", trackingId)
      .eq("status", "in_transit")
      .is("delivery_confirmed_at", null)
      .select("delivery_confirmed_at")
      .maybeSingle()
    if (updErr) {
      console.error("[gyema] confirm-delivery update error:", updErr)
      return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
    }
    if (!updated) {
      // Zero-row update: state changed between read and write. Report honestly.
      return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 })
    }
    return NextResponse.json({ ok: true, confirmedAt: updated.delivery_confirmed_at })
  }

  // Coded jobs: the merge of two stamps into one column pair, and the flip to
  // delivered once both are in, happen under a row lock inside the RPC. Doing
  // it here would race the other side stamping concurrently and lose one.
  const { data: stamped, error: rpcErr } = await admin.rpc("guest_stamp_delivery", {
    p_tracking_id: trackingId,
    p_via: via,
  })
  if (rpcErr) {
    console.error("[gyema] confirm-delivery stamp rpc error:", rpcErr)
    return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
  }
  const row = Array.isArray(stamped) ? stamped[0] : stamped
  if (!row) {
    // The RPC returns no row when the job moved out of in_transit between our
    // read and the lock. Same honest answer as the uncoded zero-row case.
    return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 })
  }
  return NextResponse.json({
    ok: true,
    confirmedAt: row.delivery_confirmed_at,
    // What the caller genuinely needs to know: whether their stamp closed the
    // delivery or whether the other side is still outstanding.
    delivered: row.status === "delivered",
    awaitingSender: !hasStamp(row.delivery_confirmed_by, STAMP_SENDER),
    awaitingCode: !hasStamp(row.delivery_confirmed_by, STAMP_COURIER_CODE),
  })
}
