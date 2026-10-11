// Guest job logic shared by the courier routes on both hosts (Phase 1 item 6,
// section 6.2 of docs/anchoring-phase1-notes.md): the claim, the courier's own
// job list, and the courier code confirmation.
//
// IDENTITY IS NOT RESOLVED HERE. Every function takes a courier the calling
// route has already resolved, from its own credential on its own host, and
// this file imports neither identity resolver. The Pioneer routes pass
// assigned_courier = the session's pi_username; the legacy routes pass
// assigned_courier_id = the session's courier id. Nothing in here reads a
// request.
//
// The commission is not computed here either. lib/guest-commission.ts is
// imported by API routes only (tests/guest-commission.test.ts), so the route
// computes remit_cedis and passes the figure in.
//
// Runs with the service_role admin client, as every guest route does:
// guest_jobs has RLS on with no public policy.

import type { SupabaseClient } from "@supabase/supabase-js"
import { mintDeliveryCode, hashDeliveryCode, hashesMatch } from "@/lib/delivery-code"
import { STAMP_COURIER_CODE, STAMP_SENDER, hasStamp } from "@/lib/delivery-stamps"
import { bufferJobGuards } from "@/lib/courier-ladder"

/**
 * Which assignment column a courier is matched on, and the value. Built by the
 * route from the identity it resolved, never from the request body.
 */
export type CourierMatch =
  | { column: "assigned_courier"; value: string }
  | { column: "assigned_courier_id"; value: string }

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

// Explicit column list. NEVER select() or select("*"): guest_jobs holds
// sender_phone and the remit_* settlement columns. Of those, remit_cedis alone
// reaches a client, and only here: the courier who has just claimed the job,
// who is the person who owes it. remit_pi, remit_rate, remit_method,
// remit_paid_at and remit_ref never do. Declared as an array so each column
// sits on its own line and the list stays verifiable at a glance.
//
// 10 columns. sender_phone is not one of them and must never be added here:
// the public tracker guards both sender confirmations with its last four
// digits, so a courier holding it could confirm pickup and delivery on a job
// they never carried.
//
// delivery_code_hash is not one of them either, and must never be added: the
// code space is 4 digits, so the hash IS the code to anyone holding it.
//
// The parcel's declared value is not one of them, and must never be added: it
// is never returned to any courier (item 7, tests/declared-value-exposure).
export const ACCEPTED_JOB_COLUMNS = [
  "tracking_id",
  "pickup_area",
  "pickup_landmark",
  "dropoff_area",
  "dropoff_landmark",
  "recipient_name",
  "recipient_phone",
  "quote_cedis",
  "payment_type",
  "remit_cedis",
].join(", ")

/**
 * The row those 10 columns produce. Declared because supabase-js cannot infer
 * a row shape from a joined constant.
 */
export type AcceptedJobRow = {
  tracking_id: string
  pickup_area: string
  pickup_landmark: string | null
  dropoff_area: string
  dropoff_landmark: string | null
  recipient_name: string | null
  recipient_phone: string | null
  quote_cedis: number | null
  payment_type: string | null
  remit_cedis: number | null
}

/**
 * The quote of a claimable job, read under the same guards the claim uses:
 * verified, posted, and unassigned in BOTH columns. A legacy claim leaves
 * assigned_courier null and sets assigned_courier_id, so either column alone
 * would call a legacy-claimed job unassigned.
 *
 * Null for a job that is not claimable or could not be read. Nothing is
 * written on the strength of this read: the claim repeats every guard.
 */
export async function readClaimableQuote(
  admin: SupabaseClient,
  trackingId: string
): Promise<{ quote_cedis: number | null } | null> {
  const { data, error } = await admin
    .from("guest_jobs")
    .select("quote_cedis")
    .eq("tracking_id", trackingId)
    .eq("status", "posted")
    .eq("phone_verified", true)
    .is("assigned_courier", null)
    .is("assigned_courier_id", null)
    .maybeSingle()
  if (error) console.error("[gyema] guest claim read error:", error)
  return (data as { quote_cedis: number | null } | null) ?? null
}

/**
 * Whether a claimable job passes the buffer guards. Read only, and used only
 * to choose the refusal reason for a buffer courier: not_eligible here, rather
 * than not_open. The guards that decide the claim are the ones in the claim
 * UPDATE itself, so a job that changes after this read is still refused there.
 *
 * Selects tracking_id alone. The value compares in the database and comes back
 * to nobody. A read error answers false, which refuses: the safe direction.
 */
