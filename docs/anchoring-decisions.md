# Founder decisions on Phase 0

Owner: Adokwei. 8 Oct 2026. Answers `docs/anchoring-design-notes.md` sections 5 and 6. Where this file and the brief disagree, this file wins. Where this file and the code disagree, stop and report.

## Answers to the fourteen questions

1. **Front door for legacy couriers.** A courier subdomain on the company domain, pointed at the same deployment per network: `couriers.pillgh.com` for Mainnet and `couriers-testnet.pillgh.com` for Testnet. The pinet host stays the front door for Pioneers and guests. This is a deliberate amendment to CLAUDE.md invariant 4; propose the new invariant wording in the Phase 1 notes, do not edit CLAUDE.md. Courier sign-in still uses typed codes only, never links. The founder adds the domains in Vercel and DNS by hand; list the exact records needed.
2. **Phase 1 scope.** Yes. `guest/mine` and the `confirm-delivery` courier branch move to `resolveCourier` in Phase 1, matching on a new `guest_jobs.assigned_courier_id uuid` (option i). `assigned_courier` keeps holding `pi_username` for Pioneers. No prefixed strings in `assigned_courier`.
3. **Sign-in option.** Operator-issued one-time codes (option C) for onboarding and for signing back in. The founder verifies the courier on WhatsApp and issues a short-lived single-use code; the courier types it on the courier host. Sessions should be long-lived so re-issue is rare. SMS OTP comes later through a local Ghanaian gateway, priced first; not in Phase 1. The WhatsApp API question does not matter for option C.
4. **Orphan tables.** Read, then drop. Draft a read-only catalog query that returns row counts and column lists for `couriers` and `legacy_couriers` per network. The founder runs it. If any rows hold real people's details, the founder records the count and drops the table by hand after the PiVerify webhook is retargeted. Draft the drop as a separate migration, applied only on the founder's go-ahead.
5. **Pioneer link.** Standalone `pi_username` on the new registry with its own partial unique index, no foreign key to `pioneers` (option b). Name the table `courier_registry`.
6. **Declared value.** Required on every new guest job. Rejected above GHS 500 during the pilot (the Trancova pilot liability cap). Buffer couriers are refused above GHS 200. **Never shown to any courier:** a visible parcel value is a theft incentive. It is used server side for eligibility only, and shown to the sender and operator.
7. **30-day pause.** Option C: computed on read for enforcement, and the dispatch reader lists overdue buffer couriers so the founder sets the stored status by hand.
8. **Leaf and tree.** Choose whichever of L1 or L2 and M1 or M2 meets all of these, and say which: domain separation (leaf hashes prefixed `0x00`, internal nodes `0x01`, as in RFC 6962); positional order, not sorted pairs; an odd node promoted, never duplicated. The leaf timestamp is the database write time returned by the attesting RPC or UPDATE, not the request time. Event and attestor codes as proposed in the notes, subject to founder review. If neither option meets all of these, stop and propose one that does. No leaf code in Phase 1.
9. **Wording.** Confirmed: only the Merkle root goes on chain. Leaf fields stay off chain; each leaf hash is committed through the root. The brief's "on chain only" list was imprecise; read it as "inside the leaf".
10. **Scheduler.** Supabase pg_cron with pg_net, bearer secret in Supabase Vault. Draft the read-only extension check first. Not in Phase 1.
11. **Testnet anchoring wallet.** The founder funds a fresh keypair with 2 test-Pi from his personal Testnet Pioneer wallet, never from the Testnet app wallet. The bump sequence experiment is a manual founder step before Phase 2, not Phase 1 work. Write the stellar-cli steps into the Phase 1 notes.
12. **Retention window.** 90 days after a rejected or failed PiVerify result, provisional until counsel advises. Long enough to retry KYC, short enough for data minimisation.
13. **Shredding.** By hand, per request or when the report shows a record past the window, through a service_role-only `courier_shred` function marked for founder review. No automated deletion.
14. **Commission.** 7.5 percent is current, so couriers keep 92.5 percent. The Project copy of the accuracy sheet is corrected; the installed gyema-accuracy skill will be updated by the founder. Any courier copy uses 92.5 percent, landing last, per the sheet.

## Section 5 dispositions

1, 2 and 4 (stale comments): fix in Phase 1 as comment-only changes in their own commit.
3 (CLAUDE.md invariant 1): founder applies the proposed wording by hand.
5 (`ed98f9f` targets `legacy_couriers` and assumes KYC at sign-in): retarget to `courier_registry`; drop the KYC-at-sign-in comment.
6 (95 percent): resolved by answer 14.
7 (shipped copy assumes KYC at sign-in, `components/profile-tab.tsx:241`, `README.md:97`): draft replacement wording that claims only that Pioneers sign in with their Pi account. Mark for founder review; do not ship until approved.
8 (`guest/mine` and `confirm-delivery`): resolved by answer 2.

## Phase 1 scope, final

In this order, stopping after each item for founder review:

1. Stale comments (section 5 items 1, 2, 4).
2. `courier_registry` migration with catalog checks, plus the orphan-table read query.
3. PiVerify client and webhook from `ed98f9f`, retargeted to `courier_registry` and hardened: re-fetch the session before acting, forward transitions only, processed event ids stored.
4. Courier host handling: what the app serves on the courier subdomain, what it refuses, how the Pi SDK is kept off it, and the DNS and Vercel records the founder must add.
5. Operator-issued code sign-in and `resolveCourier`, a second identity type that cannot reach any Pioneer route.
6. `guest_jobs.assigned_courier_id`, and `guest/accept`, `guest/mine` and `confirm-delivery` moved to `resolveCourier`, with buffer enforcement in accept (listed areas only, GHS 200 cap, 30-day pause computed on read).
7. `declared_value_cedis`: migration, schema, guest create form, never returned to a courier.
8. Copy drafts for section 5 item 7, marked for review.

Not in Phase 1: leaves, Merkle code, anchoring transaction, scheduler, verify page, SMS OTP.
