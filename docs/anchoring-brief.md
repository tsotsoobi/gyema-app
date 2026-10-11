# Brief: Delivery anchoring and courier trust bureau

Owner: Adokwei. Drafted 8 Oct 2026. Save as `docs/anchoring-brief.md` on a branch `feat/anchoring-design`.

This brief turns the adopted spec into code. The spec is the source of intent; this repository is the source of truth. Where they disagree, stop and report the disagreement. Do not resolve it by guessing.

## Read first, in this order

1. `CLAUDE.md` in this repository. Every rule there still binds, above this brief.
2. The spec, pasted below this brief by the founder (Project doc `claude/GYEMA_SPEC_anchoring_trust_bureau_2026-10-08.md`).
3. `docs/deploy-order.md` and `docs/catalog-checks.sql`, for how migrations reach each network.

Before trusting any file claim, run `pwd` and `git remote get-url origin`. This brief is for `tsotsoobi/gyema-app` (Testnet). Mainnet is read-only to you.

## What we are building, in one paragraph

Every delivery event that closes through server-side attestation (guest accept, pickup stamp, delivery stamp; Pioneer completion) becomes a leaf. Each hour the leaves are rolled into one Merkle root, and one Pi transaction from a dedicated anchoring wallet carries that root as a hash memo. Couriers, both Pioneer and legacy (Bolt, Yango, Uber), get a salted commitment at registration and climb a status ladder driven by PiVerify KYC: Registered, Buffer, Full courier, Paused. A courier can share a proof link that anyone can verify without asking Gyema. Nothing personal ever goes on chain.

## Hard rules for this work

- Agents draft; the founder applies. You never run SQL against any database, never stamp an attestation, never flip a status, never merge, never push to `main`.
- Any code that writes an attestation, a status, a leaf, or a courier status is reviewed line by line by the founder before merge. Mark every such function with a comment `ATTESTATION WRITE: founder review required`.
- Two rails never blend. Anchoring spends only Gyema's own Pi fee. A guest job never touches a Pioneer payment path.
- Nothing personal on chain, hashed or not: no phone, name, Ghana Card number, pi_uid, pi_username. On chain only: salted job hash, salted courier commitment, event type, timestamp, attestor.
- Every new table and function: service_role only, `search_path` pinned, explicit revokes from public, anon and authenticated, including EXECUTE on every new function (Postgres cannot default-revoke it). Add a catalog check for each.
- Every migration is idempotent, written for both networks, and ends with catalog verifications the founder pastes back.
- No em-dashes anywhere: code, comments, commits, docs, copy.
- No carbon figures. Reputation, escrow and payouts are never described in the present tense in user-facing copy until live.
- When the code does not explain a behaviour, the answer is that nothing implements it. Say so; do not invent a mechanism.

## Phase 0: design review (read only, no code)

Goal: confirm or correct the spec against the real tree, and settle the open design choices before any code is written. Deliver `docs/anchoring-design-notes.md` on the branch and stop.

### 0.1 Verify these claims from the 8 Oct code review

For each, quote the file and line that confirms or contradicts it:

1. Guest delivery closes only inside `guest_stamp_delivery` once both stamps land, and every job accepted since the delivery-code feature has a code minted at accept.
2. Uncoded older guest jobs close on one sender stamp and are never set to `delivered` by the app.
3. `confirm-pickup` moves a job from accepted to in transit on the sender's last-4 stamp.
4. Pioneer completion closes inside `listing_confirm_completion`, with the party derived server side.
5. There is no courier registry. Guest jobs store `pi_username` in `assigned_courier`; listings store the matched party by uid. Nothing in code references `couriers` or `legacy_couriers`.
6. Every courier-facing route resolves identity through `resolveCaller` from a Pi session, so a courier without a Pi account cannot act at all.
7. `lib/pi-platform.ts` states that `/v2/me` returns no KYC status.
8. There is no parcel value field on `guest_jobs`; `quote_cedis` is the delivery fee.
9. Off-list free-text corridors exist (`pending_quote`).
10. Tracking IDs are `GYM-` plus 3 random bytes.
11. `ed98f9f` on `feat/piverify-sandbox` cherry-picks cleanly onto current `main`; its webhook signature has no timestamp and its status writes have no ordering.
12. The only cron is daily, behind a `CRON_SECRET` bearer check, and there is no Stellar SDK dependency.

Also flag: `CLAUDE.md` invariant 1 still names `user_metadata.pi_uid`, while the code reads `app_metadata`. Propose the corrected wording; do not edit `CLAUDE.md` yourself.