export async function passesBufferGuards(admin: SupabaseClient, trackingId: string): Promise<boolean> {
  const query = admin
    .from("guest_jobs")
    .select("tracking_id")
    .eq("tracking_id", trackingId)
    .eq("status", "posted")
    .eq("phone_verified", true)
    .is("assigned_courier", null)
    .is("assigned_courier_id", null)
  const { data, error } = await bufferJobGuards(query).maybeSingle()
  if (error) console.error("[gyema] guest claim eligibility read error:", error)
  return !error && !!data
}

export type ClaimParams = {
  trackingId: string
  /** The quote readClaimableQuote saw. The claim is guarded on it. */
  quoteCedis: number
  /** What the courier owes, computed by the route from quoteCedis. */
  remitCedis: number
  /**
   * The assignment columns to write. Pioneer: pi_username, the registry id,
   * and the WhatsApp number as today. Legacy: null, the courier id, null.
   */
  assignment: {
    assigned_courier: string | null
    assigned_courier_id: string
    assigned_courier_whatsapp: string | null
  }
  /** The courier's effective tier. A buffer claim carries the buffer guards. */
  tier: "full" | "buffer"
}

/**
 * ATTESTATION WRITE: founder review required.
 *
 * The claim: posted to accepted, in one guarded UPDATE. It assigns the
 * courier, mints the delivery code, and records the commission, together, so
 * a job is never assigned without a code and a code is never minted for a job
 * the courier failed to win.
 *
 * Guards: verified, posted, unassigned in both columns, the quote the
 * commission was computed from, and for a buffer courier the buffer guards. A
 * job that changed since the read matches zero rows and nothing is written.
 *
 * The plaintext delivery code is discarded here. Only its hash is kept, and it
 * leaves the server only through /api/guest/delivery-code, to the sender,
 * behind the last-4 guard. The courier is the one party it exists as evidence
 * against.
 *
 * Returns the claimed row, or null when nothing was claimed.
 */
export async function claimGuestJob(admin: SupabaseClient, params: ClaimParams): Promise<AcceptedJobRow | null> {
  const deliveryCode = mintDeliveryCode()
  let query = admin
    .from("guest_jobs")
    .update({
      status: "accepted",
      assigned_courier: params.assignment.assigned_courier,
      assigned_courier_id: params.assignment.assigned_courier_id,
      assigned_courier_whatsapp: params.assignment.assigned_courier_whatsapp,
      delivery_code_hash: hashDeliveryCode(deliveryCode),
      remit_cedis: params.remitCedis,
      updated_at: new Date().toISOString(),
    })
    .eq("tracking_id", params.trackingId)
    .eq("status", "posted")
    .eq("phone_verified", true)
    .is("assigned_courier", null)
    .is("assigned_courier_id", null)
    // The commission was computed from this exact quote. If the quote changed
    // since the read, this matches nothing and the claim is refused.
    .eq("quote_cedis", params.quoteCedis)
  if (params.tier === "buffer") query = bufferJobGuards(query)

  const { data, error } = await query.select(ACCEPTED_JOB_COLUMNS).single()
  if (error || !data) {
    if (error) console.error("[gyema] guest claim update error:", error)
    return null
  }
  return data as unknown as AcceptedJobRow
}

// ---------------------------------------------------------------------------
// The courier's own jobs
// ---------------------------------------------------------------------------

// Explicit column list. NEVER select() or select("*"): guest_jobs holds
// sender_phone and the remit_* settlement columns (remit_cedis, remit_pi,
// remit_rate, remit_method, remit_paid_at, remit_ref). Of those, remit_cedis
// alone reaches a client, and only the courier matched as the job's assignee,
// who is the person who owes it. remit_pi, remit_rate, remit_method,
// remit_paid_at and remit_ref never do. Declared as an array so each column
// sits on its own line and the list stays verifiable at a glance.
//
// 19 columns. sender_phone is not one of them and must never be added here,
// and neither is the parcel's declared value.
//
// delivery_code_hash is the one column selected for something other than
// display: a mapper emits its NULLITY as hasDeliveryCode and drops the value.
// It must never be mapped through. The code space is 4 digits, so handing the
// hash to the courier hands them the code, and a code the courier already
// knows is no longer evidence they reached the door.
export const COURIER_JOB_COLUMNS = [
  "tracking_id",
  "pickup_area",
  "pickup_landmark",
  "dropoff_area",
  "dropoff_landmark",
  "package_size",
  "recipient_name",
  "recipient_phone",
  "quote_cedis",
  "payment_type",
  "remit_cedis",
  "when_pref",
  "scheduled_date",
  "status",
  "pickup_confirmed_at",
  "pickup_confirmed_by",
  "delivery_confirmed_at",
  "delivery_confirmed_by",
  "delivery_code_hash",
].join(", ")

