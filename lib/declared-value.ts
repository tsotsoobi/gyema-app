// The sender's declared value of a guest parcel, in whole cedis.
//
// Required on every new guest job and refused above the pilot cap (founder
// decision, answer 6 in docs/anchoring-decisions.md: the Trancova pilot
// liability cap). The same bound is held by the database check
// guest_jobs_declared_value_cedis_check
// (db/migrations/2026-10-10_guest_jobs_declared_value.sql), so raising it is
// this constant and a migration, both reviewed.
//
// NEVER RETURNED TO ANY COURIER. A visible parcel value is a theft incentive.
// It is used server side only, and shown to the sender on their own form and to
// the operator. tests/declared-value-exposure.test.ts holds the allowlist of
// files that may name it.
//
// No imports, so the send form and the schema share it without pulling server
// code into the client bundle.

/** The highest declared value accepted during the pilot, in whole cedis. */
export const DECLARED_VALUE_CAP_CEDIS = 500

/**
 * The highest declared value a buffer-tier courier may carry, in whole cedis
 * (item 6, section 6.4). A job above it, or with no value at all, is refused
 * to a buffer courier with not_eligible and left to a full courier. Used only
 * inside the claim UPDATE's filter (lib/courier-ladder.ts), never selected and
 * never returned. Must stay at or below DECLARED_VALUE_CAP_CEDIS.
 */
export const BUFFER_VALUE_CAP_CEDIS = 200
