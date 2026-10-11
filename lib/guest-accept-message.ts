// What the Pioneer guest job sheet says when /api/guest/accept refuses a
// claim (item 8, 8.5 and 8.10). Pure and import-free, so the mapping is tested
// on its own (tests/guest-accept-message.test.ts).
//
// Before this, every refusal read "This job is no longer available. Another
// courier may have taken it.", which told an unregistered or paused Pioneer,
// falsely, that the job may have been taken. not_open, any reason not mapped
// here, and a failed request (reason null) keep that line.
//
// Display only. The claim is decided by the route's guarded UPDATE.

// Copy approved 11 Oct 2026 (8.17), as are the two lines below.
// COPY: later (8.17). All three differ in wording from the courier page's
// lines for the same reasons (app/courier/courier-jobs.tsx, ACCEPT_ERRORS).
export const ACCEPT_NOT_OPEN_MESSAGE =
  "This job is no longer available. Another courier may have taken it."

export const ACCEPT_NOT_REGISTERED_MESSAGE =
  "To take guest deliveries, contact Gyema to register as a courier."

export const ACCEPT_NOT_ACTIVE_MESSAGE =
  "Your courier account is paused, so it cannot take jobs right now. Contact Gyema."

export function acceptRefusalMessage(reason: string | null | undefined): string {
  if (reason === "courier_not_registered") return ACCEPT_NOT_REGISTERED_MESSAGE
  if (reason === "courier_not_active") return ACCEPT_NOT_ACTIVE_MESSAGE
  return ACCEPT_NOT_OPEN_MESSAGE
}