/**
 * The row those 19 columns produce. Declared explicitly because supabase-js
 * can only infer a row shape from a string LITERAL passed to .select(); given
 * a joined constant it falls back to GenericStringError and a mapper stops
 * typechecking. Keep this in sync with COURIER_JOB_COLUMNS.
 */
export type CourierJobRow = {
  tracking_id: string
  pickup_area: string
  pickup_landmark: string | null
  dropoff_area: string
  dropoff_landmark: string | null
  package_size: string
  recipient_name: string | null
  recipient_phone: string | null
  quote_cedis: number | null
  payment_type: string | null
  remit_cedis: number | null
  when_pref: string | null
  scheduled_date: string | null
  status: string
  pickup_confirmed_at: string | null
  pickup_confirmed_by: string | null
  delivery_confirmed_at: string | null
  delivery_confirmed_by: string | null
  delivery_code_hash: string | null
}

/**
 * READ ONLY. The jobs assigned to one courier, newest first, at most 20.
 *
 * Assignment is the ONLY filter. No status filter, so a job stays findable
 * through its whole life: accepted, in transit, delivered. No registry lookup
 * and no ladder: a courier always sees the jobs already assigned to them,
 * whatever their tier (6.10 decision 8).
 */
export async function readCourierJobs(
  admin: SupabaseClient,
  match: CourierMatch
): Promise<{ ok: true; rows: CourierJobRow[] } | { ok: false }> {
  const { data, error } = await admin
    .from("guest_jobs")
    .select(COURIER_JOB_COLUMNS)
    .eq(match.column, match.value)
    .order("created_at", { ascending: false })
    .limit(20)
  if (error) {
    console.error("[gyema] guest courier jobs error:", error)
    return { ok: false }
  }
  return { ok: true, rows: (data ?? []) as unknown as CourierJobRow[] }
}

/**
 * Whether a job's recipient name and phone are withheld from its courier
 * (6.5, 6.10 decision 5): when the job is cancelled. A response rule only, the
 * row is untouched, so a job reopened by hand shows them again. cancelled has
 * no application writer today (F14); the operator sets it by hand.
 */
export function recipientWithheld(status: string): boolean {
  return status === "cancelled"
}

// ---------------------------------------------------------------------------
// Courier code confirmation
// ---------------------------------------------------------------------------

/**
 * Wrong-code budget. The fifth wrong entry exhausts it; from then on the
 * courier is refused with a reason distinct from a wrong code, so the UI can
 * stop asking. 4 digits with 5 tries is a 1-in-2000 blind guess. Written
 * once, here: both confirm routes call confirmCourierCode, the Pioneer courier
 * branch of app/api/guest/confirm-delivery and the legacy
 * app/api/courier/jobs/confirm-delivery.
 */
export const MAX_CODE_ATTEMPTS = 5

export type CodeConfirmResult = { status: number; body: Record<string, unknown> }

/**
 * ATTESTATION WRITE: founder review required.
 *
 * The courier_code delivery stamp, for a courier the route has resolved. The
 * delivery code is spoken by the recipient at the door: the courier's proof of
 * physical presence. The courier branch of app/api/guest/confirm-delivery
 * (matching on assigned_courier) and app/api/courier/jobs/confirm-delivery
 * (matching on assigned_courier_id) both call it, with the column the route
 * names in `match` (6.3).
 *
 * In order:
 *   1. Read the job by tracking id, phone verified. 500 lookup_failed, 404
 *      not_found.
 *   2. 409 no_code for an uncoded job. 403 not_assigned unless the job's
 *      assignment equals the resolved courier. Both before any attempt is
 *      counted, so a stranger cannot spend the courier's attempts.
 *   3. 403 code_locked once the budget is spent, checked before the compare.
 *   4. A wrong code bumps the counter atomically
 *      (guest_bump_delivery_code_attempts) and answers 403 wrong_code, or
 *      code_locked on the last.
 *   5. Already stamped by the courier: 200, already.
 *   6. Not in transit: 409 not_confirmable.
 *   7. guest_stamp_delivery(p_tracking_id, 'courier_code') under its row lock.
 *      No row back: 409 state_changed.
 *
 * No ladder check. A paused courier can still finish a job they hold: refusing
 * would strand a parcel already in their hands. The applied functions are
 * called unchanged.
 */
