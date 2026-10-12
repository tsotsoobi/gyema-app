import { createHash } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

// Whether a courier may start PiVerify verification, and how (Phase 1 item 5,
// docs/anchoring-phase1-notes.md 5.4). One decision, used by
// POST /api/courier/kyc/start to act and by GET /api/courier/me to say
// canStartKyc, so the page never offers a button the route would refuse.
//
// It decides from the courier's courier_registry row, read by courier id. The
// id comes from resolveCourier, which derived it from the session cookie,
// never from the request (invariant 1). courier_session_resolve does not
// return paused_reason or piverify_session_id, so the row is read here.
//
// THE TABLE, in 5.4's order:
//
//   kyc_approved_at set                       already_verified  409, no call
//   paused_reason = 'operator'                paused            403, no call
//   bound session created, started or
//   pending_review, or rejected with an
//   allowed_action                            continue          re-fetch it, return its URL
//   no session, rejected with no action,
//   or failed                                 create            create, then bind

/**
 * The courier_registry columns the KYC decision and the poll read, plus
 * buffer_since, operator_checked_at and operator_check_deadline, which
 * GET /api/courier/me passes to the ladder for effectiveTier (item 6 review;
 * item 10, option B). The KYC decision reads none of those three.
 * operator_checked_by is never read here, or anywhere outside SQL.
 */
export type CourierKycRow = {
  paused_reason: string | null
  buffer_since: string | null
  piverify_session_id: string | null
  piverify_status: string | null
  piverify_allowed_action: string | null
  kyc_approved_at: string | null
  operator_checked_at: string | null
  operator_check_deadline: string | null
}

const KYC_COLUMNS =
  "paused_reason, buffer_since, piverify_session_id, piverify_status, piverify_allowed_action, kyc_approved_at, " +
  "operator_checked_at, operator_check_deadline"

/**
 * The courier's row, or null when there is none, or "error" when the
 * database could not be asked. Read only.
 */
export async function readCourierKycRow(
  admin: SupabaseClient,
  courierId: string
): Promise<CourierKycRow | null | "error"> {
  try {
    const { data, error } = await admin
      .from("courier_registry")
      .select(KYC_COLUMNS)
      .eq("id", courierId)
      .maybeSingle()
    if (error) {
      console.warn(`[courier-kyc] courier_registry read failed: code=${(error as { code?: string }).code ?? "none"}`)
      return "error"
    }
    if (!data) return null
    const row = data as Partial<CourierKycRow>
    return {
      paused_reason: row.paused_reason ?? null,
      buffer_since: row.buffer_since ?? null,
      piverify_session_id: row.piverify_session_id ?? null,
      piverify_status: row.piverify_status ?? null,
      piverify_allowed_action: row.piverify_allowed_action ?? null,
      kyc_approved_at: row.kyc_approved_at ?? null,
      operator_checked_at: row.operator_checked_at ?? null,
      operator_check_deadline: row.operator_check_deadline ?? null,
    }
  } catch (err) {
    console.warn(`[courier-kyc] courier_registry read threw: ${err instanceof Error ? err.name : "unknown"}`)
    return "error"
  }
}

export type KycStartDecision =
  | { kind: "already_verified" }
  | { kind: "paused" }
  | { kind: "continue"; sessionId: string }
  | { kind: "create"; expectedSessionId: string | null }

/** Whether the bound session is still live: the courier carries on in it. */
function sessionIsLive(row: CourierKycRow): boolean {
  if (row.piverify_session_id === null) return false
  if (row.piverify_status === "created" || row.piverify_status === "started" || row.piverify_status === "pending_review") {
    return true
  }
  // A reopened rejection continues on the same session.
  return row.piverify_status === "rejected" && row.piverify_allowed_action !== null
}

/**
 * The 5.4 table. The order matters: an approved courier is told so even when
 * paused, and an operator pause stops a start before any PiVerify call.
 */
export function decideKycStart(row: CourierKycRow): KycStartDecision {
  if (row.kyc_approved_at !== null) return { kind: "already_verified" }
  if (row.paused_reason === "operator") return { kind: "paused" }
  if (sessionIsLive(row)) return { kind: "continue", sessionId: row.piverify_session_id as string }
  return { kind: "create", expectedSessionId: row.piverify_session_id }
}

/** What GET /api/courier/me reports: kyc/start would not refuse. */
export function canStartKyc(row: CourierKycRow): boolean {
  const decision = decideKycStart(row)
  return decision.kind === "continue" || decision.kind === "create"
}

/**
 * The poll (POST /api/courier/kyc/refresh) skips a courier with nothing left
 * to learn: no bound session, approved, a final rejection, or failed.
 */
export function kycPollSkipped(row: CourierKycRow): boolean {
  if (row.piverify_session_id === null) return true
  if (row.kyc_approved_at !== null) return true
  if (row.piverify_status === "rejected" && row.piverify_allowed_action === null) return true
  return row.piverify_status === "failed"
}

/**
 * The idempotency key for creating a session (founder decision, 8 Oct 2026,
 * 5.4): "gyema_" plus the first 32 hex characters of
 *
 *   sha256(courier_id + ":" + (bound session id or "none") + ":" + floor(unix seconds / 600))
 *
 * 38 characters. A double tap inside the same 10 minutes gets the same
 * session back from PiVerify. A retry after a 502 in a later 10-minute window
 * gets a new key, as PiVerify requires.
 */
export function kycIdempotencyKey(courierId: string, boundSessionId: string | null, nowMs: number): string {
  const window = Math.floor(Math.floor(nowMs / 1000) / 600)
  const digest = createHash("sha256")
    .update(`${courierId}:${boundSessionId ?? "none"}:${window}`, "utf8")
    .digest("hex")
  return `gyema_${digest.slice(0, 32)}`
}

/** A hosted flow URL the page may navigate to: https only. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
