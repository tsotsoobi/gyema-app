import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  getPiVerifySession,
  getPiVerifyWebhookSecret,
  isPiVerifyStatus,
  verifyPiVerifyWebhook,
} from "@/lib/piverify"
import { PiVerifyWebhookBody } from "@/lib/schemas"

// PiVerify KYC webhook: a session's status changed. Lands on
// public.courier_registry through public.courier_apply_kyc_status, and only
// there (db/migrations/2026-10-08_piverify_webhook.sql).
//
// THE PAYLOAD IS A NOTIFICATION, NOT A SOURCE OF TRUTH. Its HMAC has no
// timestamp, so a captured request can be replayed and will verify. So this
// route reads only three fields from it (the event id, its type and the
// session id), re-fetches the session from PiVerify, and acts on what
// PiVerify reports NOW. The payload's own status, external_user_id and
// allowed_action are never read: PiVerifyWebhookBody does not even carry them
// past parsing.
//
// The function then applies, under a row lock, the rules this route cannot
// enforce on its own: one event id processed once, forward transitions only
// (except that a rejection carrying RESUBMIT or APPEAL reopens the same
// session), approval recorded once per courier, the session must be the one
// bound to the courier, and an operator pause is never lifted
// (db/migrations/2026-10-08_piverify_resubmission.sql).
//
// PiVerify retries a failed delivery only five times, and gives up on an
// answer slower than 10 seconds. A webhook can therefore be missed for good.
// The fallback is the poll, POST /api/courier/kyc/refresh (item 5, 5.4). It
// records under event ids starting "poll:" with event type "poll", so this
// route refuses both: a delivered event never occupies the poll namespace.
//
// ORDER, and why each step answers what it does:
//
//   secret missing          500  misconfigured; nothing can be checked
//   signature wrong         401  nothing parsed, fetched or written
//   body not the schema     400  including an event id starting "poll:"
//                                or an event type of "poll"
//   event id already stored 200  duplicate, answered from piverify_events
//                                without calling PiVerify (500 if that read
//                                fails)
//   re-fetch failed         503  PiVerify retries; nothing written. Includes
//                                a session whose allowed_action is present
//                                but unknown
//   re-fetch disagrees      200  wrong session id or unknown status; logged,
//                                nothing written, a retry would not change it
//   function error          500  rolled back, including the event id, so a
//                                PiVerify retry is processed
//   session_not_bound       503  the courier exists but the app has not bound
//                                this session yet; PiVerify retries
//   anything else           200  with the outcome
//
// NO RATE LIMIT BUCKET, unlike every other public POST here. Nothing is read
// or written before a valid HMAC, and only PiVerify holds the key; a flood of
// unsigned requests costs one HMAC each and is refused with 401.
//
// The raw text is read BEFORE JSON.parse. The HMAC is over the exact bytes
// sent, and re-serialising would change them.
//
// ATTESTATION WRITE: founder review required. This route and
// POST /api/courier/kyc/refresh are the only callers of
// courier_apply_kyc_status, which writes a courier's KYC status.
export const runtime = "nodejs"

/** Eight characters of an identifier: enough to find it, not enough to be it. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

type ApplyRow = { outcome: string; courier_status: string | null }

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get("x-piverify-signature")

  let secret: string
  try {
    secret = getPiVerifyWebhookSecret()
  } catch {
    console.error("[gyema] piverify webhook: PIVERIFY_WEBHOOK_SECRET is not configured")
    return NextResponse.json({ ok: false, reason: "misconfigured" }, { status: 500 })
  }

  if (!verifyPiVerifyWebhook(rawBody, signature, secret)) {
    return NextResponse.json({ ok: false, reason: "bad_signature" }, { status: 401 })
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 })
  }
  const parsed = PiVerifyWebhookBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "bad_payload" }, { status: 400 })
  }
  const eventId = parsed.data.id
  const eventType = parsed.data.type
  const sessionId = parsed.data.data.session_id

  const admin = createAdminClient()

  // An event already processed is answered from the record, BEFORE PiVerify
  // is asked anything. The signature has no timestamp, so a captured request
  // replays and verifies forever; without this read, every replay would cost
  // an outbound call to PiVerify. The function's own duplicate check stays
  // as the guard for two copies arriving at once.
  //
  // A read error is a 500 rather than a fall-through to the re-fetch: the
  // function call would meet the same database, and PiVerify retries.
  const { data: seen, error: seenError } = await admin
    .from("piverify_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle()
  if (seenError) {
    console.error("[gyema] piverify webhook: event lookup failed for", shortId(sessionId), seenError)
    return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
  }
  if (seen) {
    return NextResponse.json({ ok: true, outcome: "duplicate" })
  }

  // The source of truth.
  let session: Awaited<ReturnType<typeof getPiVerifySession>>
  try {
    session = await getPiVerifySession(sessionId)
  } catch (err) {
    console.error("[gyema] piverify webhook: session re-fetch failed for", shortId(sessionId), err)
    return NextResponse.json({ ok: false, reason: "upstream_unavailable" }, { status: 503 })
  }

  // getPiVerifySession already refuses a response with no id or an unknown
  // status. These two are checked again here because this is where acting on
  // the wrong session would happen.
  if (session.id !== sessionId || !isPiVerifyStatus(session.status)) {
    console.warn("[gyema] piverify webhook: re-fetched session disagrees with event, ignored:", shortId(sessionId))
    return NextResponse.json({ ok: true, outcome: "ignored" })
  }

  try {
    const { data, error } = await admin.rpc("courier_apply_kyc_status", {
      p_event_id: eventId,
      p_event_type: eventType,
      p_session_id: sessionId,
      p_external_user_id: session.external_user_id,
      p_status: session.status,
      p_allowed_action: session.allowed_action ?? null,
    })
    if (error) {
      console.error("[gyema] piverify webhook: apply failed for", shortId(sessionId), error)
      return NextResponse.json({ ok: false, reason: "apply_failed" }, { status: 500 })
    }

    const row = (Array.isArray(data) ? data[0] : data) as ApplyRow | null
    const outcome = row?.outcome ?? "no_result"
    console.log("[gyema] piverify webhook:", outcome, "session", shortId(sessionId))

    if (outcome === "session_not_bound") {
      return NextResponse.json({ ok: false, reason: "session_not_bound" }, { status: 503 })
    }
    if (outcome === "no_result") {
      return NextResponse.json({ ok: false, reason: "apply_failed" }, { status: 500 })
    }
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    console.error("[gyema] piverify webhook route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
