import { GUEST_AREA_NAMES } from "@/lib/guest-pricing"

// What the courier page shows, decided from GET /api/courier/me's
// effectiveTier (item 6 review, after c1b0868). Pure, so the decisions are
// tested on their own (tests/courier-view.test.ts).
//
// effectiveTier, never status. effectiveTier is the ladder's answer
// (lib/courier-ladder.ts), computed on the server clock on every /me read.
// status is the stored column, changed by hand, so a buffer courier past 30
// days still reads status buffer while the ladder already refuses them.
//
// Display only. Every claim is still decided by /api/courier/jobs/accept,
// whose guarded UPDATE carries the same rules.

export type EffectiveTier = "full" | "buffer" | "none"

/** Whether to offer the open board at all. */
export function canTakeJobs(effectiveTier: EffectiveTier): boolean {
  return effectiveTier === "full" || effectiveTier === "buffer"
}

/**
 * A buffer courier the ladder has stopped: status still buffer, tier not
 * active. The page says jobs are paused until verification completes.
 */
export function bufferWindowLapsed(status: string, effectiveTier: EffectiveTier): boolean {
  return status === "buffer" && effectiveTier !== "buffer"
}

const LISTED_AREAS: ReadonlySet<string> = new Set(GUEST_AREA_NAMES)

/**
 * The board for a tier. A buffer courier sees only jobs whose pickup and
 * dropoff areas are both on GUEST_AREA_NAMES, exact match, the list
 * bufferJobGuards uses. An untrimmed off-list value fails the match, as it
 * does in the claim. Nothing about the declared value: the board never
 * carries it, so a job over the buffer cap still shows and is refused on
 * accept with not_eligible (6.10 decision 4).
 */
export function visibleBoard<J extends { pickupArea: string; dropoffArea: string }>(
  jobs: readonly J[],
  effectiveTier: EffectiveTier
): J[] {
  if (effectiveTier !== "buffer") return [...jobs]
  return jobs.filter((j) => LISTED_AREAS.has(j.pickupArea) && LISTED_AREAS.has(j.dropoffArea))
}

// ---------------------------------------------------------------------------
// Item 10: the operator check and the PiVerify switch
// (docs/anchoring-phase1-notes.md 10.7, decision 10).
//
// Copy approved 12 Oct 2026 (item 10): the four strings below, after the
// gyema-accuracy review (decision 13). None of them says, or may say, that the
// courier is verified: the operator check is not identity verification, and
// "Verified courier" is reached only through PiVerify approval.
// ---------------------------------------------------------------------------

/** Copy approved 12 Oct 2026 (item 10). Under the status card, while in buffer through the check. */
export const OPERATOR_CHECK_LINE =
  "You have starter access after an in-person check by Gyema. This is not identity verification. Full access needs verification through PiVerify."

/** Copy approved 12 Oct 2026 (item 10). The lapsed line for a courier stopped at the sunset deadline. */
export const OPERATOR_CHECK_ENDED_LINE =
  "Starter access from the in-person check has ended. Jobs are paused until your verification through PiVerify is complete."

/** Copy approved 12 Oct 2026 (item 10). In place of the verification button while PiVerify is not enabled. */
export const PIVERIFY_NOT_OPEN_LINE = "Verification through PiVerify is not open yet. Gyema will let you know when it opens."

/** Copy approved 12 Oct 2026 (item 10). Once the sunset starts. {date} is the deadline, date only. */
export const OPERATOR_CHECK_DEADLINE_TEMPLATE =
  "Complete your verification through PiVerify by {date} to keep taking jobs."

/** What the page needs from GET /api/courier/me for these decisions. */
export type CourierKycView = {
  status: string
  effectiveTier: EffectiveTier
  operatorChecked: boolean
  operatorCheckDeadline: string | null
  piverifyEnabled: boolean
}

/**
 * Whether to show PIVERIFY_NOT_OPEN_LINE in the button's place: PiVerify is off, for
 * every signed-in courier who is not full (a full courier has nothing left to
 * verify).
 */
export function showPiverifyNotOpen(c: CourierKycView): boolean {
  return c.piverifyEnabled !== true && c.status !== "full"
}

/**
 * The deadline as a date only, in Accra time (UTC+0 all year), for example
 * "11 November 2026". Null when it does not parse, so no line is shown
 * rather than a wrong date.
 */
export function formatDeadlineDate(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Africa/Accra",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/**
 * The operator-check lines under the status card, in order:
 * OPERATOR_CHECK_LINE while the courier is in buffer through the check and the
 * ladder still lets them work, then the deadline line once a deadline is set.
 */
export function operatorCheckLines(c: CourierKycView): string[] {
  if (!c.operatorChecked || c.effectiveTier !== "buffer") return []
  const lines = [OPERATOR_CHECK_LINE]
  const date = formatDeadlineDate(c.operatorCheckDeadline)
  if (date) lines.push(OPERATOR_CHECK_DEADLINE_TEMPLATE.replace("{date}", date))
  return lines
}
