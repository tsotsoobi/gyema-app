import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  courierJson,
  courierRefusalResponse,
  courierWriteRefusal,
  onCourierSurface,
  resolveCourier,
} from "@/lib/courier-auth"
import { CourierJobsAcceptBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit } from "@/lib/rate-limit"
import { courierSplit, recordedSplit } from "@/lib/guest-commission"
import { effectiveTier, type LadderRow } from "@/lib/courier-ladder"
import { claimGuestJob, passesBufferGuards, readClaimableQuote } from "@/lib/guest-claim"

// ATTESTATION WRITE: founder review required. Accept is a status write,
// posted to accepted (item 6, section 6.4).
//
// Guest job claim for a legacy courier, on the courier host (6.2). The
// courier is resolved from the session cookie by resolveCourier, never from
// the request: the body is { trackingId } and nothing else (6.10 decision 9).
// No WhatsApp number is collected, so the claim writes
//
//   assigned_courier           null
//   assigned_courier_id        the courier id from the session
//   assigned_courier_whatsapp  null
//
// The registry row is read here by that id, because courier_session_resolve
// does not return buffer_since or shredded_at (6.2). The ladder
// (lib/courier-ladder.ts) decides which jobs the courier may take, and the
// claim (lib/guest-claim.ts) is one guarded UPDATE: verified, posted,
// unassigned in BOTH columns, the quote the commission was computed from, and
// for a buffer courier the buffer guards. It mints the delivery code and
// records remit_cedis in the same statement. The plaintext code never leaves
// the server.
//
// ORDER, and what each step answers:
//
//   off the courier surface    404  not_found, as middleware answers there
//   not JSON / wrong Origin    415 / 403  the CSRF check, before Redis
//   body not the schema        400
//   no session                 401 / 503  resolveCourier
//   courier_accept             429  30 per 10 minutes per courier, fails closed
//   registry read failed       503  auth_unavailable, never "no row"
//   ladder says none           403  courier_not_registered, unavailable or
//                                   courier_not_active
//   not claimable, no quote    200  ok false, not_open (as /api/guest/accept)
//   buffer, outside guards     403  not_eligible, one reason for area or value
//   claim matched nothing      200  ok false, not_open
//   claimed                    200  the job, with what the courier keeps
//
// remit_cedis is computed here, by lib/guest-commission.ts, from the quote on
// the row, as /api/guest/accept does.
export const runtime = "nodejs"

const REGISTRY_COLUMNS = "status, buffer_since, shredded_at"

export async function POST(request: NextRequest) {
  try {
    if (!onCourierSurface(request)) {
      return courierJson({ error: "not_found" }, 404)
    }
    const refusal = courierWriteRefusal(request)
    if (refusal) return refusal

    const parsed = await parseJsonBody(request, CourierJobsAcceptBody)
    if (!parsed.ok) return courierJson({ ok: false, reason: parsed.reason }, 400)
    const { trackingId } = parsed.data

    const admin = createAdminClient()
    const verdict = await resolveCourier(admin, request)
    if (!verdict.ok) return courierRefusalResponse(verdict)
    const courierId = verdict.courier.courier_id

    const limit = await checkLimit("courier_accept", courierId)
    if (!limit.ok) {
      return courierJson({ ok: false, reason: limit.reason }, 429, limit.retryAfterSeconds)
    }

    // The registry row, by the id the session resolved to. A read error is 503
    // and never falls through to "no row": a blip must not read as
    // unregistered, and must never read as registered.
    const { data: found, error: findError } = await admin
      .from("courier_registry")
      .select(REGISTRY_COLUMNS)
      .eq("id", courierId)
      .maybeSingle()
    if (findError) {
      console.error(`[gyema] courier accept registry read failed: code=${(findError as { code?: string }).code ?? "none"}`)
      return courierJson({ ok: false, reason: "auth_unavailable" }, 503)
    }
    const row = (found as LadderRow | null) ?? null

    const ladder = effectiveTier(row, Date.now())
    if (ladder.tier === "none") {
      return courierJson({ ok: false, reason: ladder.reason }, 403)
    }

    // The quote the commission is computed from, read under the same guards
    // the claim uses. Nothing is written for a job that is not claimable or
    // has no usable quote.
    const claimable = await readClaimableQuote(admin, trackingId)
    const split = claimable ? courierSplit(claimable.quote_cedis) : null
    if (!claimable || claimable.quote_cedis === null || !split) {
      return courierJson({ ok: false, reason: "not_open" })
    }

    // A buffer courier on a job outside the buffer guards gets one reason,
    // whether the cause is the area or the value (6.10 decision 4). This read
    // only chooses the reason; the claim UPDATE carries the guards itself.
    if (ladder.tier === "buffer" && !(await passesBufferGuards(admin, trackingId))) {
      return courierJson({ ok: false, reason: "not_eligible" }, 403)
    }

    const claimed = await claimGuestJob(admin, {
      trackingId,
      quoteCedis: claimable.quote_cedis,
      remitCedis: split.commissionCedis,
      assignment: {
        assigned_courier: null,
        assigned_courier_id: courierId,
        assigned_courier_whatsapp: null,
      },
      tier: ladder.tier,
    })
    if (!claimed) return courierJson({ ok: false, reason: "not_open" })

    // The figures the courier is shown come from what was written, not from
    // the preview: remit_cedis as stored, and what they keep derived from it.
    const recorded = recordedSplit(claimed.quote_cedis, claimed.remit_cedis)
    return courierJson({
      ok: true,
      job: {
        ...claimed,
        keeps_cedis: recorded?.keepsCedis ?? null,
        commission_rate_label: recorded?.rateLabel ?? null,
      },
    })
  } catch (err) {
    console.error("[gyema] courier accept route error:", err instanceof Error ? err.name : "unknown")
    return courierJson({ ok: false, reason: "server_error" }, 500)
  }
}
