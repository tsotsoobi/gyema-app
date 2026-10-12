// The courier ladder: which guest jobs a courier may claim, from their
// courier_registry row (Phase 1 item 6, section 6.4 of
// docs/anchoring-phase1-notes.md).
//
// Pure. No database call, no clock of its own, and no identity: the caller
// has already resolved the courier and read their row, and passes the row and
// the time in. Both accept routes use it, the Pioneer one on the pinet host
// and the legacy one on the courier host, so this file imports neither
// identity resolver.
//
// The stored status is changed by hand (decision 7). The 30-day buffer limit
// is computed here on every read, so a buffer courier past it is refused from
// the moment the window closes, whatever the stored status still says.
//
// FULL IS FULL FOR DISPATCH ONLY. A Pioneer row is full through vouched_at,
// not KYC (6.10 decision 2). This file decides which jobs a courier may take
// and nothing else: it must never be read as a statement that a courier is
// verified. Anchoring and the trust bureau read kyc_approved_at only.

import { GUEST_AREA_NAMES } from "@/lib/guest-pricing"
import { BUFFER_VALUE_CAP_CEDIS } from "@/lib/declared-value"

/** How long a courier stays buffer before the ladder stops them, in days. */
export const BUFFER_WINDOW_DAYS = 30

const BUFFER_WINDOW_MS = BUFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * The registry fields the ladder reads. shredded_at is optional because
 * courier_find_pioneer never returns a shredded row, so the Pioneer route has
 * no such field to pass. operator_checked_at and operator_check_deadline are
 * optional for the same reason: only a legacy courier can carry them
 * (courier_registry_operator_checked_legacy_only_check, P18), and the Pioneer
 * route passes neither.
 */
export type LadderRow = {
  status: string
  buffer_since: string | null
  shredded_at?: string | null
  operator_checked_at?: string | null
  operator_check_deadline?: string | null
}

/**
 * In buffer through the operator check (item 10, option B, notes 10.5): the
 * row was checked, is buffer, and its clock is the check's own.
 * courier_record_operator_check writes buffer_since and operator_checked_at
 * from one now(), so they are equal; a courier who later came back through
 * PiVerify carries a buffer_since of its own and is on the 30-day rule again.
 *
 * Compared as the strings the database returned, not as parsed times: both
 * are the same column type, so equal values print identically, and parsing
 * to milliseconds would call two different microseconds equal.
 *
 * Never a statement that the courier is verified. The check is not KYC.
 */
export function throughOperatorCheck(row: LadderRow): boolean {
  return (
    row.status === "buffer" &&
    typeof row.operator_checked_at === "string" &&
    row.operator_checked_at !== "" &&
    row.buffer_since === row.operator_checked_at
  )
}

/** Why a courier may claim nothing. Each is a 403 reason as written. */
export type LadderRefusal = "courier_not_registered" | "unavailable" | "courier_not_active"

export type EffectiveTier =
  | { tier: "full" }
  | { tier: "buffer" }
  | { tier: "none"; reason: LadderRefusal }

/**
 * The 6.4 table, row for row.
 *
 *   no row                        none, courier_not_registered
 *   shredded_at set               none, unavailable
 *   registered, paused            none, courier_not_active
 *   buffer, buffer_since null     none, courier_not_active (fails closed)
 *   buffer through the operator   buffer while operator_check_deadline is
 *     check (item 10, option B)   null; at or after the deadline, none,
 *                                 courier_not_active. Not on the 30-day rule.
 *   buffer, 30 days or more       none, courier_not_active
 *   buffer, inside 30 days        buffer
 *   full                          full
 *   anything else                 none, courier_not_active
 *
 * nowMs is the route's Date.now(). A buffer_since that does not parse as a
 * time fails closed, like a null one. So does a set operator_check_deadline
 * that does not parse; a null one means the sunset has not started.
 */
export function effectiveTier(row: LadderRow | null, nowMs: number): EffectiveTier {
  if (!row) return { tier: "none", reason: "courier_not_registered" }
  if (row.shredded_at) return { tier: "none", reason: "unavailable" }

  switch (row.status) {
    case "full":
      return { tier: "full" }
    case "buffer": {
      if (!row.buffer_since) return { tier: "none", reason: "courier_not_active" }
      const since = Date.parse(row.buffer_since)
      if (!Number.isFinite(since) || !Number.isFinite(nowMs)) {
        return { tier: "none", reason: "courier_not_active" }
      }
      if (throughOperatorCheck(row)) {
        const deadline = row.operator_check_deadline
        if (deadline === null || deadline === undefined) return { tier: "buffer" }
        const until = Date.parse(deadline)
        if (!Number.isFinite(until) || nowMs >= until) return { tier: "none", reason: "courier_not_active" }
        return { tier: "buffer" }
      }
      if (nowMs - since >= BUFFER_WINDOW_MS) return { tier: "none", reason: "courier_not_active" }
      return { tier: "buffer" }
    }
    default:
      return { tier: "none", reason: "courier_not_active" }
  }
}

/** The two filter methods the buffer guards call, as the query builder has them. */
type BufferGuardable<Q> = {
  in(column: string, values: readonly string[]): Q
  lte(column: string, value: number): Q
}

/**
 * The guards a buffer claim adds, applied to the claim's query builder so they
 * sit in the guarded UPDATE itself and a job cannot change between a check and
 * the claim.
 *
 *   both areas on the bounded list   an off-list job priced by hand is posted
 *                                    with a quote and areas outside the list,
 *                                    and is refused. An untrimmed off-list
 *                                    value fails the exact match, which is the
 *                                    safe direction.
 *   declared value at or below 200   a null value fails the comparison, so a
 *                                    job with none counts as over the cap.
 *
 * The value guard is written as the literal filter call on purpose:
 * tests/declared-value-exposure.test.ts strips that one form and nothing else.
 * The column compares in the database and is never selected or returned.
 */
export function bufferJobGuards<Q extends BufferGuardable<Q>>(query: Q): Q {
  return query
    .in("pickup_area", GUEST_AREA_NAMES)
    .in("dropoff_area", GUEST_AREA_NAMES)
    .lte("declared_value_cedis", BUFFER_VALUE_CAP_CEDIS)
}