### 0.2 Design decisions to present (options and trade-offs, no choice made for me)

1. **Courier table.** Propose one `couriers_v2` (or a better name) holding: UUID, class (pioneer or legacy), status (registered, buffer, full, paused), commitment salt, PiVerify session id and status, timestamps, and the Pioneer link keyed on `pi_username` per `CLAUDE.md` invariant 7. Say what happens to the two orphan tables, and how retention and shredding are enforced.
2. **Legacy courier sign-in.** A courier with no Pi account needs a session. Present at least three options (for example Supabase phone OTP via an SMS provider, a WhatsApp-verified one-time link through the existing WhatsApp Business number, operator-issued invite links), each with cost per sign-in in cedis where knowable, abuse risk, fit with the existing rate limiting and Turnstile, and how `resolveCaller` would grow a second identity type without weakening the first. Confirm whether the pinet host serves normal browsers, since legacy couriers will not be in Pi Browser.
3. **Declared value.** Where the sender enters `declared_value_cedis` in the guest create form, validation bounds, and how the accept route refuses buffer couriers above GHS 200. Note that the same field will later feed parcel cover.
4. **Buffer enforcement.** Exactly where in `/api/guest/accept` the status ladder is checked, including the listed-areas-only rule and the 30-day pending pause.
5. **Leaf format.** The canonical byte layout of a leaf, the Merkle construction (sorted pairs or positional, odd-leaf handling), and test vectors.
6. **Anchoring transaction.** Confirm from Pi documentation or the Stellar SDK that a bump sequence operation with a 32-byte hash memo is valid on Pi, the network passphrase per network, and the fee source. If you cannot confirm it from a primary source, say so; it becomes a Testnet experiment the founder runs.
7. **Scheduler.** Supabase pg_cron with pg_net calling `/api/cron/anchor` hourly behind `CRON_SECRET`, versus alternatives. Note the Vercel Hobby limit of one cron run per day.
8. **PiVerify webhook hardening.** Re-fetch the session with `getPiVerifySession` before acting, allow forward transitions only, store processed event ids, and anchor the approval event exactly once.
9. **Courier-facing design.** Screens needed: courier sign-up, KYC hand-off to PiVerify, status card (what the buffer allows, what is pending), proof link view, and a public verify page. For each, list the states, the empty and error states, and draft copy that passes the `CLAUDE.md` copy rules. Sketch layouts in words or ASCII; match the existing shadcn/ui and Tailwind patterns in `components/`.

### 0.3 Phase 0 output and stop

`docs/anchoring-design-notes.md` with: the verification table (claim, file:line, confirmed or contradicted), the nine decisions with options, a proposed slice plan, and a list of questions for the founder. Commit to `feat/anchoring-design`. Do not push. Stop and wait for the founder's decisions.

## Phase 1: first build slice (only after the founder confirms Phase 0 decisions)

Scope, nothing more:

1. Courier registry migration (drafted, not applied), with catalog checks.
2. PiVerify client and webhook, cherry-picked from `ed98f9f` (not the drill-route commits), hardened per decision 8.
3. Legacy courier sign-in, per the option the founder chose.
4. `declared_value_cedis` on guest create, with migration, schema validation and form field.
5. Buffer enforcement in `/api/guest/accept`.
6. Tests for every route touched, extending the existing vitest harness and admin mock, including: a buffer courier refused above GHS 200, refused on an off-list job, refused when paused; a replayed or out-of-order webhook unable to regress status; a legacy courier unable to reach any Pioneer route.

Not in Phase 1: leaves, Merkle batching, the anchoring transaction, the cron, the verify page. Those are Phase 2 and 3, briefed separately.

Work in small commits on a branch from clean `main`. After each numbered item, stop, summarise what changed and which lines need founder review, and wait. Run `npm run security`, the full test suite, and a production build before declaring any item done. Update `docs/deploy-order.md` with the new migrations in order, per network.

## Definition of done for Phase 1

- All tests and the build pass on the branch; gitleaks clean.
- Every migration is idempotent, both networks, with catalog verifications and an ALTER DEFAULT PRIVILEGES check still holding.
- Every attestation or status write is marked for founder review.
- No user-facing copy claims reputation, escrow or payouts as live.
- A short `docs/anchoring-phase1-notes.md` lists: what shipped, what the founder must apply by hand and in what order, Pi Browser and normal-browser checks to run on Testnet, and anything left open.
