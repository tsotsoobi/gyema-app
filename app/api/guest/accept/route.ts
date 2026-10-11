import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { GuestAcceptBody, parseJsonBody } from "@/lib/schemas"
import { courierSplit, recordedSplit } from "@/lib/guest-commission"
import { effectiveTier, type LadderRow } from "@/lib/courier-ladder"
import { claimGuestJob, passesBufferGuards, readClaimableQuote } from "@/lib/guest-claim"

// ATTESTATION WRITE: founder review required. Accept is a status write,
// posted to accepted (item 6, section 6.4).
//
// Server-side guest job claim for a Pioneer courier, on the pinet host.
// Verify the accepter from their Supabase session token, never a
// client-supplied uid, then look them up in the courier registry, apply the
// ladder, and claim atomically, guarded to verified, posted, unassigned rows.
// No Pi fee fires here: a guest job is a dispatch job, not a connection.
// Contact fields reveal ONLY in the response to the successful accepter.
//
// A PIONEER COURIER IS A PIONEER FIRST (6.2). resolveCaller derives the
// pi_username from app_metadata; courier_find_pioneer then finds the registry
// row on lower(pi_username). The body carries no courier id, tier or role.
// A Pioneer with no row is refused, never treated as full: every existing
// Pioneer courier is registered by hand before this deploys (6.7 A).
//
// The claim itself, with the delivery code and the commission, is
// lib/guest-claim.ts: one guarded UPDATE that assigns the courier, mints the
// code and records remit_cedis, so a job is never assigned without a code and
// the commission always belongs to the quote it was written against. The
// plaintext code never leaves the server here: it is not returned to the
// courier, who is the one party it exists as evidence against (finding S-4).
//
// remit_cedis is computed here, by lib/guest-commission.ts, from the quote on
// the row. A job with no usable quote, such as an off-list job posted before
// it was priced, cannot be claimed.
export const runtime = "nodejs"

/** The registry fields courier_find_pioneer returns. */
type PioneerCourierRow = LadderRow & { id: string }

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, GuestAcceptBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, trackingId, accepterWhatsapp } = parsed.data
    const admin = createAdminClient()
    // resolveCaller now says WHY it refused. A 401 means the caller is not who
    // they need to be; a 503 means we could not ask Supabase Auth, which is a
    // different thing and used to be reported as the first one.
    const verdict = await resolveCaller(admin, accessToken)
    if (!verdict.ok) return callerRefusalResponse(verdict)
    const caller = verdict.caller

    // The registry row, by the username resolveCaller derived. A lookup error
    // is 503 auth_unavailable and never falls through to "no row": a blip must
    // not read as unregistered, and must never read as registered.
    const { data: found, error: findError } = await admin.rpc("courier_find_pioneer", {
      p_pi_username: caller.pi_username,
    })
    if (findError || (found !== null && !Array.isArray(found))) {
      if (findError) console.error("[gyema] guest accept registry lookup error:", findError)
      return NextResponse.json({ ok: false, reason: "auth_unavailable" }, { status: 503 })
    }
    const rows = (found ?? []) as PioneerCourierRow[]
    // The unique index on lower(pi_username) allows one row. More than one is
    // not a state this route can reason about, so it refuses rather than pick.
    if (rows.length > 1) {
      console.error("[gyema] guest accept registry lookup returned more than one row")
      return NextResponse.json({ ok: false, reason: "auth_unavailable" }, { status: 503 })
    }
    const courier = rows[0] ?? null

    const ladder = effectiveTier(courier, Date.now())
    if (ladder.tier === "none" || !courier) {
      const reason = ladder.tier === "none" ? ladder.reason : "courier_not_registered"
      return NextResponse.json({ ok: false, reason }, { status: 403 })
    }

    // The quote the commission is computed from, read under the same guards the
    // claim uses. Nothing is written for a job that is not claimable or has no
    // usable quote.
    const claimable = await readClaimableQuote(admin, trackingId)
    const split = claimable ? courierSplit(claimable.quote_cedis) : null
    if (!claimable || claimable.quote_cedis === null || !split) {
      return NextResponse.json({ ok: false, reason: "not_open" })
    }

    // A buffer courier on a job outside the buffer guards gets one reason,
    // whether the cause is the area or the value (6.10 decision 4). This read
    // only chooses the reason; the claim UPDATE carries the guards itself.
    if (ladder.tier === "buffer" && !(await passesBufferGuards(admin, trackingId))) {
      return NextResponse.json({ ok: false, reason: "not_eligible" }, { status: 403 })
    }

    const row = await claimGuestJob(admin, {
      trackingId,
      quoteCedis: claimable.quote_cedis,
      remitCedis: split.commissionCedis,
      assignment: {
        assigned_courier: caller.pi_username,
        assigned_courier_id: courier.id,
        assigned_courier_whatsapp: accepterWhatsapp ?? null,
      },
      tier: ladder.tier,
    })
    if (!row) return NextResponse.json({ ok: false, reason: "not_open" })

    // The figures the courier is shown come from what was written, not from
    // the preview: remit_cedis as stored, and what they keep derived from it.
    const recorded = recordedSplit(row.quote_cedis, row.remit_cedis)
    return NextResponse.json({
      ok: true,
      job: {
        ...row,
        keeps_cedis: recorded?.keepsCedis ?? null,
        commission_rate_label: recorded?.rateLabel ?? null,
      },
    })
  } catch (err) {
    console.error("[gyema] guest accept route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
