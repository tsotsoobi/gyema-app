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