export async function confirmCourierCode(
  admin: SupabaseClient,
  params: { trackingId: string; code: string; match: CourierMatch }
): Promise<CodeConfirmResult> {
  const { trackingId, code, match } = params
  const { data, error } = await admin
    .from("guest_jobs")
    .select(
      "tracking_id, status, assigned_courier, assigned_courier_id, delivery_confirmed_at, delivery_confirmed_by, delivery_code_hash, delivery_code_attempts"
    )
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()
  if (error) {
    console.error("[gyema] courier code lookup error:", error)
    return { status: 500, body: { ok: false, reason: "lookup_failed" } }
  }
  if (!data) return { status: 404, body: { ok: false, reason: "not_found" } }

  const job = data as {
    status: string
    assigned_courier: string | null
    assigned_courier_id: string | null
    delivery_confirmed_at: string | null
    delivery_confirmed_by: string | null
    delivery_code_hash: string | null
    delivery_code_attempts: number | null
  }

  if (job.delivery_code_hash === null) {
    return { status: 409, body: { ok: false, reason: "no_code" } }
  }
  const assigned = job[match.column]
  if (!assigned || assigned !== match.value) {
    return { status: 403, body: { ok: false, reason: "not_assigned" } }
  }

  const attempts = job.delivery_code_attempts ?? 0
  if (attempts >= MAX_CODE_ATTEMPTS) {
    return { status: 403, body: { ok: false, reason: "code_locked", attemptsLeft: 0 } }
  }

  if (!hashesMatch(hashDeliveryCode(code), job.delivery_code_hash)) {
    // Atomic increment: a read-modify-write from here would let two concurrent
    // wrong guesses cost one attempt between them.
    const { data: bumped, error: bumpErr } = await admin.rpc("guest_bump_delivery_code_attempts", {
      p_tracking_id: trackingId,
    })
    if (bumpErr) {
      console.error("[gyema] courier code attempt bump error:", bumpErr)
      return { status: 500, body: { ok: false, reason: "update_failed" } }
    }
    const used = typeof bumped === "number" ? bumped : attempts + 1
    const attemptsLeft = Math.max(0, MAX_CODE_ATTEMPTS - used)
    return {
      status: 403,
      body: { ok: false, reason: attemptsLeft === 0 ? "code_locked" : "wrong_code", attemptsLeft },
    }
  }

  // Idempotent: this side's own stamp already in is a success, not an error.
  if (hasStamp(job.delivery_confirmed_by, STAMP_COURIER_CODE)) {
    return { status: 200, body: { ok: true, confirmedAt: job.delivery_confirmed_at, already: true } }
  }
  if (job.status !== "in_transit") {
    return { status: 409, body: { ok: false, reason: "not_confirmable" } }
  }

  const { data: stamped, error: rpcErr } = await admin.rpc("guest_stamp_delivery", {
    p_tracking_id: trackingId,
    p_via: STAMP_COURIER_CODE,
  })
  if (rpcErr) {
    console.error("[gyema] courier code stamp rpc error:", rpcErr)
    return { status: 500, body: { ok: false, reason: "update_failed" } }
  }
  const row = (Array.isArray(stamped) ? stamped[0] : stamped) as
    | { status: string; delivery_confirmed_at: string | null; delivery_confirmed_by: string | null }
    | null
    | undefined
  if (!row) {
    // The job moved out of in_transit between the read and the lock.
    return { status: 409, body: { ok: false, reason: "state_changed" } }
  }
  return {
    status: 200,
    body: {
      ok: true,
      confirmedAt: row.delivery_confirmed_at,
      delivered: row.status === "delivered",
      awaitingSender: !hasStamp(row.delivery_confirmed_by, STAMP_SENDER),
      awaitingCode: !hasStamp(row.delivery_confirmed_by, STAMP_COURIER_CODE),
    },
  }
}
