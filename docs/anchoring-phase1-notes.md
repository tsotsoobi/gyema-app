# Anchoring Phase 1 notes

Working notes for Phase 1 on `feat/anchoring-phase1`, per `docs/anchoring-decisions.md`. Filled in item by item. The brief's closing summary (what shipped, what the founder applies by hand and in what order, browser checks, open items) is written here at the end of Phase 1.

## Testnet status, updated 10 Oct 2026

Recorded by the founder. Step numbers are those in `docs/deploy-order.md`.

- **Applied and verified on Testnet:** P1, P1b, P2, P3, P5, P7 and P8.
- **P9 applied on Testnet**, 8 Oct 2026. The founder confirms its verification result.
- **P11 and P12 applied on Testnet**, 8 Oct 2026, verification `all_present` true.
- **P12b applied on Testnet**, 10 Oct 2026 03:41, verification `all_present` true.
- **P6, in part:** `PIVERIFY_API_KEY` and `PIVERIFY_API_BASE_URL` are set on Testnet Production. `PIVERIFY_WEBHOOK_SECRET` and the webhook registration in PiVerify wait until the Phase 1 code is deployed to Testnet.
- **Not applied:** everything on Mainnet.
- **No Phase 1 code is deployed** on either network.

## Item 8 scope additions (copy drafts, founder review)

Added 8 Oct 2026. Drafted in item 8, not before. Nothing here ships until the founder approves it.

### A. Completion message claims stamps the row does not carry

Reported on Mainnet: a Mainnet guest job (ID held privately), uncoded, whose pickup and delivery were both confirmed by the sender, with no code. The tracker said "Both sender and traveller confirmed this delivery as done."

Where it comes from in code (Testnet tree, `10eb7a4`):

- `components/track-tab.tsx:103-112`, the in-app Track tab (rendered at `app/page.tsx:207`). It prints "Both sender and traveller confirmed this delivery as done." for every result whose status is `completed` or `delivered`, whatever the kind. This is the line the report matches.
- `components/track-view.tsx:390-399`, the public `/track` and `/track/[id]` page, already branches by kind. For a guest job it says "You confirmed this delivery and the courier entered your delivery code at handover." when `hasDeliveryCode` is true, and "You confirmed pickup and delivery." otherwise. That is closer, but it is chosen from `hasDeliveryCode` alone, not from the stamps on the row. A coded row set to `delivered` by hand, without both stamps, would still get the courier-code sentence.
- `components/listing-detail-sheet.tsx:870`, the Pioneer listing sheet, prints the same "Both sender and traveller" sentence. For a listing, `status` is still writable by the authenticated role (`2026-08-14_listing_completion_rls.sql:69-82`), so a `completed` row is not proof that both flags are set either.

The draft will state only the stamps actually on the row: `pickup_confirmed_by` and `delivery_confirmed_by` for guest jobs, and `sender_confirmed` / `traveller_confirmed` for listings. Where the track routes do not return those fields yet, the draft will say so and name the field to add. A row closed by hand will say nothing about who confirmed.

### B. Status chips show raw database values

- `components/guest-courier-card.tsx:103` renders `{job.status}`, so a courier sees `in_transit`.
- `components/trips-tab.tsx:290` renders `{listing.status}` the same way.

The draft will give one label map per rail, held in one place, for every value the code and the dispatch reader know: guest `posted`, `pending_quote`, `accepted`, `in_transit`, `delivered`, `cancelled`, `expired`, and listing `open`, `matched`, `in_transit`, `completed`, `expired`. An unknown value shows a neutral fallback rather than the raw string.

## Item 2: courier registry migration (drafted, not applied)

### Files

- `db/migrations/2026-10-08_courier_registry.sql`: the `courier_registry` table, with `auth_user_id` referencing `auth.users(id) on delete set null`, three partial unique indexes (`lower(pi_username)`, `piverify_session_id`, `auth_user_id`), RLS on with no policy, and service_role holding `SELECT`, `INSERT`, `UPDATE` only. No function, trigger, view or policy, and no change to any existing table. The last statement is a read-only verification returning one jsonb cell with 35 named rows and `all_present`.
- `docs/catalog-checks.sql`: `courier_registry` added to the repo-referenced lists in checks 1 and 11, seven `2026-10-08` rows in check 9, a new check 14 (columns, constraint and index definitions by name, and counts of rows breaking the timing rules), and expectations for each.
- `docs/orphan-courier-tables.sql`: decision 4's read query. Row counts and per-column non-null counts for `couriers` and `legacy_couriers`; no value leaves either table. A table missing on a network reads `exists: false`.
- `docs/pioneer-username-case.sql`: read-only counts of `pioneers.pi_username` values appearing in more than one case (also exact duplicates and untrimmed values). Counts only; no username leaves the table.
- `tests/courier-registry-migration.test.ts`: static checks on the four SQL files (14 tests).
- `docs/deploy-order.md`: a "Pending: anchoring Phase 1" section, steps P1 to P4.

### What the founder applies, in order

1. `docs/orphan-courier-tables.sql` and `docs/pioneer-username-case.sql`, each network, any time. Paste back. A non-zero `case_variant_groups` is worth reading before step 2.
2. The migration on Testnet. Read the final cell: `all_present` true.
3. `docs/catalog-checks.sql` on Testnet.
4. Mainnet, the same two, on a go-ahead.

### How it was tested

Run on 8 Oct 2026 against a throwaway `postgres:17-alpine` (PostgreSQL 17.11) in Docker, with `anon`, `authenticated`, `service_role` (bypassrls) and `gyema_reader` created as in Supabase, grant baseline section 1a applied, an `auth.users` table reduced to its key, a fake `couriers` table with two fake rows, no `legacy_couriers`, and a fake `pioneers` table holding one case-variant pair, one exact duplicate and one untrimmed value. No Gyema database was touched. Re-run in full after the `auth_user_id` and `lower(pi_username)` changes; the figures below are from that run.

- The full catalog-checks file ran before the migration (check 14 `exists: false`, the seven check 9 rows false) and after it (all seven true, check 14 with 15 columns, 11 constraints and 4 indexes, check 12 still zero rows).
- The migration ran twice; both runs exited 0 and both verifications read `all_present: true` over 35 rows.
- Against a pre-existing, differently shaped `courier_registry`, the verification read `all_present: false` with 25 rows flagged.
- 32 behaviour probes passed in one run on a fresh database: valid Pioneer and legacy inserts accepted; legacy with a username, Pioneer without one, no salt, a 16-byte salt, an untrimmed username, unknown class, status, PiVerify status or pause reason, a duplicate username, the same username in another case, a duplicate session id, a duplicate auth user, an auth user that does not exist, and nulling the salt without shredding all refused; shredding accepted, and the username reusable afterwards; deleting a linked auth user set the link null and kept the courier row; service_role select, insert and update accepted, delete and truncate refused; anon, authenticated and gyema_reader refused.
- The orphan query counted the fake table exactly and reported the absent table as `exists: false`.
- The username-case query returned the expected counts for the fake data: 5 distinct usernames, 4 once lowered, 1 case-variant group of 2 rows, 1 exact duplicate group, 1 untrimmed value.

### Choices made in the file, for review

- All three new SQL files name no network, so they mirror as bytes under the blob-hash gate. `docs/deploy-order.md` already names networks throughout and gets the change hand-applied at mirror time.
- No `DELETE` for service_role. Shredding is an `UPDATE`; a row removal would be a hand operation as the table owner.
- Timing rules (`full` has `kyc_approved_at`, `buffer` has `buffer_since`, `paused` has a reason) are reported by check 14, not enforced, because the founder sets `paused` by hand (decision 7).
- `updated_at` has no trigger. The routes set it, as they do on `guest_jobs`.

### Founder answers, 8 Oct 2026

1. `courier_shred` becomes Phase 1 item 9 (below).
2. `auth_user_id` added to this migration: `uuid null`, unique where not null, `references auth.users(id) on delete set null`.
3. Covered by item 9.
4. The `pi_username` index is on `lower(pi_username)`, and `docs/pioneer-username-case.sql` counts case variants in `pioneers`.

## Item 9 (added 8 Oct 2026): `courier_shred`, last in Phase 1

Founder review required: it destroys the link between a courier and their history.

- Shreds the registry row: nulls `commitment_salt`, `pi_username`, `piverify_session_id` and `auth_user_id`, and sets `shredded_at`.
- On that courier's `guest_jobs`, replaces `assigned_courier` with a fixed marker.
- Refuses if any of their jobs is open, or has remit outstanding.
- A service_role-only security definer function, `search_path` pinned, EXECUTE revoked from public, anon and authenticated, marked `ATTESTATION WRITE: founder review required`.

## Item 6 plan additions (8 Oct 2026)

- **Courier delivery confirmation moves under `/api/courier/`.** Couriers confirm delivery through a route under `/api/courier/`, resolved with `resolveCourier`. The courier host then refuses `/api/guest/confirm-delivery` like every other sender route: it comes out of `COURIER_GUEST_APIS` in `lib/courier-host.ts`, and the item 4 tests move it to the refused list. Founder decision on item 4.

## Item 3: PiVerify client and webhook (drafted, not applied)

From `ed98f9f` only (`lib/piverify.ts`, `app/api/kyc/webhook/route.ts`); the drill-route commits `de625a0` and `56b2297` are not taken. The verbatim cherry-pick was tried as its own commit and was red: `tests/schemas.test.ts` pins the route count and requires every route to parse through a schema, which the original webhook did not. So the cherry-pick and the hardening are one commit, carrying the `cherry picked from commit ed98f9f` line.

### What changed from `ed98f9f`

- **Retargeted.** No reference to `legacy_couriers` remains. The webhook writes nothing directly; its one write is `courier_apply_kyc_status` on `courier_registry`. The comment saying Pioneers are KYC-verified by Pi Browser sign-in is gone (dispositions, item 5).
- **The payload is a notification, not a source of truth.** After the HMAC, the route reads only the event id, type and session id (`PiVerifyWebhookBody` in `lib/schemas.ts` carries nothing else), re-fetches the session with `getPiVerifySession`, and passes PiVerify's current status and `external_user_id` to the function. If the re-fetch fails, it answers 503 and writes nothing.
- **Client hardening** in `lib/piverify.ts`: a 10-second timeout on both PiVerify calls; responses checked for id, `external_user_id` and a known status rather than cast; upstream response bodies kept out of thrown errors, so they never reach a log.
- **`db/migrations/2026-10-08_piverify_webhook.sql`** (new; the item 2 file is unchanged): `piverify_events` (processed event ids and outcomes, service_role SELECT only) and `courier_apply_kyc_status` (security definer, `search_path` pinned, EXECUTE for service_role only, marked for founder review). Under a row lock, in one transaction:
  - one event id is processed once (`duplicate` otherwise)
  - forward only (`created` < `started` < `pending_review` < terminal)
  - approval recorded once per courier: a courier holding `kyc_approved_at` gets `not_forward` for anything further, from any session, and a unique index on `piverify_events` backs it up
  - the session must be the one bound to the courier PiVerify names
  - an operator pause is never lifted
  - `piverify_status_at` is set on every applied change

### Outcomes and what the route answers

| Outcome | Stored | Route |
| --- | --- | --- |
| `applied` | yes | 200 |
| `not_forward` | yes | 200 |
| `unknown_courier` | yes | 200 |
| `stale_session` (event about a session no longer bound) | yes | 200 |
| `external_user_mismatch` (session bound to another courier) | yes | 200 |
| `shredded` | yes | 200 |
| `duplicate` | already stored | 200 |
| `session_not_bound` (courier exists, no session bound yet) | no | 503, PiVerify retries |
| function error | rolled back | 500, PiVerify retries |

### How it was tested

- **Route:** 24 tests in `tests/routes/piverify-webhook.test.ts` (21 at first review, 3 added with the replay change), with PiVerify mocked and real HMACs. They cover:
  - no secret, no signature, a wrong key and a body altered after signing (refused before any fetch or write)
  - the payload saying `approved` while PiVerify says `started` (the function receives `started`)
  - `external_user_id` taken from the re-fetch
  - re-fetch failures, a malformed session and a different session id (nothing written)
  - each function outcome mapped to its status code
  - no direct table write
  - source checks that the route never reads the payload's status
- **Migration:** 10 static tests in `tests/piverify-webhook-migration.test.ts`.
- **Database:** run on 8 Oct 2026 against a throwaway `postgres:17-alpine` (17.11), with item 2's migration first. No Gyema database was touched.
  - The migration ran twice: both exited 0, with 16 of 16 verification rows each time.
  - Catalog checks before and after: the six check 9 rows went from 0 to 6, check 7 shows service_role only, and check 12 stayed at zero rows.
  - 48 behaviour probes passed in one run on a fresh database:
    - the full ladder for one courier, with `buffer_since` and `kyc_approved_at` each written once
    - a replayed event id, a stale `started` after `pending_review`, and a second approval from a new session on a full courier, all changing nothing
    - an event on an old session (`stale_session`)
    - an unbound session left unrecorded, then applied on retry after binding
    - `rejected` pausing with its reason
    - an operator pause kept through approval, with the facts still recorded
    - a timeout pause lifted by a late approval
    - unknown, malformed, mismatched and shredded couriers
    - bad input refused with nothing recorded
    - the unique index refusing a forced second approval
    - service_role able to execute and read but not write `piverify_events`; anon and authenticated refused
- **Not tested:** two events for one courier arriving at the same instant. The row lock serialises them by construction, but the probes ran sequentially.

### Founder decisions, 8 Oct 2026

1. Session creation, and "a new session returns the courier to Registered", go in **item 5**. Item 5 also refuses a new session for a courier already `full`.
2. Kept: approval never lifts an operator pause. A `pending_timeout` pause IS lifted by approval. Both confirmed by probe (couriers C and F in the run above).
3. Kept: a webhook never demotes a full courier.
4. The webhook registers on the raw Vercel URL, per network (`docs/deploy-order.md`, P6).

### Change after review: a replay costs no outbound call

Before re-fetching the session, the route reads `piverify_events` for the event id and answers `duplicate` from the record, without calling PiVerify or the function. A replayed signed request therefore cannot drive outbound calls. A failed read answers 500, without calling PiVerify. The function's own duplicate check stays, for two copies arriving at once. Three route tests cover it (24 route tests in all).

`PIVERIFY_API_BASE_URL` points at a staging domain the docs say will change. It is env, not code, so the change is a Vercel setting and a redeploy.

### Fixes after review, 8 Oct 2026, from PiVerify's API documentation

Read from the founder's private copy of PiVerify's API documentation, which stays out of the repo.

**1. A rejection is not always final.** A rejected session can carry `allowed_action`, `RESUBMIT` or `APPEAL`. When it does, the courier goes back through the hosted flow on the same session, which can move to `started`, `pending_review` and `approved` again. The applied function treated `rejected` as terminal, so every one of those events read `not_forward` and the courier stayed paused for good.

- **`db/migrations/2026-10-08_piverify_resubmission.sql`** (new; the applied P5 file is unchanged):
  - `courier_registry.piverify_allowed_action`, the `allowed_action` of the courier's current rejection. A check holds it to `RESUBMIT` or `APPEAL`, and only while `piverify_status` is `rejected`.
  - `piverify_events.allowed_action`, what the re-fetched session said on each event. A record only; nothing decides on it.
  - `courier_apply_kyc_status` takes a sixth argument, `p_allowed_action`. The five-argument version is dropped, not left beside it, and the new one is revoked from public, anon and authenticated and granted to service_role.
- **The rule.** A courier at `rejected` with a stored `allowed_action` is reopened. On the bound session, `started`, `pending_review`, `approved` and `failed` then apply, as does a further `rejected` with a different `allowed_action`. A rejection with no `allowed_action` is final, and a later event cannot make it otherwise. `created` never applies after a reopen.
- **Every other rule kept:** one event id once, approval once (`kyc_approved_at` still stops everything, and the unique index still backs it), the session must be the bound one, an operator pause is never lifted, and a full courier is never demoted.
- **`allowed_action` is taken from the re-fetched session only**, like the status. A value present but not one of the two is refused in `lib/piverify.ts`, the same as an unknown status: the route answers 503 and writes nothing. On any status but `rejected` the function drops it rather than storing it.
- **A correction the reopen needed.** The old function wrote the PiVerify status into `paused_reason` whenever the courier ended up paused. Before this fix a paused courier almost never received `started`; after it, that is the normal resubmission path, and the old line would have written `'started'`, which the `paused_reason` check refuses, so every resubmission would have answered 500. The reason is now written only for `rejected` and `failed`.

**Choices, approved by the founder on 8 Oct 2026 as drafted:**

- **Status during a resubmission.** The ladder is unchanged. A rejected courier is `paused` with reason `rejected`, and stays so through `started` and `pending_review`; approval takes them to `full` and clears the reason, as it does for a timeout pause. They do not return to `buffer` while the resubmission is reviewed. The alternative is `buffer` on `pending_review`.
- **`allowed_action` is recorded on each event row too**, for the audit trail. The function decides only on the registry column.
- **A hard check ties `piverify_allowed_action` to `piverify_status = 'rejected'`.** A hand edit of `piverify_status` on a row holding an `allowed_action` has to null it in the same statement.

**Order.** P9 needs P5, and goes in before the Phase 1 code deploys. The route calls the six-argument function, and until it exists every signed webhook answers 500. P5 must not be re-run after P9: it re-creates the five-argument function. The P9 verification and catalog check 9 both count the signatures and read false if that happens, and re-running P9 fixes it (`docs/deploy-order.md`, P9).

**Tested.**

- **Route:** 27 tests, 3 new: `allowed_action` passed from the re-fetch, the payload's `allowed_action` never used, and an unknown value refused with 503 and nothing written.
- **Migration:** 11 static tests in `tests/piverify-resubmission-migration.test.ts`.
- **Database:** run on 8 Oct 2026 against a throwaway `postgres:17-alpine` (17.11), with P2, P5 and P7 first. No Gyema database was touched.
  - Without P5 the file stopped at `piverify_events`, and as one transaction nothing landed.
  - With P5 it ran twice, exiting 0 both times with 10 of 10 verification rows.
  - The catalog check before and after: the three new check 9 rows went from false to true; check 7 showed only the six-argument function; check 14 went from 15 columns and 11 constraints to 16 and 12; check 12 stayed empty.
  - Re-running P5 afterwards brought back the five-argument function, and check 9's signature row read false. Re-running P9 removed it.
  - All 48 earlier probes, ported to the six-argument function, passed again.
  - 67 new probes passed:
    - **Resubmit then approve:** paused with reason `rejected` through `started` and `pending_review`, then `full` with the reason cleared and one recorded approval.
    - **Appeal then approve.**
    - **A final rejection stays final:** `started`, `approved` and a later `RESUBMIT` all read `not_forward`.
    - **Resubmit, then rejected again with no action:** final from there.
    - **An operator pause through a resubmitted approval:** still paused, with the approval recorded.
    - **The same rejection reported twice:** `not_forward`. A changed `allowed_action` applies.
    - **`created` after a reopen:** `not_forward`.
    - **A full courier:** untouched by a rejection or a failure.
    - **`failed` after a reopen:** applies, and is final.
    - **A stray `allowed_action` on another status:** not stored.
    - **Refused:** an unknown or lower-case `allowed_action`, a hand-set `allowed_action` on an approved row, and the five-argument call.
    - **Privileges:** service_role can execute; anon and authenticated are refused.

**2. Missed webhooks: item 5 must poll.** PiVerify retries a failed delivery only 5 times, and counts any answer slower than 10 seconds as a failure. A courier whose webhooks are all lost would be stranded at their last applied status. So **item 5 must poll `GET /api/v1/kyc_sessions/:id` as a fallback** for any courier whose session status stops changing, so that a missed webhook cannot strand them.

**Item 5 polling event id (founder decision, 8 Oct 2026).** `courier_apply_kyc_status` needs an event id, and a poll has none from PiVerify. Each poll result gets a deterministic one:

`poll:<session_id>:<status>:<allowed_action or ->:<PiVerify updated_at>`

The same observation polled twice is the same id, so it reads `duplicate` and writes nothing new. A new state (a new status, allowed action or `updated_at`) is a new id, and applies once. A state the webhook already applied reads `not_forward` from the poll, under its own id. For item 5 to settle when it is written:

- `piverify_events.event_id` is at most 128 characters (`piverify_events_lengths_check`). A PiVerify session id is short (the `ks_` form), so a poll id fits with room to spare, but item 5 must refuse, not truncate, a session id long enough to break it.
- `updated_at` goes in exactly as PiVerify returns it, never reformatted, so the same observation always builds the same id.
- `event_type` for a poll is its own value, so a poll and a webhook are told apart in `piverify_events`.

## Item 4: courier host handling (drafted, not deployed)

Per decision 1: a courier subdomain on the company domain per network, pointed at the same deployment as the pinet host. Item 4 is host handling only: no sign-in, no session, no code entry (item 5).

### How the app knows which host it is on

- **`lib/courier-host.ts`** compares the request's Host header with `COURIER_HOST`, a per-project Vercel env var holding the hostname only. The match is exact, ignoring case, port and a trailing dot; lookalikes do not match. Unset or empty means no courier host anywhere, so every courier path is refused. It fails closed.
- **No code names a courier host.** Each deployment is told its own, so the two networks' hosts cannot swap through a copied file, and the new files mirror as bytes.
- **`middleware.ts`** sets `x-gyema-surface` (`courier` or `pioneer`) on every request, always overwriting whatever the client sent; a test sends the spoof. The layout reads it the same way it reads the nonce.

### What the courier host serves

| Path | What |
| --- | --- |
| `/` | Rewritten (not redirected) to `/courier`, so the address bar stays at the bare host |
| `/courier`, `/courier/*` | The courier page. Today one heading and one sentence, "Courier sign-in is not open yet." (COPY DRAFT), titled "Gyema couriers", `noindex`. Item 5's pages go under it. |
| `/api/courier/*` | Nothing yet; item 5's sign-in APIs |
| `/api/guest/open`, `/api/guest/accept`, `/api/guest/mine`, `/api/guest/confirm-delivery` | The courier job flow. Until item 6 moves them to `resolveCourier` they accept Pioneer sessions only, so here they answer exactly as anywhere else. |
| Static files, which bypass middleware by design | `/_next/static/*`, `/_next/image`, the icons, and every public `.png`, `.jpg`, `.svg`, `.txt` and `.html` file (`privacy.html`, `terms.html`, `methodology.html`, `validation-key.txt`, the placeholders). Served on every host, as today. |

On the courier host, the test environment marker is `components/courier-test-banner.tsx`: "Test environment. Deliveries here are not real." (COPY DRAFT). It shows only when `NEXT_PUBLIC_IS_TESTNET` is `true`. The Pioneer banner is not shown there, because it sends people to the pinet host in Pi Browser.

### What it refuses

A plain 404 (`{"error":"not_found"}` for `/api/*`, `Not found` otherwise), with no pointer to the other host:

- **Pioneer and sender pages:** `/send`, `/track`, `/track/<id>`
- **Pi sign-in and the Pioneer rail:** `/api/auth/verify`, every `/api/listings/*`, every `/api/payments/*`
- **The sender's guest routes:** `/api/guest/create`, `/track`, `/confirm-pickup`, `/delivery-code`
- **Server to server:** `/api/kyc/webhook` (registered on the raw Vercel URL, P6) and `/api/cron/*`

**On every other host** (the pinet host, the raw Vercel URL, previews, localhost), `/courier/*` and `/api/courier/*` are refused, so a courier identity cannot be used through the Pioneer front door. Everything else there is unchanged.

### How the Pi SDK is kept off

1. **`app/layout.tsx`** renders the two SDK tags (`pi-sdk.js` and the `Pi.init` script) only when the surface is not `courier`. If middleware never ran, the header is absent and the Pioneer behaviour is kept.
2. **The courier host gets its own CSP,** `buildCourierCsp` in `lib/csp.ts`. It names no Pi origin (no minepi, pinet or piappengine) and sets `script-src 'self'` plus the nonce, `frame-ancestors 'none'`, `frame-src 'none'` and `form-action 'self'`. It is always sent as the enforcing `Content-Security-Policy`, whatever `CSP_ENFORCE` says.
3. **Middleware adds two headers on the courier host,** refusals included: `X-Frame-Options: DENY` and `X-Robots-Tag: noindex, nofollow`. They are set there and not in `next.config.mjs`, because the pinet host must stay frameable.
4. **No courier file imports the Pi client.** A test reads every file under `app/courier`, plus the banner and the host module, and refuses any `lib/pi-network` import, `sdk.minepi.com` or `window.Pi`.

### Tested

- **21 tests in `tests/courier-host.test.ts`:** host matching and lookalikes, failing closed, the path rules, every refused route, the rewrite, the CSP and headers, the spoofed surface header, the layout gate, and the imports. They use placeholder hosts.
- **Updated tests:** `tests/headers.test.ts` (the middleware's env reads are now `COURIER_HOST` and `CSP_ENFORCE`; `*.localhost` skips the https redirect while lookalikes do not) and `tests/csp.test.ts` (the layout's nonce read).
- **Live, against the production build** (`next start`, `COURIER_HOST=couriers.localhost`):
  - **Courier host:**
    - `/` answered 200 with the courier page, title "Gyema couriers", a robots `noindex` meta tag, and no `sdk.minepi.com` and no `pi-init` in the HTML.
    - `/send` answered 404 `Not found`, and `POST /api/kyc/webhook` answered 404 JSON.
    - `/api/guest/open` reached its handler. It answered 500 locally only because the local build has no Supabase env.
    - The response headers carried the courier CSP, `X-Frame-Options: DENY` and `X-Robots-Tag`.
  - **Other host:** `/courier` and `/api/courier/x` answered 404, and the page HTML still carries the SDK tag. A spoofed `x-gyema-surface: courier` changed nothing.

### Founder steps (P10), per network

**DNS for pillgh.com as read from public resolvers, 8 Oct 2026:**

- **Nameservers:** `dns1` to `dns4.p01.nsone.net` (Netlify DNS)
- **Apex:** A records to GitHub Pages (`185.199.108.153` to `185.199.111.153`); `www` is a CNAME to `tsotsoobi.github.io`
- **Zoho mail:** MX `mx.zoho.com` (10), `mx2.zoho.com` (20), `mx3.zoho.com` (50); TXT `zoho-verification=...` and `v=spf1 include:zohomail.com ~all`
- **No CAA record,** so nothing blocks the certificate Vercel issues
- **`couriers`, `couriers-testnet` and `_vercel` do not exist** yet, and there is no wildcard

**1. Vercel, Testnet project** (`gyema-app`): Settings, Domains, Add, `couriers-testnet.pillgh.com`, connected to Production. Vercel then shows the DNS record it wants. **Copy the value it shows.** It is either `cname.vercel-dns.com` or a project-specific `<hash>.vercel-dns-0xx.com`, and I cannot know which before the domain is added.

**2. Netlify DNS** (`pillgh.com` zone, Add new record):

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| CNAME | `couriers-testnet` | the target Vercel showed in step 1 | default (3600) |

Netlify appends `.pillgh.com` to the name. **Only if** Vercel says the domain needs verification (it is linked to another Vercel account or project), also add the TXT record it shows:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| TXT | `_vercel` | the `vc-domain-verify=...` value Vercel showed | default |

`_vercel` is its own name. It shares nothing with Zoho's apex TXT, the MX records or the DKIM key. **Do not** add an A record, touch the apex, the MX or TXT records or `www`, or add a CAA record.

**3.** Wait until Vercel shows the domain as Valid Configuration with a certificate issued.

**4.** Testnet project, Settings, Environment Variables: `COURIER_HOST` = `couriers-testnet.pillgh.com`, Production only, hostname only (no `https://`, no slash). Then redeploy, as for any env change.

**5. Checks:**
- `https://couriers-testnet.pillgh.com/` shows "Gyema couriers" with the red test banner, and view-source has no `sdk.minepi.com`.
- `https://couriers-testnet.pillgh.com/send` shows `Not found`.
- `https://gyema-app.vercel.app/courier` shows `Not found`. This is the raw Vercel URL, used here only as a check and never in copy. The pinet host is not a check for this, because in a normal browser it serves a wrapper page.
- The response headers on the courier host carry `x-frame-options: DENY`.
- The Pioneer app still signs in, in Pi Browser.

**Mainnet,** on a go-ahead: the same five steps in the Mainnet project, with `couriers.pillgh.com`, a Netlify CNAME named `couriers`, and `COURIER_HOST=couriers.pillgh.com`.

**HSTS:** the app's `includeSubDomains` header, sent from the courier host, covers that host and names under it only. It does not reach `pillgh.com` or `www`, which stay on GitHub Pages.

### Proposed invariant 4 wording (CLAUDE.md; the founder applies it)

> 4. **Two front doors, never crossed.** The registered pinet production host is the front door for Pioneers and guests. Couriers without a Pi account use the courier host on the company domain, one per network: `couriers.pillgh.com` for Mainnet, `couriers-testnet.pillgh.com` for Testnet. Public copy and share surfaces carry only these hosts, never the raw Vercel URL. The Mainnet and Testnet hosts never swap. The courier host never loads the Pi SDK, and neither surface links to the other's host. A deployment knows its courier host only from `COURIER_HOST`; no code names it.

Also added to the pending CLAUDE.md edits in `docs/anchoring-design-notes.md`, section 7. The mirror scan needs no new term: no file names a courier host.

### Choices for review

1. **The courier CSP follows `CSP_ENFORCE`,** report-only by default, like the pinet host. Nothing on the courier host loads the Pi SDK, so it could enforce always. `X-Frame-Options: DENY` enforces regardless.
2. **`/api/guest/confirm-delivery` is allowed on the courier host for its courier branch,** so its sender branch (last 4 digits) is reachable there too. It is public on the pinet host already. Item 6 can split it if that matters.
3. **A refusal is a bare 404,** never a redirect or a pointer to the other host.
4. **Any `*.localhost` name now skips the https redirect,** so `COURIER_HOST=couriers.localhost` works with `next dev`. Browsers resolve those names to loopback, and Vercel never routes one here. Lookalikes such as `localhost.example.test` still redirect.
5. **Copy drafts:** the courier page sentence and the courier test banner sentence.

### Founder decisions, 8 Oct 2026

1. **The courier host CSP is always enforced,** whatever `CSP_ENFORCE` says. `CSP_ENFORCE` governs the pinet host (and every other non-courier host) only. A test sends a courier host request with `CSP_ENFORCE` unset and expects `Content-Security-Policy`, not the report-only header.
2. **`confirm-delivery` stays as is for now.** Added to the item 6 plan: couriers confirm delivery through a route under `/api/courier/`, and the courier host then refuses `/api/guest/confirm-delivery` like every other sender route (it leaves `COURIER_GUEST_APIS`).
3. **The `*.localhost` loopback rule stays.**
4. **Both copy drafts stay as marked.** The site title waits for item 8.

### Reported, not changed

- **The site title at `app/layout.tsx:13` has an em-dash between "Gyema" and "P2P Delivery on Pi",** in user-visible copy. The courier page sets its own title. The fix belongs with item 8's copy drafts, unless you want it sooner. The comment em-dashes in the SDK block were removed, since that block was rewritten here.
- **Mirror:**
  - Mirror as bytes: `lib/courier-host.ts`, `app/courier/page.tsx`, `components/courier-test-banner.tsx`, `middleware.ts` and `tests/courier-host.test.ts`.
  - Already network-specific by the scan, so the change is hand-applied: `app/layout.tsx`, `lib/csp.ts`, `README.md`, `tests/headers.test.ts`, `tests/csp.test.ts` and the docs.

## Item 5 (approved 8 Oct 2026): operator-issued code sign-in and `resolveCourier`

Design approved by the founder, 8 Oct 2026, with the decisions in 5.7. No code, no SQL file, nothing applied yet. Every function below that writes is marked for founder review. The idempotency key, raised by PiVerify's documentation after approval, was decided the same day (5.4).

### 5.0 The decision everything else hangs on: what a courier session is

**Proposed: an opaque server-side session in a new `courier_sessions` table, carried in a host-only HttpOnly cookie. Couriers never hold a Supabase Auth user or JWT.**

The design notes (decision 2, `docs/anchoring-design-notes.md:111`, option C at `:117`) planned a Supabase Auth user per legacy courier with `app_metadata.courier_id`, and item 2 added `courier_registry.auth_user_id` for it. That model has two costs this one avoids:

- **A Supabase JWT is a Pioneer surface in all but name.** With the public anon key, a courier's access token reaches PostgREST directly as `authenticated`: the listings reads, the `listings` INSERT policy, `listing_counterpart_contact`. Each refuses a token with no `app_metadata.pi_uid` today, but "cannot reach any Pioneer route" would then depend on every future policy and RPC remembering to.
- **Revocation is weak.** `signOut` revokes refresh tokens; an issued access token stays valid until it expires. A long-lived session would also need a refresh token kept in JavaScript-readable storage.

An opaque token checked by hash on every request is revoked the moment its row is. **`auth_user_id` under this model:** nothing writes it for a legacy courier. It stays (nullable, unused). Item 6 can use it for Pioneer couriers if wanted, or it can be dropped by a later migration (decision 1).

### 5.1 How the founder issues a code

**Creating the legacy row.** The prompt binds a code to one existing `courier_registry` row, which overrides option C's "redeeming creates the row". So the founder needs a hand-run way to create a legacy row, and the registry deliberately has no salt default (`2026-10-08_courier_registry.sql`, header: "would need pgcrypto").

- `courier_register_legacy()` returns `(courier_id uuid)`. Inserts `class = 'legacy'`, `status = 'registered'`, and a 32-byte salt.
- **Salt source, core Postgres only:** `sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()))`. `gen_random_uuid` is core since PG13 and draws from the strong random source. Two v4 UUIDs carry 244 random bits, hashed to 32 bytes. The salt hides a commitment and 244 bits is far past need. No extension, no `search_path` dependency on `extensions`.
- Not chosen (decision 2): `extensions.gen_random_bytes(32)`, which would have needed this read-only pre-flight per network first: `select extname, extnamespace::regnamespace, extversion from pg_extension where extname = 'pgcrypto';` (decision 2).

**Issuing a code.** `courier_issue_signin_code(p_courier_id uuid)` returns `(code text, expires_at timestamptz)`.

- **Refuses:**
  - an unknown id
  - a shredded row
  - a `pioneer` row (Pioneers sign in with Pi)
- **Revokes any live code** for that courier first, so at most one code is live per courier. A partial unique index backs this.
- **Code format:** 10 characters of Crockford base32 (`0-9` plus 22 letters, no `I L O U`), shown as `XXXXX-XXXXX`.
  - Generated from 10 fully random bytes of one `gen_random_uuid()`. The version and variant bytes (6 and 8) are skipped, and each byte is taken `& 31`, which is uniform because 256 is a multiple of 32.
  - 50 bits.
- **TTL: 15 minutes.** The founder issues the code while on WhatsApp with the courier.
- **Stored only as `sha256` of the normalised code** (upper case, `-` and spaces removed, `O` read as `0`, `I` and `L` as `1`). The plaintext appears once, in the editor's result grid.
- **No pepper.** A pepper would need a secret inside the database (Vault) for the SQL function to use it. Anyone who can read the hash already reads everything, and the code dies in 15 minutes.

**Revoking.** `courier_revoke_sessions(p_courier_id uuid)` returns `(sessions_revoked int, codes_revoked int)`. It is the founder's lost-phone and "stop this courier now" control.

**All three are `security definer`, `search_path = public, pg_temp`, marked `IDENTITY WRITE: founder review required`, and owner-only (decision 3): EXECUTE is revoked from public, anon, authenticated AND service_role, and granted to nobody.** The SQL editor runs as `postgres`, the owner, so the founder can call them; the app's service_role key cannot mint a code, register a courier or revoke sessions. Catalog rows prove it (5.5).

**Mapping a courier id to a person (decision 9).** The registry stores no name, phone or label, by design, and no column is added for one. Instead, `GET /api/courier/me` returns a **courier reference**: the first 8 characters of the courier id. The courier page shows it as "Your courier reference: XXXXXXXX" (COPY DRAFT). The reference is shown only to the signed-in courier. It is a lookup aid, never a credential: no route accepts it as input, and nothing signs in or acts by it.

**Onboarding, in order:**

1. The founder verifies the courier on WhatsApp.
2. The founder runs `courier_register_legacy()` and notes the first 8 characters of the returned id beside the courier's WhatsApp contact.
3. The founder runs `courier_issue_signin_code(<id>)` and sends the code on WhatsApp.
4. The courier signs in on the courier host.
5. **The courier reads their courier reference back to the founder on WhatsApp before taking a job.** The founder checks it against the note from step 2. A mismatch means the code reached the wrong person: the founder runs `courier_revoke_sessions` and starts again.

The same read-back follows any later re-issued code.

### 5.2 Sign-in route, limits, session

**Routes**, all under `/api/courier/`. They are served only on the courier host (middleware, item 4) and each parses through a schema (`tests/schemas.test.ts` count goes from 20 to 25):

| Route | What |
| --- | --- |
| `POST /api/courier/sign-in` | `{ code }`. Normalise, hash, call `courier_redeem_signin_code`, set the cookie. |
| `POST /api/courier/sign-out` | Revokes the caller's own session, clears the cookie with the same name, `Secure` and `Path=/` (a browser ignores a `__Host-` clear without them). |
| `GET /api/courier/me` | The status card: the courier reference (first 8 characters of the courier id), courier `status`, `piverify_status`, `piverify_allowed_action`, whether KYC can start. Nothing else. |
| `POST /api/courier/kyc/start` | 5.4 |
| `POST /api/courier/kyc/refresh` | 5.4, the poll |

**Redemption is one function**, `courier_redeem_signin_code(p_code_hash bytea, p_token_hash bytea)`. It is service_role EXECUTE only and marked for founder review. In one transaction, with the code row locked:

1. It finds the code by hash. Unknown, used or revoked all answer `no_match`; past `expires_at` answers `expired`. Telling a real courier "expired" costs nothing, because a guesser who hits a real expired code is a 2^-50 event.
2. It refuses if the courier is shredded (`unavailable`).
3. It marks the code consumed.
4. It revokes every other live session for that courier (reason `replaced`): one device at a time (decision 5).
5. It inserts the session with its expiry, set in SQL from `now()`.

It returns `(outcome, courier_id, expires_at)`. The courier id comes from the code row and never from the request (invariant 1).

**Session token:** `gcs_` plus base64url of 32 random bytes from Node `randomBytes`. The prefix means it can never parse as a JWT. Only `sha256(token)` is stored.

**Cookie:** `__Host-gyema_courier`, `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`, `Max-Age` equal to the absolute lifetime left.

- `__Host-` makes the browser enforce host-only, `Secure` and `Path=/`, so the cookie is never sent to the pinet host or the raw Vercel URL.
- **Strict and the WhatsApp tap.** The courier arrives by a cross-site top-level navigation, on which a Strict cookie is not sent. So the page renders a neutral shell and learns session state from `GET /api/courier/me` after load. That fetch is same-site, and the cookie goes with it. No server component reads the cookie.
- **CSRF:** Strict, plus every state-changing courier route requires `Content-Type: application/json` and an `Origin` whose hostname equals `COURIER_HOST`.
- **Local dev:** `__Host-` requires `Secure`. Chrome and Firefox accept Secure cookies on `http://*.localhost`; Safari may not. Local courier testing is in Chrome.

**Lifetime:** 90 days absolute, 30 days idle (decision 6). `last_seen_at` is bumped at most once an hour, so a normal request does not write.

**Revocation, every path:**

- sign-out (`signout`)
- a new sign-in (`replaced`)
- the founder's `courier_revoke_sessions` (`operator`)
- `courier_shred` (`shredded`). This is added to item 9's scope: shredding also revokes the courier's sessions and codes.

`resolveCourier` refuses a revoked, expired or idle session, and a shredded courier, on the next request.

**Rate limits**, new `LIMITS` entries in `lib/rate-limit.ts`, network-namespaced like the rest:

| Bucket | Key | Limit | On Redis error |
| --- | --- | --- | --- |
| `courier_signin_ip` | IP | 10 per 15 m | closed |
| `courier_signin_global` | the constant `all` | 300 per 1 h | closed |
| `courier_kyc_start` | courier id | 10 per 1 d, spent on every call past `resolveCourier` | closed (each call is an outbound call, and PiVerify answers 429 when called too often; per PiVerify's docs a credit is charged only at `pending_review`, see 5.4). Raised from 3 (founder decision, 9 Oct 2026): Continue verification re-fetches cost nothing, creates are bounded by the bound-session rule, the idempotency key and the bind, and couriers on unreliable mobile data must not be locked out mid-flow |
| `courier_kyc_refresh` | courier id | 2 per 1 m | closed (each is an outbound call) |
| `courier_me` | courier id | 60 per 10 m | open |

**Lockout, said plainly.** The courier types only a code, with no username or phone, so a wrong guess cannot be attributed to a courier and per-courier lockout is not possible. Per-IP is weak under carrier-grade NAT (`lib/rate-limit.ts`, header). **The control is code entropy:**

- With k live codes, each guess succeeds with probability k / 2^50, about k / 1.1e15.
- The global bucket caps guessing at 7,200 a day. With 5 codes live around the clock, that is about 3e-11 a day.

The single use and the 15-minute TTL are the lockout per code. The global bucket is a circuit breaker on database load. Its cost: anyone can exhaust it and block every courier's sign-in for up to an hour. Sign-in is rare under long sessions, and a signed-in courier is unaffected (decision 7).

**Turnstile:** not in Phase 1. The courier CSP names no Cloudflare origin and would have to grow one (decision 8).

### 5.3 `resolveCourier`, a second identity type

**`lib/courier-auth.ts`**, separate from `lib/route-auth.ts`, so the Pioneer routes' import graph never contains it.

```
resolveCourier(admin, request) -> { ok: true, courier: { kind: "legacy", courier_id, status,
  piverify_status, piverify_allowed_action, kyc_approved_at } } | refusal
```

1. If `x-gyema-surface` is not `courier`, it answers `no_session` (401) without touching the database. Middleware always overwrites that header (item 4).
2. It reads the token from the `Cookie` header only. Never the body, never `Authorization`.
3. It checks the format `^gcs_[A-Za-z0-9_-]{43}`, hashes the token and calls `courier_session_resolve(p_token_hash)`. That is one service_role-only function. It returns the courier, or nothing for an unknown, revoked, expired or idle session or a shredded or non-legacy courier. It bumps `last_seen_at` when an hour has passed.
4. A database error answers 503 `auth_unavailable`, mirroring `CallerRefusal`, so a blip is not reported as "signed out".

**Scope.** Item 5 resolves legacy couriers only. The Pioneer-courier branch (`resolveCaller`, then a registry lookup on `lower(pi_username)`) and the hybrid `guest/accept` and `guest/mine` belong to item 6 (decision 10).

**Why neither credential crosses:**

- **Pioneer routes** read `accessToken` from the JSON body and pass it to `admin.auth.getUser` (`lib/route-auth.ts:113`). A `gcs_` token there is not a JWT, so GoTrue refuses it, the result is `bad_token`, and the route answers 401. The cookie is never read.
- **Courier routes** never call `getUser` and never read a body token.
- The browser never sends the cookie off the courier host, and middleware refuses `/api/courier/*` on every other host.

**Tests:**

- `tests/routes/identity-separation.test.ts` holds a classification table of every `route.ts` under `app/api`: `pioneer`, `courier`, `public`, `server`. A route missing from it fails the test, so "every Pioneer route" is a list, not a complement.
  - **Each Pioneer route** gets a request carrying a valid courier cookie, the courier token as body `accessToken` and as `Authorization: Bearer`, and `x-gyema-surface: courier`. The admin mock holds a live session for that token. A `gcs_` token is 47 characters and passes the `accessToken` schema (`lib/schemas.ts:37`, `min(1).max(4096)`), so it reaches `resolveCaller` and GoTrue. Expected: 401 `unauthorized`, `courier_session_resolve` never called, no table write or RPC. The proof is the absence of any courier lookup or write, not the status code alone.
  - **Each courier route** gets a valid Pioneer token in the body and in `Authorization`, with no cookie. Expected: 401, and `getUser` never called. A valid cookie with surface `pioneer` also gets 401, with no RPC.
  - **Static checks:** no Pioneer route imports `lib/courier-auth` or reads `cookies(` or `request.cookies`, and no courier route imports `resolveCaller` or calls `auth.getUser`.
- `tests/courier-host.test.ts` keeps its 404s both ways.
- `tests/courier-auth.test.ts`: format, revoked, expired, idle, shredded, wrong surface, a 503 on a database error, and the cookie flags.
- A parity test reads the code alphabet and normalisation out of the SQL file and the TS module and requires them to agree.

**Proposed invariant 1 wording** (CLAUDE.md, the founder applies it, on top of the section 5 item 3 wording):

> 1. **Identity for sensitive operations is derived server-side, never taken from a request.** A Pioneer is resolved by `resolveCaller` from `admin.auth.getUser`, reading `app_metadata.pi_uid` and `pi_username`. A legacy courier is resolved by `resolveCourier` from the host-only session cookie on the courier host, looked up by hash. Neither resolver accepts the other's credential, and no Pioneer route imports `resolveCourier`. No route, RPC, or client function takes a role, party, or side argument, and no route or client function takes a courier id from the request: a service_role-only RPC that needs one receives it from the route that derived it from the session. Re-introducing either is the F17 defect.

The wording fits applied code: `courier_apply_kyc_status` already takes `p_external_user_id`, from the re-fetched session, and `courier_bind_piverify_session` takes `p_courier_id` from `resolveCourier`. The stricter alternative, bind taking `p_token_hash` and deriving the courier inside the function as redeem does, is not recommended: it ties a KYC function to the session table for no gain while the route is the only caller.

### 5.4 PiVerify session creation, binding, 402, polling

**`POST /api/courier/kyc/start`**, decided from the registry row the session resolved to:

| Row | Answer |
| --- | --- |
| `kyc_approved_at` set (full) | 409 `already_verified`, no PiVerify call (founder decision, item 3) |
| `paused_reason = 'operator'` | 403 `paused`, no call (decision 11) |
| bound session `created`, `started` or `pending_review`, or `rejected` with an `allowed_action` | Re-fetch the bound session and return its `hosted_flow_url`. No new session: a reopened rejection continues on the same session. |
| no session, or `rejected` with no action, or `failed` | Create, then bind |

- **Create:** `createPiVerifySession({ external_user_id: courier_id, idempotency_key })`. The bind's conflict check catches two attempts racing past each other. A request that loses the bind with `conflict` returns the hosted URL of the session that won, never its own.
- **Idempotency key (founder decision, 8 Oct 2026):** `gyema_` + the first 32 hex characters of `sha256(courier_id + ":" + (bound session id or "none") + ":" + floor(unix seconds / 600))`, 38 characters. It replaces the first approved key, `gyema:<courier_id>:<bound session id or none>`, because of the 502 rule below.
  - A double tap inside the same 10 minutes gets the same session back.
  - A retry after a `502` in a later 10-minute window gets a new key, as PiVerify requires. A retry inside the same window answers the courier with the existing "try again in a few minutes" copy.
  - A duplicate across a window boundary is harmless: it costs nothing until `pending_review`, and the bind binds only one.
  - 38 characters is close to the length of the documentation's own example key, so the unstated length limit is very unlikely to bite.

**What PiVerify's documentation says**, paraphrased from the founder's private copy, read 8 Oct 2026. The private documentation stays out of the repo, quoted or not.

- **Idempotency key: supported, and a required parameter.** A reused key returns the original session rather than creating a new one, and a replay answers 201 like a creation (PiVerify docs, Integration, Create a session; Sessions API, POST kyc_sessions).
- **Window: 24 hours** (same sections).
- **Length: not stated.** The documentation gives no maximum and no character set. Its only example key is 15 characters.
- **Status on creation: `created`.** It is shown only in the example response, not stated as a rule (PiVerify docs, Quickstart, Create a session). The session object lists six statuses, from `created` to `failed`, and the webhook events begin at `started`: there is no event for `created` (PiVerify docs, Session object; Webhooks, Supported events). Bind accepts `created` only, as drafted. Anything else at creation is refused with `bad_status` and logged, so a change on PiVerify's side shows up rather than being absorbed.
- **402: confirmed.** It means the balance does not cover the base credit plus any per-verification add-ons, and it can occur even when the account holds some credit (PiVerify docs, Sessions API, POST kyc_sessions; Errors, `payment_required`). Handled as drafted below.
- **Billing happens at review, not at creation.** Credits are deducted when a session reaches `pending_review` (PiVerify docs, Session object, `charged_add_ons`). A created session the courier never submits costs nothing, and a duplicate from a race is an unbound session whose events read `stale_session`, not a paid loss.
- **502 needs a new key.** A provider outage answers 502, and the documentation says to retry with a different idempotency key (PiVerify docs, Sessions API, POST kyc_sessions; Errors, `provider_error`). 429 `rate_limit_exceeded` also exists; the advice is to wait and retry (Errors).
- **Also confirmed:**
  - Session ids carry the prefix `ks_`. The example id is 19 characters, inside the 64 cap.
  - `updated_at` is the time of the last status change, which is what the poll id needs (Session object).
  - Webhook event types are `kyc.session.*`, so a poll's `event_type` of `poll` cannot collide (Webhooks).
  - A session serves one verification attempt (Integration, Create a session).
- **Bind:** `courier_bind_piverify_session(p_courier_id, p_expected_session_id, p_new_session_id, p_status)`. It is service_role only and marked `ATTESTATION WRITE: founder review required`, since it moves the ladder. Under the row lock:
  - **Refuses:**
    - `shredded`
    - `already_full` (`kyc_approved_at` set)
    - `conflict` (the bound session is no longer the one expected)
    - `session_live` (the bound session is still live, including a reopened rejection)
    - `session_taken` (the new session id is already bound elsewhere; the unique index)
    - `bad_status` (the new session is not `created`)
  - **On success it sets:**
    - `piverify_session_id` to the new session
    - `piverify_status` to `created`, and `piverify_allowed_action` to null, which the check on `rejected` requires
    - `piverify_status_at = now()`
    - **`buffer_since = null`**. `courier_apply_kyc_status` writes `coalesce(buffer_since, now())`, so without the reset a new session's 30-day clock would start from the old one.
    - `status = 'registered'` and `paused_reason = null`, unless `paused_reason = 'operator'`, which stands as everywhere else
    - `updated_at = now()`
  - A webhook for the new session that lands before the bind reads `session_not_bound`, gets a 503 and is retried (item 3, as built).
- **Session id shape**, checked before bind and before every poll: `^[A-Za-z0-9_-]{1,64}$`. No `:`, so a poll id cannot be ambiguous. 64 leaves room for the rest of the poll id: `poll:` (5) plus three separators, a status of up to 14, an action of up to 8 and a timestamp of about 27 come to about 57, so a 64-character id builds about 121. The 128 refusal stays as the check that decides if `updated_at` ever arrives longer.
- **`hosted_flow_url`** must be `https`. The client navigates top-level; CSP does not restrict navigation.

**402.** `upstreamError` in `lib/piverify.ts` folds the status into a string. It becomes a typed `PiVerifyHttpError { op, status }`, still with no upstream body. On 402 from create:

- logs `[gyema] piverify createSession 402: PiVerify account needs credit`
- answers the courier 503 `verification_unavailable`
- writes nothing and binds nothing

Copy: "We could not start verification just now. Try again in a few minutes." (COPY DRAFT, design notes `:327`). A 402 on a poll is skipped like any other upstream failure.

**Polling fallback**, `POST /api/courier/kyc/refresh`. There is no scheduler in Phase 1 (decision 10), so it is courier-triggered:

- **When it fires:**
  - on page load when the status is not settled
  - every 60 seconds while the "waiting for the result" screen is open
- **Skips:**
  - no bound session
  - `kyc_approved_at` set
  - `rejected` with no action
  - `failed`
- **Otherwise:**
  - Re-fetch the bound session and require the same id. `asSession` gains a check that `updated_at` is a non-empty string; today it does not check it.
  - Build `poll:<session_id>:<status>:<allowed_action or ->:<updated_at>`, with `updated_at` exactly as PiVerify returned it.
  - **Refuse, never truncate,** over 128 characters (`piverify_events_lengths_check`): log it and write nothing.
  - Call `courier_apply_kyc_status` with `p_event_type = 'poll'`.

  Outcomes are as decided in item 3: the same observation reads `duplicate`, a new one applies once, and a state the webhook already applied reads `not_forward`.
- **Webhook hardening that goes with it:** the webhook refuses an event id starting `poll:` and an event type of `poll`, so the poll namespace is never occupied by a delivered event.
- **Stated plainly: a courier who never opens the page is not polled** and stays at their last applied status until they do. Proposed for item 6 or later: the dispatch reader lists couriers whose session is unsettled and whose `piverify_status_at` is over 24 hours old, read-only, so the founder can nudge them.

### 5.5 Migrations (files only; the founder applies)

**`db/migrations/2026-10-08_courier_signin.sql`.** Both tables have RLS on with no policy, service_role holds `SELECT` only and makes no direct writes, and public, anon, authenticated and gyema_reader hold nothing. **No IP, user agent, phone or name is stored.** Hashes, ids and times only, said in the header.

- **`courier_signin_codes`:**
  - columns `id`, `courier_id` (fk), `code_hash bytea` (32 bytes, unique), `issued_at`, `expires_at`, `consumed_at`, `revoked_at`
  - a check that a code is not both consumed and revoked
  - a partial unique index: one live code per courier
- **`courier_sessions`:**
  - columns `id`, `courier_id` (fk), `code_id` (fk, which code made it), `token_hash bytea` (32 bytes, unique), `created_at`, `expires_at`, `last_seen_at`, `revoked_at`, `revoked_reason` (`signout`, `replaced`, `operator`, `shredded`)
  - a check that `revoked_at` and `revoked_reason` are null together
- **Functions:**
  - `courier_register_legacy`, `courier_issue_signin_code`, `courier_revoke_sessions`: owner only (decision 3). EXECUTE revoked from public, anon, authenticated and service_role, granted to no role. The verification cell has one row per function: "service_role cannot execute", read from `has_function_privilege('service_role', <signature>, 'EXECUTE')` and from the ACL with `aclexplode`. Both must read false for the row to pass.
  - `courier_redeem_signin_code`, `courier_session_resolve`, `courier_end_session`: service_role only
  - Every one is revoked from public, anon and authenticated in this file, or catalog check 12 grows a row (P7 does not remove PUBLIC).
- **Last statement:** the verification cell, as items 2 and 3: every column, constraint, index, function signature, `prosecdef`, pinned `search_path` and ACL by name, with `all_present`.

**`db/migrations/2026-10-08_courier_piverify_bind.sql`:** `courier_bind_piverify_session`, its revokes and grant, and its verification cell. It is a separate file because binding is a KYC concern, not a sign-in one.

**`docs/catalog-checks.sql`:**

- check 9 rows for every new object
- check 7 ACLs: the three founder functions with no grantee but the owner, and the three app functions with service_role only
- check 9 rows `2026-10-08 courier signin: service_role cannot execute <function>`, one per founder function, true only when `has_function_privilege` says false
- check 12 still exactly one row
- a new check 15 for the two tables:
  - columns, constraints, indexes
  - count of codes unconsumed, unrevoked and inside `expires_at` (informational)
  - count of codes unconsumed, unrevoked and past `expires_at` (informational, not an error: the partial unique index cannot reference `now()`, so such a code stays in the index until the next issue for that courier revokes it, and redemption refuses it as `expired`)
  - count of couriers with more than one unrevoked session (expect 0)

**`docs/deploy-order.md`:**

- **P11 and P12:** both before the item 5 code deploys. Until they exist, sign-in answers 500.
- **Then P10's courier host checks,** extended:
  1. Register a test legacy courier.
  2. Issue a code.
  3. Sign in.
  4. The page shows "Your courier reference:" with the first 8 characters of the registered id.
  5. Sign out.
  6. Check that the code is refused a second time.

**Tested as before:** static tests on the files, then a throwaway `postgres:17-alpine` in Docker with P2, P5, P7 and P9 first. Two runs each, then catalog checks before and after. Behaviour probes: expiry, single use, one live code, replaced sessions, idle and absolute expiry, shredded refusal, the bind rules including `buffer_since`, and privileges by role. No Gyema database touched.

### 5.6 Mirroring

None of the new files names a host or network, so they mirror as bytes. `docs/deploy-order.md` and these notes are hand-applied as before. The courier page strings are COPY DRAFT until item 8.

### 5.7 Founder decisions, 8 Oct 2026

1. **Session model:** an opaque session with a host-only cookie. No Supabase user for legacy couriers. `auth_user_id` stays nullable and unused, for item 6 to use or drop.
2. **Salt source:** core `gen_random_uuid`, two of them hashed to 32 bytes. No pgcrypto.
3. **Register, issue and revoke are owner-only.** EXECUTE is revoked from public, anon, authenticated and service_role. Catalog rows prove service_role cannot execute them (5.5).
4. **Codes:** 15 minutes, 10-character Crockford base32, shown as `XXXXX-XXXXX`.
5. **One live session per courier.** A new sign-in revokes the old device.
6. **Lifetime:** 90 days absolute, 30 days idle.
7. **The global sign-in bucket stays,** 300 an hour, fail closed, with its DoS trade-off accepted.
8. **No Turnstile in Phase 1.**
9. **Changed from the recommendation:** `GET /api/courier/me` returns the courier reference (first 8 characters of the courier id), and the page shows "Your courier reference: XXXXXXXX" (COPY DRAFT). After sign-in, the courier reads it back to the founder on WhatsApp before taking a job (onboarding steps in 5.1). No name, phone or label column.
10. **The Pioneer-courier branch of `resolveCourier` is item 6.**
11. **As recommended:** sign-in allowed for every pause. KYC start refused only for an operator pause. A rejected-final or failed courier may start a new session, which returns them to `registered`.
12. **As recommended:** KYC start from a `pending_timeout` pause stays the founder's hand decision under decision 7.
13. **As recommended:** whether Supabase keeps SQL editor result grids is unconfirmed. The query text holds no secret.

**Open after approval: none.** The idempotency key change raised by PiVerify's documentation is closed: decided 8 Oct 2026 as recommended (5.4).

### Part (c) founder decisions, 9 Oct 2026

Part (c) approved (`3fb9861`), with these choices, which 5.4 did not settle, accepted. Decision 1 is changed (`71d9654`).

1. **Changed: `courier_kyc_start` is 10 per day, not 3,** still spent on every call past `resolveCourier`, refusals included, and failing closed. Continue verification re-fetches cost nothing, creates are bounded by the bound-session rule, the idempotency key and the bind, and couriers on unreliable mobile data must not be locked out mid-flow. `courier_kyc_refresh` is unchanged and is spent the same way.
2. The webhook answers 400 `bad_payload` to a signed event whose id starts `poll:` or whose type is `poll`, before any read, fetch or write. PiVerify retries five times, then stops.
3. `kyc/start` refuses a created session whose `external_user_id` is not the courier id, before the bind. It also refuses one with a malformed id or a non-https `hosted_flow_url`.
4. The https check on `hosted_flow_url` is in the two courier routes, not in `asSession`, so the webhook path is unchanged.
5. Bind outcomes: `bound` returns the new URL; `conflict` and `session_live` return the URL of the session that won; `already_full` is 409 `already_verified`; `shredded` is 403 `unavailable`; `bad_status`, `session_taken` and no row are 503 `verification_unavailable`; a function error is 500.
6. `kyc/refresh` answers 200 with outcome `ignored`, writing nothing, when PiVerify returns another session, the poll id would be over 128 characters, or the stored session id has the wrong shape. This mirrors the webhook's "re-fetch disagrees" line.
7. `GET /api/courier/me` answers 503 `unavailable` when the registry row cannot be read and 500 when there is none. Every call now costs one extra SELECT.
8. During `pending_review`, `/me` reports `canStartKyc: true` (the table says continue), while the panel shows the waiting state and hides the button. This is the one place the API and the page differ, on purpose.
9. The panel strings are COPY DRAFT until item 8: the button labels "Start verification", "Continue verification" and "Opening..."; the waiting sentence "Your verification has been submitted. We are waiting for the result. This page checks again every minute."; and the errors "Verification is paused for this account. Contact Gyema.", "This courier account cannot start verification.", "Too many attempts today. Try again tomorrow." (a rolling 24 hours, not a calendar day) and the 5.4 retry line. They have not yet passed the gyema-accuracy checklist.

## Item 6 (approved 9 Oct 2026)

Design approved by the founder, 9 Oct 2026, with the decisions in 6.10, which win over anything earlier in this section. Part (a), the migration files, built 10 Oct 2026 (6.11); part (b) built 10 Oct 2026 (6.12); part (c) built 11 Oct 2026 (6.13); part (d) built 11 Oct 2026 (6.14). Designed 9 Oct 2026, at `0fa2db1`. No code, no SQL file, nothing applied. Read from: `lib/courier-auth.ts`, `lib/courier-kyc.ts`, `lib/route-auth.ts`, `lib/courier-host.ts`, `app/api/guest/{accept,mine,open,track,confirm-delivery,confirm-pickup}/route.ts`, `db/migrations/2026-08-13_delivery_code.sql`, `2026-09-07_last4_attempt_ceiling.sql`, `2026-08-18_dispatch_reader_role.sql`, `2026-09-15_dispatch_view_remit_cedis.sql`, `2026-10-08_courier_registry.sql`, `2026-10-08_courier_signin.sql`, `tests/routes/identity-separation.test.ts`, `components/delivery-tracker.tsx` and `scripts/dispatch-reader.mjs`.

**One change from decision 2, approved 9 Oct 2026 (6.2, 6.10 decision 1).** Decision 2 and the item 5 notes plan a hybrid `guest/accept` and `guest/mine` that serve both kinds of courier. This design splits them instead: legacy couriers get their own routes under `/api/courier/jobs/`, and the guest routes stay Pioneer only.

### 6.1 `guest_jobs.assigned_courier_id`

**The column:** `assigned_courier_id uuid null`, a foreign key to `courier_registry(id)` (option i). No cascade: the registry has no delete path, and shredding is an update, so the link survives a shred and points at a row that can no longer be tied to anyone. Plus a partial index where it is not null, for the legacy `mine` query.

**What writes it.** Only the two accept routes, in the same guarded UPDATE that claims the job:

| Claim by | `assigned_courier` | `assigned_courier_id` |
| --- | --- | --- |
| Legacy courier (`/api/courier/jobs/accept`) | null | the courier id from `resolveCourier` |
| Pioneer courier (`/api/guest/accept`) | `pi_username` from `resolveCaller`, as today | the registry id from the Pioneer lookup (6.2) |

No prefixed strings in `assigned_courier` (decision 2). Rows claimed before item 6 keep a null `assigned_courier_id`. No backfill is proposed. `mine` and confirm-delivery for Pioneers keep matching on `assigned_courier`, so old rows need none. A later item can link old Pioneer rows by joining on `lower(pi_username)` if anchoring needs it.

**Which SQL functions match on `assigned_courier` today: none.** `guest_stamp_delivery` and `guest_bump_delivery_code_attempts` (2026-08-13) and `guest_bump_last4_attempts` (2026-09-07) match on `tracking_id` and `phone_verified` only. The courier check in delivery confirmation is TypeScript (`app/api/guest/confirm-delivery/route.ts:131`). No applied function needs to change.

**Where the column does matter, and what changes:**

- **"Unassigned" now means both columns null.** A legacy claim leaves `assigned_courier` null. So:
  - the read and the UPDATE guards in accept (`route.ts:95` and `:117`) add `.is("assigned_courier_id", null)`
  - the board in `/api/guest/open` (`route.ts:36`) adds the same filter

  The `status = 'posted'` guard already stops a double claim; these keep the existing belt-and-braces guard true for both kinds of claim.
- **`/api/guest/mine`** stays on `.eq("assigned_courier", pi_username)`. The legacy `mine` matches `.eq("assigned_courier_id", courier_id)`.
- **The Pioneer courier check in `/api/guest/confirm-delivery`** stays on `assigned_courier`. The legacy route checks `assigned_courier_id` (6.3).
- **`/api/guest/track`** returns `assignedCourier` publicly. For a legacy job it is null. See the copy flag in 6.8.
- **`guest_jobs_dispatch`** (2026-09-15) carries `assigned_courier` and not the new column. **This is remit tracking, not just display.** The reader's sections keyed on `assigned_courier is not null` (for example the "assigned, remit_cedis null" check at `scripts/dispatch-reader.mjs:1046`) would be blind to every legacy job. The view gets `assigned_courier_id` appended (P14, 6.6). Each such predicate becomes `(assigned_courier is not null or assigned_courier_id is not null)`, and the reader shows a legacy courier as the courier reference (the first 8 characters).
- **Item 9 (`courier_shred`)** was scoped to replace `assigned_courier` with a marker. For a legacy courier there is nothing in `assigned_courier`. `assigned_courier_id` stays, pointing at the shredded row. Its "refuse if any job is open or has remit outstanding" test must look at both columns.

### 6.2 Resolving a courier on each host

**Proposed: split routes, not hybrid ones.**

| Host | Who | Routes | Credential | Resolver |
| --- | --- | --- | --- | --- |
| Courier host | Legacy courier | `POST /api/courier/jobs/accept`, `POST /api/courier/jobs/mine`, `POST /api/courier/jobs/confirm-delivery` | the `__Host-` cookie only | `resolveCourier` |
| Pinet host | Pioneer courier | `/api/guest/accept`, `/api/guest/mine`, `/api/guest/confirm-delivery` (courier_code branch) | body `accessToken` only | `resolveCaller`, then the registry lookup |

**Why split.** `tests/routes/identity-separation.test.ts` forbids a `pioneer` route importing `lib/courier-auth`, and a `courier` route importing `resolveCaller` or calling `auth.getUser`. A hybrid route breaks both rules and would need a third class with its own rules. Under the split:

- `COURIER_GUEST_APIS` shrinks to `/api/guest/open` alone.
- A Pi token sent to accept on the courier host meets the middleware 404, and so does a courier cookie sent to `/api/courier/*` on the pinet host. "Neither credential crosses" is enforced by middleware and by the browser's host-only cookie, not by a branch inside a route.
- It matches the shape the founder already chose for confirm-delivery (item 4, decision 2).

**The hybrid alternative** would keep one URL and branch strictly on `x-gyema-surface`: on `courier`, `resolveCourier` and never the body; on `pioneer`, `resolveCaller` and never the cookie. It needs a new `hybrid` class, probes in both directions per surface, and static rules allowing exactly those two imports. It is workable, but every future edit to those routes has to keep two credential paths apart in one file.

**Shared logic, no resolver imports.** The job logic moves into modules that never import either resolver. They take an already resolved identity, so both route families call them:

- **`lib/courier-ladder.ts`**, pure:
  - `effectiveTier(row, nowMs)`, which applies the 6.4 rules
  - `bufferJobGuards()`, which gives the guards a buffer claim adds
- **`lib/guest-claim.ts`**:
  - the claim UPDATE, taking the assignment columns to write and the tier guards
  - the `mine` read, taking the match column and value
  - the courier code confirmation, taking the job's expected assignment

  Both `/api/guest/accept` and `/api/guest/mine` are refactored onto these.

  - `/api/guest/mine` is unchanged in behaviour, and its existing tests pin that.
  - `/api/guest/accept` is not unchanged: it gains the registry lookup, the ladder, the both-null guard and new 403s, so `tests/routes/guest.test.ts` changes with it.

**The Pioneer lookup (decision 10).** After `resolveCaller`, `/api/guest/accept` calls a new service_role function, `courier_find_pioneer(p_pi_username)`. It returns the registry row matched on `lower(pi_username) = lower(p_pi_username)`, and no row for a shredded row.

- **Why a function and not a PostgREST filter.** PostgREST cannot filter on the `lower()` expression the unique index is built on. `ilike` treats `_` as a wildcard, and Pi usernames contain underscores, so `a_b` would also match `axb`.
- **On a lookup error** the route answers 503 `auth_unavailable`. It never falls through to "no row".
- **No row** means refused (decision A, below), with reason `courier_not_registered`.
- `/api/guest/mine` and Pioneer delivery confirmation do **not** look up the registry. A Pioneer always sees and completes the jobs already assigned to them, whatever their tier.

**The legacy side** needs `buffer_since`, `paused_reason` and `shredded_at`. `courier_session_resolve` (P11) does not return them, so `/api/courier/jobs/accept` reads the registry row by id, the same way `readCourierKycRow` does. This is recommended over widening the P11 function.

**Updated classification** for `identity-separation.test.ts`:

| Route | Class |
| --- | --- |
| `app/api/courier/jobs/accept/route.ts` | courier (new) |
| `app/api/courier/jobs/mine/route.ts` | courier (new) |
| `app/api/courier/jobs/confirm-delivery/route.ts` | courier (new) |
| `app/api/guest/accept/route.ts` | pioneer (unchanged) |
| `app/api/guest/mine/route.ts` | pioneer (unchanged) |
| `app/api/guest/confirm-delivery/route.ts` | pioneer (unchanged; also carries the public sender branch, as today) |
| `app/api/guest/open/route.ts` | public (unchanged) |

The existing probes then cover the new routes as they are: a courier cookie, body token and Bearer against each Pioneer route, and a Pioneer token against each courier route. `tests/courier-host.test.ts` moves accept, mine and confirm-delivery from the served list to the refused list. The `tests/schemas.test.ts` route count goes from 25 to 28.

**Proposed invariant 1 wording, amended** (replaces the 5.3 proposal; the founder applies it):

> 1. **Identity for sensitive operations is derived server-side, never taken from a request.** A Pioneer is resolved by `resolveCaller` from `admin.auth.getUser`, reading `app_metadata.pi_uid` and `pi_username`, on the pinet host only. A legacy courier is resolved by `resolveCourier` from the host-only session cookie on the courier host only, looked up by hash. A Pioneer acting as a courier is a Pioneer first: `resolveCaller`, then the courier registry looked up on `lower(pi_username)`. Neither resolver accepts the other's credential, no route imports both, and no Pioneer route imports `resolveCourier`. No route, RPC, or client function takes a role, party, or side argument, and no route or client function takes a courier id from the request: a service_role-only RPC that needs one receives it from the route that derived it from the session. Re-introducing either is the F17 defect.

### 6.3 Legacy delivery confirmation under `/api/courier/`

`POST /api/courier/jobs/confirm-delivery`, courier host only. The body is `{ trackingId, code }`, with no `via`: this route is only ever the `courier_code` stamp.

1. `courierWriteRefusal` (JSON and Origin), then a rate limit, then `resolveCourier`.
2. Read the job as the current route does (`tracking_id`, `phone_verified`).
3. Refuse with 409 `no_code` if the job is uncoded. Refuse with 403 `not_assigned` unless `assigned_courier_id` equals the resolved courier id. That check comes before any attempt is counted, as now.
4. The same five-attempt ceiling, `guest_bump_delivery_code_attempts`, the same idempotency, and `guest_stamp_delivery(p_tracking_id, 'courier_code')`. These are applied functions, called unchanged.

**No ladder check here.** A paused courier can still finish a job they hold. Refusing would strand a parcel already in their hands.

**Rate limit:** a new `courier_confirm` bucket per courier id, 30 an hour, failing open. That matches `guest_last4`'s reasoning: the Postgres ceiling is the control, and a courier at a door must not be refused because a cache is down.

**`lib/courier-host.ts`:** `/api/guest/confirm-delivery` leaves `COURIER_GUEST_APIS` (founder decision, item 4), together with accept and mine, which leave under 6.2.

**Rejected:** having `guest_stamp_delivery` take `p_courier_id` and check the assignment inside the lock. It is stricter, but it changes a function applied on both networks (2026-08-13) and its Pioneer caller. The TypeScript check is the one the Pioneer branch already relies on.

### 6.4 The ladder, enforced in accept

`effectiveTier(row, now)` in `lib/courier-ladder.ts`, used by both accept routes:

| Registry row | Effective tier | Jobs |
| --- | --- | --- |
| none, or `shredded_at` set | none | 403 `courier_not_registered` / `unavailable` |
| `status = 'registered'` | none | 403 `courier_not_active` |
| `status = 'paused'` | none | 403 `courier_not_active` |
| `status = 'buffer'`, `buffer_since` null | none (fails closed; check 14 reports the row) | 403 `courier_not_active` |
| `status = 'buffer'`, `now - buffer_since >= 30 days` | none, computed on read (decision 7) | 403 `courier_not_active` |
| `status = 'buffer'`, inside 30 days | buffer | guest jobs passing the buffer guards only |
| `status = 'full'` | full | every guest job |
| any other value | none | 403 |

- **The clock** is the route's (`Date.now()`), against `buffer_since` from the database. A few seconds of skew is irrelevant to a 30-day window.
- **The stored status** is still changed by hand (decision 7). 6.6 adds the reader list of overdue buffer couriers.

**Buffer guards go into the claim UPDATE itself,** not into a pre-check, so a job cannot change between check and claim:

- `.in("pickup_area", GUEST_AREA_NAMES)` and `.in("dropoff_area", GUEST_AREA_NAMES)`. These test the row's areas, not its status: an off-list job priced by hand is `posted` with a quote and areas outside the list, and must be refused. Untrimmed off-list values (CLAUDE.md, `'Asylum down '`) fail the exact match, which is the safe direction.
- `.lte("declared_value_cedis", 200)`. A null value fails `<=`, so a job with no declared value counts as over the cap.

**Refusal for a buffer courier on an ineligible job:** one reason, `not_eligible`, whether the cause is the area or the value. Even so, it leaks one bit about the parcel value. A buffer courier who sees a listed-area job refused learns that its value is over GHS 200, or unset. Any eligibility feedback does this, including hiding the job. It is far less than showing the value (decision 6), but it is not nothing; see open question 4.

**Never returned to any courier:** `declared_value_cedis` is not added to any select list in accept, `mine` or open. A test pins all three column lists.

**Accept is a status write** (`posted` to `accepted`). Both accept routes carry `ATTESTATION WRITE: founder review required`.

**Rate limit for the legacy accept:** `courier_accept` per courier id, 30 per 10 minutes, failing closed. The Pioneer accept has no limiter today and gets none here.

### 6.5 Recipient details after cancellation

In both `mine` mappers, when `status` is `cancelled`, `recipientName` and `recipientPhone` are returned as null. The row is untouched. This is a response rule, so a job reopened by hand shows them again.

- A test pins it per status.
- `cancelled` has no application writer today (F14); the operator sets it by hand. So this takes effect on the next read after the hand update, with nothing to deploy alongside it.
- Not proposed without a decision (open question 5): applying the same rule to `expired` and to landmarks, and to `delivered` after a set number of days.

### 6.6 Migrations (plan only; the founder applies)

**P13, `db/migrations/2026-10-09_guest_jobs_courier_assignment.sql`.** Needs P2. Apply on a network before the item 6 code deploys there. Until it exists, every accept answers 500 on the missing column. So does `/api/guest/open`, which gains the same filter. That would take down the public job board on the pinet host for every Pioneer, not only accepts, which is why P13 must go first.

1. `alter table public.guest_jobs add column if not exists assigned_courier_id uuid null`, then a named FK `guest_jobs_assigned_courier_id_fkey` to `courier_registry(id)`, added only if absent. Postgres has no `add constraint if not exists`, so this is guarded on `pg_constraint` inside a `do` block.
2. `create index if not exists guest_jobs_assigned_courier_id_idx ... where assigned_courier_id is not null`.
3. **Only if decision A is taken:**
   - **`courier_registry.vouched_at timestamptz null`:** "the founder vouched for this courier without PiVerify". This is additive; the P2 file is not edited.
   - **`courier_register_pioneer(p_pi_username text)`,** owner only like `courier_register_legacy`: EXECUTE revoked from public, anon, authenticated and service_role. Marked `IDENTITY WRITE: founder review required`.
     - It inserts `class = 'pioneer'`, `status = 'full'`, `vouched_at = now()`, the trimmed username and a 32-byte salt from two `gen_random_uuid()`.
     - It refuses an empty or untrimmed username. The unique index refuses a case variant.
     - It returns `courier_id`.
4. **`courier_find_pioneer(p_pi_username text)`:** read only, security definer, `search_path = public, pg_temp`, service_role EXECUTE only. It returns `id, status, buffer_since, paused_reason, kyc_approved_at` for an unshredded Pioneer row on `lower(pi_username)`. It also returns `vouched_at`, but only if decision A is taken.
5. Revokes from public, anon and authenticated on every new function. Without them, catalog check 12 grows a row.
6. **Last statement, the verification cell** as in P2 and P11: column, FK, index, functions, `prosecdef`, pinned `search_path` and ACLs by name, with `all_present`.

**P14, `db/migrations/2026-10-09_dispatch_view_courier_id.sql`.** `create or replace view public.guest_jobs_dispatch` with the 2026-09-15 select list unchanged and two columns appended, in this order: `assigned_courier_id` (column 24), then `declared_value_cedis` (column 25). A replace may only append columns. **Amended 10 Oct 2026** (item 7, 7.7 decision 3): the second column is added here rather than in item 7, and the dispatch reader shows the declared value to the operator. It is the only place outside the send form and the create route that carries it, and `gyema_reader` is the operator's role, not a courier's.

- **Needs P12b** as well as P13: the view selects `declared_value_cedis`, which P12b adds.
- **Pre-flight, read only:** `pg_get_viewdef('public.guest_jobs_dispatch'::regclass, true)` must match the 2026-09-15 definition (23 columns, nothing after `remit_cedis`), or stop. This is the same caveat as that file.
- **The reader script** lists both new columns as required, so it refuses to run against a view without them.
- The replace keeps the ACL, so the 5a revokes and the `gyema_reader` grant stand.
- No base table grant is needed: 2026-09-07 took `gyema_reader` off `guest_jobs` itself.
- Apply it before the reader script that reads the column.

**P15 (recommended in item 6, since the 30-day rule ships here):** `courier_registry_dispatch`, a masked view for `gyema_reader`. It carries:

- the first 8 characters of the id
- `class`, `status`, `buffer_since`, `piverify_status`, `piverify_status_at`, `paused_reason`, `shredded_at`

No `pi_username`, no salt, no session id. The reader lists:

- buffer couriers at or past 30 days (decision 7)
- unsettled sessions whose `piverify_status_at` is over 24 hours old (the 5.4 proposal)

**Catalog checks (`docs/catalog-checks.sql`):**

- **Check 9:** rows for the column, FK, index, each function, `vouched_at`, the two appended view columns and P15's view.
- **Check 7:** `courier_register_pioneer` with no grantee but the owner, and a "service_role cannot execute" row as in 5.5. `courier_find_pioneer` with service_role only.
- **Check 12:** still exactly one row.
- **Column privileges:** `information_schema.column_privileges` for `guest_jobs.assigned_courier_id` shows no anon, authenticated or gyema_reader.
- **Check 14:** the timing rule "full has `kyc_approved_at`" becomes "full has `kyc_approved_at` or `vouched_at`".
- **New informational counts:**
  - jobs with both `assigned_courier` and `assigned_courier_id` null and status not `posted`, `pending_quote` or `expired`
  - jobs whose `assigned_courier_id` points at a `legacy` row while `assigned_courier` is set (expect 0)

**Read-only pre-flight for decision A, per network, before P13's code deploys:**

```
select '[' || assigned_courier || ']' as bracketed, length(assigned_courier),
       lower(assigned_courier), count(*), max(created_at)
  from public.guest_jobs where assigned_courier is not null
 group by assigned_courier order by max(created_at) desc;
```

Then one `courier_register_pioneer` call per username the founder chooses, each followed by a read-back through `courier_find_pioneer` (invariant 8).

**Tested as before:** static tests on the files, then a throwaway `postgres:17-alpine` with P2, P5, P9 and P11 first. Two runs, catalog checks before and after, and probes:

- FK refusal of an unknown id
- the index used by the lowered lookup, including an underscore username
- owner-only and service_role-only privileges
- refusal of an untrimmed or case-variant username
- the view replace with the ACL kept, `assigned_courier_id` at 24 and `declared_value_cedis` at 25

No Gyema database touched.

### 6.7 Answers

**A. Existing Pioneer couriers on Mainnet. Recommended: grandfather by explicit registration before deploy, never by absence or by a timer.**

- **Requiring PiVerify is not available.** Phase 1 has no Pioneer KYC path: `kyc/start` is courier host only, and `courier_session_resolve` refuses any non-legacy row. Requiring it would refuse every Pioneer courier with no way through.
- **No row counts as full** (grandfather by absence) is not recommended. The ladder would never apply to a Pioneer. "No row" would look the same as a registry bug, and a failed lookup that fell through would fail open.
- **A grace period** is not recommended. It is a date in code that turns live couriers off later, with no event at the moment it happens.
- **Recommended:**
  1. Before item 6 deploys on a network, the founder runs the 6.6 pre-flight and registers each existing Pioneer courier with `courier_register_pioneer`, giving `full` with `vouched_at`.
  2. After deploy, a Pioneer with no row is refused with 403 `courier_not_registered`, never silently. The Pioneer UI shows a "contact Gyema to register as a courier" line (COPY DRAFT, item 8).
  3. New Pioneer couriers are registered by hand after WhatsApp verification, the same onboarding as legacy couriers.
  4. A founder-set `paused` row stops a Pioneer from accepting, as it does a legacy courier.
- **Nothing live breaks** if the backfill comes first: every Pioneer who has ever accepted a guest job is `full`, and their `mine` and confirm-delivery paths never consult the registry.
- **What `full` means for a Pioneer row** (`vouched_at` versus `kyc_approved_at`) is recorded so that anchoring later never presents a vouched courier as KYC-verified.

**B. The GHS 200 cap and item 7. Recommended: item 7 before item 6.**

- **Item 7 is small and independent:** a column, the schema, the create form, and never returned to a courier. Item 6's buffer guard needs the column to exist; against a missing column the guarded UPDATE errors.
- **Either order breaks nothing at ship time.** No courier is `buffer` yet: legacy couriers reach buffer only at PiVerify `pending_review` after sign-in, which is not live on either network, and Pioneers are registered `full` under A.
- **If item 6 must go first,** the acceptable fallback is that buffer couriers are refused every job until item 7 lands. That is one constant in `lib/courier-ladder.ts`, removed by item 7. It is not a code path that queries a missing column.
- **Merging the two** is not recommended: it doubles the review surface of a status-writing route.
- **Jobs posted before item 7** have a null declared value and stay full-tier only, permanently. That is the safe direction.

**C. Applied migrations (P1 to P12) and Pioneer listings routes.**

- **No applied migration file is edited.**
  - P2's registry gains `vouched_at` only through the new P13, and only if A is taken.
  - P11's `courier_session_resolve` is not widened; accept reads the row instead.
  - P12 and the 2026-08-13 and 2026-09-07 functions are called unchanged.
- **The 2026-09-15 view is replaced** by a new file (P14), append only, with a pre-flight that stops on any drift. That is the one object an applied file created that item 6 redefines.
- **No listings route, no payments route and no `lib/route-auth.ts` change.** `resolveCaller` is reused as it is. The rails do not blend: the registry and the ladder touch guest jobs only (invariant 3).
- **Two applied pieces of code that touch Pioneers change:**
  - `/api/guest/accept`: the registry lookup, the ladder and the both-null guard
  - `/api/guest/open`: the both-null filter

  Both are guest rail routes. They are listed so the founder reviews them as changes to live Pioneer behaviour.

### 6.8 Flagged for item 8, not changed

- **`components/delivery-tracker.tsx:74-76`** prints "A Pi Pioneer is carrying it" whenever `assignedCourier` is null and the job is accepted. Every legacy job would show it, and it would be false. **This copy must change before a legacy courier takes a job on any network.** Proposed: `/api/guest/track` returns a neutral `courierAssigned: boolean` alongside, and the copy says only that a courier is carrying it.
- **`/api/guest/track` returns `assigned_courier`, a Pioneer's username, to anyone holding a tracking id.** That is pre-existing, and outside item 6's change.
- **The courier page** needs a job list, an accept action and a code entry for legacy couriers. Item 6 builds them, and every string is COPY DRAFT until item 8.

### 6.9 Mirroring

The new routes, `lib/courier-ladder.ts`, `lib/guest-claim.ts`, P13, P14 and P15 name no network or host, so they mirror as bytes. `docs/deploy-order.md` and these notes are hand-applied. Order per network:

1. Item 7's migration (P12b), and the item 7 code after it.
2. P13.
3. The decision A backfill.
4. The code deploy.
5. P14.
6. P15, then the reader script. (Amended 11 Oct 2026, 6.14: the part (d) reader requires P15 as well as P14.)

### Open questions for the founder

1. **Split or hybrid (6.2).** Split is recommended. It changes decision 2's "move `guest/accept` and `guest/mine` to `resolveCourier`" into new routes under `/api/courier/jobs/`.
2. **Decision A:**
   - backfill `full` with a new `vouched_at` column (recommended), or accept check 14 flagging `full` rows without `kyc_approved_at`
   - whether new Pioneer couriers are registered by hand (recommended) or some other way
3. **Decision B:** item 7 before item 6 (recommended), or item 6 first with buffer refusing all jobs.
4. **The one-bit value leak** in a buffer refusal (6.4): accept it with one generic `not_eligible` reason (recommended), or also filter a courier-host board by tier, which leaks the same bit by absence.
5. **Data minimisation (6.5):** `cancelled` only, or also `expired`, also landmarks, and also `delivered` after N days.
6. **P15 in item 6 or later.** Recommended in item 6, since the 30-day rule ships here.
7. **Rate limits:**
   - `courier_accept` 30 per 10 minutes, failing closed
   - `courier_confirm` 30 per hour, failing open
   - the legacy `mine` reusing `courier_me`'s 60 per 10 minutes, failing open
8. **The registry lookup for Pioneers on accept only (6.2).** Pioneer `mine` and Pioneer delivery confirmation skip the lookup, so a paused Pioneer can still see and finish jobs they already hold. The alternative is to look up the registry on all three routes.
9. **The legacy accept body.** Today `/api/guest/accept` takes `accepterWhatsapp` and writes `assigned_courier_whatsapp`. Nothing in this repository reads that column back: not `mine`, not `track`, and not the reader (2026-08-18: "the report contacts nobody"). For a legacy courier, is the WhatsApp number collected at all, and if so, who reads it? Data minimisation says not to collect it until something reads it.

All nine are answered in 6.10.

### 6.10 Founder decisions, 9 Oct 2026

Approved as designed, with these answers to the open questions:

1. **Split routes, as proposed.** Legacy couriers use `/api/courier/jobs/accept`, `/mine` and `/confirm-delivery` on the courier host. `guest/accept`, `guest/mine` and `guest/confirm-delivery` stay Pioneer only. `COURIER_GUEST_APIS` becomes `/api/guest/open` alone.
2. **Decision A, as recommended, with `vouched_at`.**
   - Before item 6 deploys on a network, existing Pioneer couriers are registered by hand with `courier_register_pioneer`, as `full` with `vouched_at`.
   - **A vouched courier is `full` for dispatch only. It is never presented as KYC-verified.** Anchoring and the trust bureau use `kyc_approved_at` only, never `vouched_at` and never `status = 'full'` alone.
   - New Pioneer couriers are registered by hand after WhatsApp verification.
   - A Pioneer PiVerify path replaces vouching later. Until then, `vouched_at` is the only route to `full` for a Pioneer.
3. **Item 7 before item 6.** `declared_value_cedis` exists before the buffer guard that reads it. No fallback constant is needed.
4. **One generic `not_eligible` reason** for a buffer courier refused on area or value. The one-bit leak (6.4) is accepted.
5. **Cancelled jobs only, now.** Recipient name and phone are nulled in both `mine` responses when `status` is `cancelled`. Hiding them on delivered jobs after N days, and hiding landmarks, are deferred to a later privacy pass. `expired` is not included now.
6. **P15 ships in item 6.** `courier_registry_dispatch` and the reader's overdue-buffer and stale-session lists.
7. **Rate limits as proposed:**
   - `courier_accept`: 30 per 10 minutes, failing closed
   - `courier_confirm`: 30 per hour, failing open
   - legacy `mine`: `courier_me`'s 60 per 10 minutes, failing open
8. **The registry check for Pioneers is on accept only.** Pioneer `mine` and Pioneer delivery confirmation do not consult the registry, so a paused Pioneer can still see and finish jobs they hold.
9. **No courier WhatsApp number is collected for legacy couriers.** The legacy accept body is `{ trackingId }` only, and a legacy claim writes `assigned_courier_whatsapp` as null. The Pioneer accept is unchanged.

**Go-live gate (founder decision, 9 Oct 2026).** No legacy courier takes a real job on any network until both of these have landed:

- **The tracker copy fix:** `components/delivery-tracker.tsx:74-76` no longer says a Pi Pioneer is carrying a job, or names any courier.
- **`/api/guest/track` returns only `courierAssigned: boolean`.** No Pioneer username, for any job, legacy or Pioneer. This removes the pre-existing public exposure of `assigned_courier` noted in 6.8. It changes the Pioneer tracker too, so `lib/guest-jobs.ts` (`assignedCourier`) and the tracker change with it.

The copy itself is drafted in item 8, marked for review, and must pass the gyema-accuracy checklist before it ships.

### 6.11 Part (a) built, 10 Oct 2026: P13, P14, P15

Built on `feat/anchoring-phase1` at `8af0f02`, with P11, P12 and P12b applied on Testnet (founder, 10 Oct 2026). Nothing applied on either network by this work.

**The split, proposed for review.** One part at a time, stopping after each:

- **(a)** P13, P14 and P15, the catalog checks and the static tests. This part.
- **(b)** `lib/courier-ladder.ts` (with the GHS 200 buffer cap beside the 500 in `lib/declared-value.ts`), `lib/guest-claim.ts`, and the Pioneer routes refactored onto them: `/api/guest/accept` (registry lookup, ladder, both-null guard, new 403s), `/api/guest/mine` (cancelled rule, unchanged otherwise) and `/api/guest/open` (both-null filter). The buffer guard uses the literal `.lte("declared_value_cedis", ...)` form the exposure test allows (7.8).
- **(c)** `/api/courier/jobs/accept`, `/mine` and `/confirm-delivery`, the courier page job list, `lib/courier-host.ts` (`COURIER_GUEST_APIS` down to `/api/guest/open`), and the identity-separation, courier-host and schemas test updates (route count 25 to 28).
- **(d)** `scripts/dispatch-reader.mjs`: both new view columns in `REQUIRED_COLUMNS`, assigned meaning either column, a legacy courier shown by reference, the declared value shown, and the overdue-buffer and stale-session lists from P15. It touches no route and no resolver, so it is kept out of (b) and (c). Until it lands the reader ignores the new columns and still runs.

**Files:**

- `db/migrations/2026-10-09_guest_jobs_courier_assignment.sql` (P13): the column, the guarded FK, the partial index, `vouched_at`, `courier_register_pioneer` (owner only, `IDENTITY WRITE: founder review required`) and `courier_find_pioneer` (service_role only, `stable`). Verification cell, 25 rows after the change below (24 at `fc9e71f`).
- `db/migrations/2026-10-09_dispatch_view_courier_id.sql` (P14): a guard, then the replace. The guard stops the file before the replace unless the server is 15 or later, both columns exist, and the live column list is exactly the 2026-09-15 one (or this file's 25, for a re-run). The section 0 pre-flight is kept for the full definition. Verification cell, 9 rows, with the grants listed.
- `db/migrations/2026-10-10_courier_registry_dispatch_view.sql` (P15): a guard (server 15 or later, `gyema_reader` exists), the view, the revokes and the grant. Verification cell, 8 rows.
- `docs/catalog-checks.sql`: 15 check 9 rows (10, 2 and 3; 14 at `fc9e71f`), both functions in check 7, the view in check 11, check 14's full rule amended, a new check 17, and the expectations.
- `tests/courier-assignment-migration.test.ts`: 26 static tests.
- `docs/deploy-order.md`: rows P13, P14 and P15, the decision A pre-flight and register calls in the P13 row, and the 6.9 order.

**Choices made in the files, for review:**

1. **P15 is revoked from service_role too,** which 6.6 did not say. The other two dispatch views leave service_role Supabase's default full set, and that is safe there because their `LIMIT` makes them not updatable. P15 is a plain projection of one table, so Postgres makes it automatically updatable, and with `security_invoker` off a DELETE through it runs with the owner's rights. A control probe, rolled back, showed service_role with a DELETE grant on the view deleting a registry row it cannot delete directly, against P2's "no DELETE path". So only `gyema_reader` holds anything on it.
2. **Changed by the founder, 10 Oct 2026:** `courier_registry_vouched_pioneer_only_check` holds `vouched_at` to Pioneer rows. See "Change after review" below.
3. **`courier_find_pioneer` returns a column named `id`,** as 6.6 lists it, not `courier_id`. It is `stable`, does not trim its input, and states `pi_username is not null` so the partial unique index applies (see the plan below).
4. **`courier_register_pioneer` refuses** a null, empty or untrimmed username with 22023 before the insert, and leaves a case variant to the unique index (23505). It stores the username exactly as given; it does not trim.
5. **Check 14's key is renamed** to `full_without_kyc_approved_at_or_vouched_at`, with `vouched_at_column_exists` beside it. Before P13 the count reads `kyc_approved_at` alone.
6. **The file names** are the approved `2026-10-09` ones for P13 and P14, so they sort before P12b's `2026-10-10`. The deploy order says the list, not the names, decides.
7. **P13's FK has no ON DELETE action** (NO ACTION). A probe showed the owner's delete of a referenced registry row refused, and the job still linked.

**Tested.** Static: 26 tests in `tests/courier-assignment-migration.test.ts`. Database: run on 10 Oct 2026 against a throwaway `postgres:17-alpine` (17.11) in Docker. No Gyema database was touched. The setup had the four Supabase roles, Supabase-shaped default privileges (all three API roles on tables and functions) then grant baseline section 1a, `auth.users` reduced to its key, `listing_counterpart_contact` as check 12's by-design row, and fake `guest_jobs` and `listings` carrying every column the dispatch views select, with four old rows. Then the real files in order: 2026-09-07 masked views, 2026-09-15, P2, P5, P7, P9, P11, P12, P12b.

- **Catalog checks before P13,** at that point: the file parsed and ran. The 14 new check 9 rows read false, check 14 counted on `kyc_approved_at` alone (`vouched_at_column_exists: false`), check 17 read `exists: false`, check 12 had its one row.
- **Each file ran twice,** all exiting 0, and every verification cell read `all_present: true` both times.
- **Catalog checks after:** the 14 rows true; check 7 `courier_register_pioneer {postgres=X/postgres}`, `courier_find_pioneer {postgres=X/postgres,service_role=X/postgres}`; check 12 still exactly one row; check 14 at 17 columns, 12 constraints, 4 indexes, all timing counts 0; check 17 `exists: true`; check 3 showing the new view for gyema_reader SELECT alone; check 11 listing it as referenced. The check 9 rows still false belong to files the fixture does not apply (2026-08-13, 2026-08-14, 2026-08-18, 2026-09-07 identity and last4).
- **The dispatch view's grants and options** were identical before and after P14: gyema_reader SELECT, postgres and service_role the full owner set, `{security_invoker=false}`.
- **P2's own cell re-run after P13** read false only on "no columns beyond the expected fifteen", as recorded.
- **62 behaviour probes passed in one run, 0 failed:**
  - `courier_register_pioneer`: pioneer, full, `vouched_at` set, `kyc_approved_at` null, 32-byte salt, username as given; refused a case variant and an exact duplicate (23505), a leading or trailing space, empty and null (22023), with nothing inserted; a shredded username registered again
  - `courier_find_pioneer`: matches in any case; `amaxb` and `ama%` find nothing for `ama_b` (no wildcard); no trimming of the input; null and empty find nothing; a shredded row is not found, even one still holding a username; a legacy row is never found
  - **The plan:** with 3,000 Pioneer rows and no planner override, the lookup's generic plan is `Index Scan using courier_registry_pi_username_lower_key`, `Index Cond: (lower(pi_username) = lower($1))`
  - privileges: service_role executes `courier_find_pioneer` and writes `assigned_courier_id`, and cannot execute `courier_register_pioneer` or `courier_register_legacy`; anon and authenticated execute neither and cannot read the column; gyema_reader executes neither and cannot read `guest_jobs`
  - the FK: refuses an unknown id (23503); accepts a legacy id, a Pioneer id beside `assigned_courier`, and a shredded courier's id; refuses the owner's delete of a referenced registry row; an F14 hand status write on a linked row still works
  - P14: gyema_reader reads `assigned_courier_id` (a legacy claim) and `declared_value_cedis` through the view, phones still masked; the view refuses writes outright (55000, not updatable); anon and authenticated refused; columns 23 to 25 are `remit_cedis` numeric, `assigned_courier_id` uuid, `declared_value_cedis` integer
  - P15: gyema_reader reads it, every reference 8 characters, a shredded row shown by reference only; gyema_reader still cannot read `courier_registry`, and cannot update or delete through the view; service_role holds nothing on it and still cannot delete from the registry; anon and authenticated refused; the rolled-back control in choice 1
- **Negative runs:**
  - P14 before P13: the guard stopped the file ("Apply P13 first"), and the view stayed at 23 columns.
  - P14 against a drifted view (an extra column on the end): the guard stopped the file and printed the live list.
  - A column `SELECT` on `assigned_courier_id` granted to anon turned P13's cell false on that row; revoking it turned it true.
  - EXECUTE on `courier_register_pioneer` granted to service_role and on `courier_find_pioneer` to anon turned three rows of P13's verification false; re-running P13 revoked both and read true.
  - DELETE on P15's view granted to service_role turned P15's verification false, naming `service_role:DELETE`; re-running P15 revoked it and read true.

**Founder decisions, 10 Oct 2026.** Part (a) approved at `fc9e71f`. Choices 1 and 3 to 7 accepted. Choice 2 changed, below.

**Change after review: only a Pioneer can be vouched.** A legacy courier reaches full only through PiVerify, so a hand UPDATE must not be able to vouch one. P13 now adds `courier_registry_vouched_pioneer_only_check`, `vouched_at is null or class = 'pioneer'`, guarded on `pg_constraint` by name like the foreign key, with a verification row (25 rows in all) and a check 9 row (ten `2026-10-09 courier assignment` rows). Check 14 after P13 reads thirteen constraints. The P13 pre-flight in `docs/deploy-order.md` now builds the bracket with `concat(...)`, so it pastes from the raw file.

Re-run in full on 10 Oct 2026, same fixture, no Gyema database touched:

- P13 ran twice, both exiting 0 with `all_present: true` over 25 rows; the check's row reads its definition. P14 (9 rows) and P15 (8 rows) unchanged and true.
- Catalog checks before P13: the 15 new check 9 rows false, check 14 at 16 columns and 12 constraints. After: all 15 true, check 14 at 17 columns, 13 constraints, 4 indexes, timing counts 0; check 12 still one row.
- 68 probes passed, 0 failed: the 62 before plus six new. Vouching a legacy row by hand UPDATE is refused (23514), inserting a vouched legacy row is refused (23514), and the legacy row stays unvouched. Unvouching and re-vouching a Pioneer row by hand UPDATE works.
- The five negative runs read as before: both P14 guards stopped the file, and the bad-grant runs turned P13's and P15's cells false and the re-runs true.

**Mirroring:** the three migrations and the test file name no network: bytes. `docs/catalog-checks.sql`, `docs/deploy-order.md` and these notes are scanned at mirror time as usual.

**Founder steps, per network,** in the 6.9 order: P13 and its cell, the catalog check, the decision A pre-flight and registrations with read-backs, and only then the item 6 code (part (b) onward, not yet built). P14 and P15 after the deploy. Mainnet on a go-ahead.

### 6.12 Item 6 part (b) built, 10 Oct 2026

Built on `feat/anchoring-phase1` at `2de140e`, on top of `f2a21ef`, with P13 applied on Testnet and one Pioneer courier registered there as vouched full (founder, 10 Oct 2026). Not pushed. No SQL run, nothing applied on either network by this work.

**Files:**

- `lib/courier-ladder.ts`: `effectiveTier(row, nowMs)`, the 6.4 table row for row, and `bufferJobGuards(query)`, which applies the two bounded area filters and the literal `.lte("declared_value_cedis", BUFFER_VALUE_CAP_CEDIS)` to the claim's query builder.
- `lib/declared-value.ts`: `BUFFER_VALUE_CAP_CEDIS = 200`, beside the 500. The name carries no "declared", so importing it does not trip the exposure scan.
- `lib/guest-claim.ts`: the claimable read, the claim UPDATE (marked `ATTESTATION WRITE: founder review required`), the courier job list read, `recipientWithheld`, and `confirmCourierCode`. It imports neither identity resolver and not `lib/guest-commission.ts`; a test pins the first.
- `/api/guest/accept`: `courier_find_pioneer` after `resolveCaller`, the ladder, the both-null guard, the registry id written to `assigned_courier_id` beside the username, and the 403 reasons.
- `/api/guest/mine`: recipient name and phone null when `status` is `cancelled`; otherwise unchanged, and no registry lookup.
- `/api/guest/open`: `.is("assigned_courier_id", null)` beside the existing filter.
- `/api/guest/confirm-delivery`: unchanged.

**Choices made in the build, for review:**

1. **One extra read for a buffer courier.** To answer `not_eligible` rather than `not_open`, a buffer courier's accept runs one read under the claim's guards plus the buffer guards, selecting `tracking_id` only. It only chooses the refusal reason; the guards that decide the claim stay in the UPDATE itself, so a job that changes after the read is still refused there. A buffer courier who passes the read and then loses the claim gets `not_open`. A full courier's accept runs the same two queries as before, and a test pins that. **The leak, restated:** `not_eligible` on a job whose areas are both on the list tells a buffer courier that its declared value is over GHS 200 or was never declared. That is the one bit accepted in 6.10 decision 4.
2. **The exposure test's readers rule changed; the allowlist did not.** Accept and mine no longer call `from("guest_jobs")` themselves, so `tests/declared-value-exposure.test.ts` now requires `lib/guest-claim.ts` to be a reader (and so subject to the bare and star select rules), and accepts a courier-reachable route that reads `guest_jobs` either itself or by importing `@/lib/guest-claim`. The `ALLOWED` set is unchanged. Mutation-checked after review: `declared_value_cedis` added to a select in `lib/guest-claim.ts` failed the scan, and the guard rewritten as `.filter("declared_value_cedis", "lte", ...)` failed it too. Both reverted, diff empty.
3. **`confirmCourierCode` has no caller until part (c).** It mirrors the courier branch of `/api/guest/confirm-delivery`, matching on whichever assignment column the route passes, and is tested on its own. `MAX_CODE_ATTEMPTS = 5` now exists in both places. **Part (c) must leave one:** either `confirm-delivery` imports it from `lib/guest-claim.ts`, or the duplicate is otherwise removed.
4. **Delivery code minting moved into `claimGuestJob`,** so no accept route can assign a job without a code. The commission stays in the route, because `tests/guest-commission.test.ts` allows exactly the three guest routes to import `lib/guest-commission.ts`.
5. **A shredded Pioneer is refused as `courier_not_registered`:** 403, `{ ok: false, reason: "courier_not_registered" }`. `courier_find_pioneer` returns no row for a shredded row, so the route cannot tell it from an unregistered one. The `unavailable` reason in the 6.4 table applies to the legacy route, which reads the row by id. A lookup error, a result that is not a list, or more than one row, answers 503 `auth_unavailable`.
6. **`status` alone sets the tier,** as the 6.4 table reads. A `full` row is full whatever `paused_reason`, `kyc_approved_at` or `vouched_at` hold. Catalog check 14 reports a full row with neither timestamp, but nothing refuses one. **To follow:** a new CHECK migration requiring `kyc_approved_at` or `vouched_at` on a `full` row. Not drafted; it is its own reviewed migration, and no applied file is edited.

**Tested:** 890 tests pass in 45 files, 56 new against 834 at `f2a21ef`; that baseline is derived from a run with the two new lib files already present, which the logging sweep counts once each, not measured at `f2a21ef` itself. New: `tests/courier-ladder.test.ts` (the table, the 30-day boundary to the millisecond, the guards, the cap, no resolver imports), `tests/guest-claim.test.ts` (a legacy-shaped claim, the id-matched list, the cancelled rule, every `confirmCourierCode` outcome), and in `tests/routes/guest.test.ts` the lookup, the three 403 reasons, the 503s, both tiers' guards, the cancelled rule per status and the open filter. Existing accept tests in `guest.test.ts` and one in `identity.test.ts` gained a registered full courier as fixture; their assertions are unchanged. Mutation-checked: removing the both-null guard, the cancelled rule, or moving the 30-day boundary by a millisecond each failed a test. `tsc --noEmit` shows the same 4 errors as before, none new. `next build` passes. `npm run security`: no leaks, only the two recorded postcss exceptions.

**Mirroring:** the two new libs, `lib/declared-value.ts`, the three routes and the two new test files name no network: bytes. `tests/routes/guest.test.ts`, `tests/routes/identity.test.ts`, `tests/declared-value-exposure.test.ts` and these notes are scanned at mirror time as usual.

**Mainnet order:** P13 and its verification cell; then the decision A pre-flight, each existing Pioneer courier registered with `courier_register_pioneer` and read back through `courier_find_pioneer` (invariant 8); only then the deploy carrying this commit. Without P13, `/api/guest/open` names a missing column and the job board answers 500 for every Pioneer. Without the registrations, every Pioneer accept answers 403 `courier_not_registered`. Mainnet on a go-ahead.

### 6.13 Item 6 part (c) built, 11 Oct 2026

Built on `feat/anchoring-phase1` at `c1b0868`, on top of `b107537`. Not pushed. No SQL run, nothing applied on either network by this work. No migration edited, and no listings route, payments route or `lib/route-auth.ts` touched.

**Files:**

- `app/api/courier/jobs/accept/route.ts`: body `{ trackingId }` only. The registry row read by the session's courier id (`status, buffer_since, shredded_at`), the ladder, `readClaimableQuote`, `passesBufferGuards` for a buffer courier, and `claimGuestJob` writing `assigned_courier_id` with `assigned_courier` and `assigned_courier_whatsapp` null. Marked `ATTESTATION WRITE: founder review required`.
- `app/api/courier/jobs/mine/route.ts`: `readCourierJobs` on `assigned_courier_id`, the same response shape as `/api/guest/mine`, recipient withheld when `cancelled`.
- `app/api/courier/jobs/confirm-delivery/route.ts`: body `{ trackingId, code }`, `confirmCourierCode` on `assigned_courier_id`. Marked `ATTESTATION WRITE: founder review required`.
- `/api/guest/confirm-delivery`: the courier branch now calls `confirmCourierCode` on `assigned_courier`, so `MAX_CODE_ATTEMPTS` is defined once, in `lib/guest-claim.ts` (6.12 choice 3). The sender branch is unchanged apart from its select list.
- `lib/schemas.ts`: `CourierJobsAcceptBody`, `CourierJobsMineBody`, `CourierJobsConfirmDeliveryBody`, all strict.
- `lib/rate-limit.ts`: `courier_accept` 30 per 10 m, closed; `courier_confirm` 30 per 1 h, open. Legacy `mine` spends `courier_me`.
- `lib/courier-host.ts`: `COURIER_GUEST_APIS` is `/api/guest/open` alone. The courier host now answers 404 to guest accept, mine and confirm-delivery.
- `app/courier/courier-jobs.tsx`, rendered by `courier-panel.tsx`: the courier's own jobs with the delivery code entry, and the open board with a take button while `/api/courier/me` says `buffer` or `full`. Every string COPY DRAFT, not yet through the gyema-accuracy checklist.

**Behaviour change in a Pioneer route, for review.** On the courier branch of `/api/guest/confirm-delivery`, `resolveCaller` now runs before the job is read. A request with no token or a bad one gets 401 where it used to get 404, 409 `no_code` or 500 from the lookup. For a valid Pioneer token every outcome is unchanged: same reasons, statuses and bodies. The sender branch's select no longer reads `assigned_courier` or `delivery_code_attempts`, which it never used.

**Choices made in the build, for review:**

1. **Each limit runs after `resolveCourier`,** not before as 6.3's sentence orders it, because every bucket is keyed on the courier id. This matches `kyc/start`.
2. **`not_open` answers 200 `{ ok: false }`,** as `/api/guest/accept` does.
3. **A registry read error on accept is 503 `auth_unavailable`.** A missing row goes through the ladder as 403 `courier_not_registered` (`/me` answers 500 for the same case). The session's foreign key makes a missing row unreachable in practice.
4. **`mine` is a POST with an empty strict body and the CSRF check,** like the kyc routes (6.2's table).
5. **The board shows for `buffer` and `full` only.** `/me` does not compute the 30-day limit, so a buffer courier past it still sees the board and is refused on accept with `courier_not_active`. **Superseded by the review follow-ups below:** the page now decides from `effectiveTier`.
6. **`tests/guest-commission.test.ts`'s importer list** gains the legacy accept and mine, which compute and show `remit_cedis` as their guest counterparts do. Both are still under `app/api/`.
7. **`scripts/dispatch-reader.mjs:95` keeps its own `MAX_CODE_ATTEMPTS`.** It is a script in part (d)'s scope; "one place" here means the TypeScript routes and libs, and a test pins that. **Founder decision, 11 Oct 2026:** folding the reader's copy into the shared figure is part of part (d).

**The go-live gate still holds, and why.** This commit makes a legacy accept possible on deploy. No legacy courier can take a job until their row is `buffer` or `full`, which needs PiVerify `pending_review` or a hand status change. **A hand status change on a legacy row before the item 8 tracker fix would put a legacy job on the public tracker as "a Pi Pioneer is carrying it" (6.8).**

**Founder decisions, 11 Oct 2026, on the gate:**

- **On every network, the item 6 code deploys only together with the item 8 tracker fix** (`components/delivery-tracker.tsx` no longer naming a Pi Pioneer or any courier, and `/api/guest/track` returning only `courierAssigned: boolean`, 6.10). Never the item 6 code alone.
- **No legacy `courier_registry` row is set to `buffer` or `full` by hand before that deploy,** on any network.

**Tested:** 935 tests pass in 46 files, 45 new against 890 at `b107537`. New: `tests/routes/courier-jobs.test.ts` (27 at first, 28 with the `MAX_CODE_ATTEMPTS` pin), two in `tests/routes/guest.test.ts` (a Pioneer refused on a legacy-claimed job with no attempt spent, and the caller resolved before the read), and nine in `tests/routes/identity-separation.test.ts` (per jobs route: a Pioneer token in Authorization 401, in the body 400, a courier cookie on the pioneer surface 404, none reaching GoTrue or an RPC). Updated: `tests/courier-host.test.ts`, `tests/schemas.test.ts` (28 routes), `tests/rate-limit.test.ts`, `tests/guest-commission.test.ts`, `tests/declared-value-exposure.test.ts`. **Mutation-checked**, each reverted from a copy: a legacy confirm or mine matching on `assigned_courier` failed 4 and 2 tests; the claim UPDATE without `.is("assigned_courier_id", null)` failed 3; the legacy accept's read without it failed 1; `/api/guest/confirm-delivery` back in `COURIER_GUEST_APIS` failed 2. `tsc --noEmit` shows the same 4 errors as before, none new. `next build` passes. `npm run security`: no leaks, only the two recorded postcss exceptions.

**Review follow-ups, built 11 Oct 2026 at `8b93951`:**

- **`GET /api/courier/me` returns `effectiveTier`** (`full`, `buffer` or `none`), computed by `effectiveTier` from `lib/courier-ladder.ts` on the session's `status` and the row's `buffer_since`, with the server clock. `buffer_since` joins the one registry read `/me` already makes (`readCourierKycRow`), so `/me` still costs one SELECT; `kyc/start` and `kyc/refresh` read the same function and now select the column too, unused. No change to `status` or to any write.
- **The page decides from `effectiveTier`, never from `status`.** The board is offered on `buffer` or `full`. When `status` is `buffer` and the tier is not, the panel shows one line: "Your verification has taken longer than 30 days. Jobs are paused until it completes." (COPY DRAFT). It also shows for a buffer row with a null `buffer_since`, which the ladder refuses closed and catalog check 14 reports; the sentence is not accurate for that row.
- **A buffer courier's board hides any job whose pickup or dropoff area is not on `GUEST_AREA_NAMES`,** exact match, the list `bufferJobGuards` uses, so an untrimmed off-list value is hidden too. Nothing about the declared value is on the board: a listed-area job over the buffer cap still shows and is refused on accept with `not_eligible` (6.10 decision 4).
- **The decisions live in `app/courier/courier-view.ts`,** pure, because the repository has no component renderer. `tests/courier-view.test.ts` tests them and pins, statically, that the panel and the job list use them and compare no stored status with `buffer` or `full`. `tests/courier-auth.test.ts` tests `/me`'s tier one millisecond inside 30 days (`buffer`), at exactly 30 days and past it (`none`, status still `buffer`), a null `buffer_since`, and the other statuses.
- **Tested:** 946 tests pass in 47 files, 11 new. **Mutation-checked**, each reverted from a copy: the panel handing the job list a tier derived from `status` failed 2 tests; the job list ignoring the tier failed 1; the buffer board unfiltered failed 1; `/me` deriving the tier from `status` failed 3. `tsc --noEmit` shows the same 4 errors, none new. `next build` passes. `npm run security`: no leaks, only the two recorded postcss exceptions.

**Mirroring:** `app/courier/courier-view.ts`, `tests/courier-view.test.ts`, `lib/courier-kyc.ts` and `app/api/courier/me/route.ts` name no network: bytes, with the files below. The three routes, `app/courier/courier-jobs.tsx`, `courier-panel.tsx`, `page.tsx`, `lib/courier-host.ts`, `lib/guest-claim.ts`, `lib/schemas.ts`, `/api/guest/confirm-delivery` and the new test file name no network: bytes. `lib/rate-limit.ts` and `tests/rate-limit.test.ts` hit the scan (the namespace comments) and get the change hand-applied. The other updated tests and these notes are scanned at mirror time as usual.

### 6.14 Item 6 part (d) built, 11 Oct 2026

Built on `feat/anchoring-phase1` at `22baef4` (wording fix `2bcd1e8`), on top of `4c667a7`. Not pushed. No SQL run, nothing applied on either network, no database connected. No migration, app route, `lib/route-auth.ts` or `lib/guest-claim.ts` changed.

**What changed in `scripts/dispatch-reader.mjs`:**

- **`REQUIRED_COLUMNS`** gains P14's `assigned_courier_id` and `declared_value_cedis`, and a `courier_registry_dispatch` entry with all eight of P15's columns. A missing P14 or P15 fails the preflight before any section, and the failure names the migration file to apply, per missing column. Exit 1, no report.
- **Check 0.5 is keyed on either assignment column.** The where clause has one arm per column, `assigned_courier is not null and ... or assigned_courier_id is not null and ...`, with no parentheses: the read only guard refuses any after a boolean operator (the 0.3 precedent), and AND binds tighter than OR. Its subtitle names both accept routes as writers of `remit_cedis`. It was the only where clause keyed on `assigned_courier`; the rest was display.
- **The courier on a job.** The courier references are read once, before any section, from `courier_registry_dispatch` (`courier_ref, class, status`). Every guest section that showed `assigned_courier` now selects `assigned_courier_id` too and prints two fields: `assigned_courier` as stored (null on a legacy claim) and `courier_ref`, taken from the view row whose reference is the first 8 characters of the id. The full id is never printed. Check 0.5's flag names a legacy courier by reference rather than "(null)".
- **`declared_value_cedis`** in sections 1 to 6. A null prints "(null, no value declared)". No footer prints or sums it.
- **Section 10**, buffer couriers due a hand pause: `status = 'buffer'`, not shredded, and `buffer_since` at or past 30 days, or null.
- **Section 11**, PiVerify sessions untouched for 24 hours: `created`, `started`, `pending_review` or `rejected`, not shredded (amended below).
- **`MAX_CODE_ATTEMPTS` and `BUFFER_WINDOW_DAYS`** are no longer defined in the script. Each is read as text, at load, from its one definition (`lib/guest-claim.ts`, `lib/courier-ladder.ts`).

**Choices made in the build, for review:**

1. **The shared figures are read as source text.** A plain Node script cannot import `lib/*.ts` (TypeScript, the `@/` alias). The script requires exactly one `export const NAME = <integer>` line and no other assignment to the name, and refuses to start otherwise, naming the file. The alternative, a leaf constants file that `lib/guest-claim.ts` re-exports, edits `lib/guest-claim.ts`, which this part was not to touch.
2. **Check 0.5 as two arms, not `coalesce(...)`.** `coalesce` would widen `ALLOWED_CALLS` beyond seven, and the trim probe is on record to stop exactly that.
3. **One gap in P15, and how the reader handles it.** "Unsettled" (`isUnsettled` in `app/courier/courier-panel.tsx`) includes a `rejected` session that carries a `piverify_allowed_action`. P15 does not carry that column, and `courier_apply_kyc_status` writes `paused_reason = 'rejected'` whether or not an action is allowed, so the view cannot tell a reopenable rejection from a final one. Section 11 lists a stale `rejected` row apart, flagged "CANNOT TELL", and its footer counts it in its own bucket, never as unsettled. Closing the gap means adding the column to P15, a migration change, so it is not done here. **Superseded by the P15 amendment below:** the gap is closed.
4. **Section 10 includes a buffer row with a null `buffer_since`,** flagged apart. The ladder refuses it closed; catalog check 14 also reports it.
5. **Both courier sections leave out shredded rows:** there is no one left to pause or nudge.
6. **A failed courier reference read stops the report** with exit 1 before any section, rather than printing jobs whose courier cannot be named.
7. **An 8-character reference shared by two registry rows** prints as ambiguous, with the count, and is never resolved to one row. A reference with no registry row prints as such.
8. **Declared value in sections 1 to 6 only:** the pre-claim and active queue, where the buffer cap matters. Not in 7, 8, 8b or the checks.

**Deploy order, amended.** The reader requires P15 as well as P14, so step 5 of 6.9 moves: P14, then P15, then the reader. `docs/deploy-order.md` (the P14 and P15 rows, and the order line) says so. **On each network, once this reader is on `main`, `npm run dispatch` fails its preflight until both P14 and P15 are applied there.** That is the intended behaviour, a clear refusal rather than a short report, but the merge and the SQL are sequenced together. The migration headers need no change: P14 already says the new reader refuses to run without its columns, and P15 says to apply it before a reader that reads the view (amended below).

**Tested:** 960 tests pass in 47 files, 14 new against 946 at `4c667a7`, all in `tests/dispatch-reader.test.ts`. Mocked rows: a Pioneer job, a legacy job, an unassigned job and a job with no declared value through every guest section; check 0.5's where clause evaluated against them by a small evaluator in the test that throws on any term it cannot read; a fake client whose `information_schema` rows lack P14's `assigned_courier_id`, and another lacking P15's view, each failing the preflight with the right file named; the reference lookup sent as one guarded SELECT on the view; the shared-figure parser refusing zero, two, or a reassigned definition; the dry run accepting all 19 statements. The existing masked-view test now also refuses `from public.courier_registry` and any identifying registry column in any statement. **Mutation-checked**, each from a copy, the file restored byte-identical after: check 0.5 keyed on `assigned_courier` alone failed 1 test (the legacy row dropped out); `courier_ref` printing the raw `assigned_courier_id` failed 1; the script keeping its own `MAX_CODE_ATTEMPTS = 5` failed 1; P14's `assigned_courier_id` dropped from `REQUIRED_COLUMNS` failed 3. `tsc --noEmit` shows the same 4 errors as before, none new. `next build` passes. `npm run security`: no leaks, only the two recorded postcss exceptions.

**Amendment to P15, 11 Oct 2026, at `dd8607d`.** Made before any network applied P15 (the Testnet catalog of 10 Oct, 11:31, reads the P15 rows false; Mainnet has none of item 6), so the unapplied file was edited in place, on the founder's approval for this one change.

- **P15:** `courier_registry.piverify_allowed_action` appended as column 9; the first eight keep their positions. Grants, revokes, masking, `security_invoker`, ownership and the guard are unchanged, and so is the `comment on view`. The header's list of what the view carries names the new column, and its prerequisites now name P9, which adds the column: without P9 the create fails with 42703 and no view exists. The verification cell is still 8 rows; its column row now reads "exactly 9 columns, by name, in order".
- **What the column can hold.** `text`, but P9's `courier_registry_piverify_allowed_action_check` holds it to `RESUBMIT`, `APPEAL` or null, and only while `piverify_status` is `rejected`. Its two writers are `courier_apply_kyc_status` (P9) and `courier_piverify_bind` (P12, null). Nothing in it names a person.
- **Updatable, and still covered.** The view stays a plain projection, so the new column is writable through it like the others. The existing revoke from public, anon, authenticated and service_role covers it: nobody but gyema_reader holds anything, and gyema_reader holds SELECT.
- **`docs/catalog-checks.sql`:** a fourth `2026-10-10 courier registry dispatch` row in check 9, column 9 is `piverify_allowed_action` and the view has 9 columns. The expectations say four rows.
- **The reader:** `REQUIRED_COLUMNS` carries all nine columns. Section 11 lists a `rejected` session only while `piverify_allowed_action` is not null, as `isUnsettled` in `app/courier/courier-panel.tsx` does, as a second flat arm of the where clause (no parentheses after a boolean operator, the 0.3 precedent). A rejection with no allowed action is final, settled, and not listed. The CANNOT TELL flag and its footer bucket are removed; the footer counts one bucket, and the row shows `piverify_allowed_action`. The column leaves the test's hidden-column list.
- **Tested:** 961 tests pass in 47 files (960 before; the section 11 test is now two, one pinning the clause and one evaluating it against rows). The test's where-clause evaluator now reads `=`, `in (...)` and the `now() - interval` comparison. **Mutation-checked** from a copy, the file restored byte-identical after: section 11 without `piverify_allowed_action is not null`, so listing a final rejection, failed 2 tests. `tsc --noEmit` shows the same 4 errors, none new. `next build` passes. `npm run security`: no leaks, only the two recorded postcss exceptions.
- **Database:** the 6.11 fixture, run twice in full on 11 Oct 2026 against a throwaway `postgres:17-alpine` (17.11). No Gyema database was touched. Both runs: P15 applied twice, `all_present: true` both times; P13 and P14 unchanged and true; catalog check 9 all 16 item 6 rows true after (0 before), check 11 showing the view at 9 columns, check 3 gyema_reader SELECT alone. 78 probes passed, 0 failed: the 68 before plus ten new. Column 9 by name and type; gyema_reader reads `RESUBMIT` on a reopenable rejection and null on a final one, and sees nothing but `RESUBMIT`, `APPEAL` or null; P9's check still refuses free text (23514); the reader's own section 11 statement, run as gyema_reader, lists the stale reopenable rejection and the stale started session, and not the final, the fresh or the shredded rejection; gyema_reader and service_role cannot update the column through the view (42501); anon and authenticated cannot read it. Negative runs as before (the DELETE grant turning the cell false naming `service_role:DELETE`, the re-run true), plus P15 without P9: 42703, and no view.

**Mirroring:** `scripts/dispatch-reader.mjs` hits the scan on four unchanged lines (line 12 and the commission window block name Testnet), and this change adds no hit. The file states it stays byte identical between networks, so it mirrors as bytes; line 12 is already queued for a separate correction in both repos. `tests/dispatch-reader.test.ts` hits once, on an unchanged line, and mirrors as bytes for the same reason. `docs/deploy-order.md` and these notes are scanned at mirror time as usual.

## Item 7: `declared_value_cedis` (approved 10 Oct 2026, built, not applied)

Design approved by the founder, 10 Oct 2026, with the decisions in 7.7, which win over anything earlier in this section. Built as designed (7.8). Nothing applied on either network. Designed at `0855e84`. Built before item 6 (6.10 decision 3). Read from: `app/api/guest/create/route.ts`, `app/send/page.tsx`, `lib/schemas.ts`, every `guest_jobs` select list under `app/api/guest/` and `app/api/courier/`, `2026-09-15_dispatch_view_remit_cedis.sql`, `2026-09-07_grant_baseline.sql` (section 5) and `docs/catalog-checks.sql`.

Settled by answer 6: required on every new guest job, refused above GHS 500, used server side only, shown to the sender and the operator, never returned to any courier. Four points it does not settle are in 7.6.

### 7.1 Migration, P12b: `db/migrations/2026-10-10_guest_jobs_declared_value.sql`

**Numbering.** P13 to P15 are item 6's, approved. Item 7 goes before them, so it takes `P12b`, after the `P1b` precedent. No approved row is renumbered.

1. `alter table public.guest_jobs add column if not exists declared_value_cedis integer null`.
2. A named check, `guest_jobs_declared_value_cedis_check`, added only if absent (guarded on `pg_constraint` in a `do` block, as P13 plans): `declared_value_cedis is null or declared_value_cedis between 0 and 500` (7.6, questions 1 and 2).
3. **Nullable, and it must be.** Every row posted before item 7 holds null, and stays full-tier only for good (6.7 B). `NOT NULL` would refuse the add. A `NOT VALID` not-null check is not proposed either: Postgres checks it on every later UPDATE, so the operator's hand status writes on an old row (F14) would start failing. "Required" is the route's rule for new rows.
4. No grant. service_role holds the table-wide grant (2026-09-07 section 5), which covers a new column. anon, authenticated and gyema_reader hold nothing on `guest_jobs` (catalog check expectation), so they get nothing here.
5. **Last statement, the verification cell**, as P2 and P11: the column (type `integer`, nullable), the check by name and its definition, and `column_privileges` on the new column showing no anon, authenticated or gyema_reader, with `all_present`.

**`docs/catalog-checks.sql`:** three check 9 rows (the column, the named check, and the column privileges of anon, authenticated and gyema_reader), and a new check 16 with three counts: rows with a value, rows without, and null rows posted after the first row carrying a value (expect 0 once the code is live; nothing enforces it in the database).

**Order, per network: P12b BEFORE the item 7 code deploys.** The insert names the column, so against a missing column every guest post answers 500. That would take guest sending down on that network. Then the item 6 order in 6.9 follows unchanged.

### 7.2 Schema and route

- **`lib/declared-value.ts`** (new, no imports): `DECLARED_VALUE_CAP_CEDIS = 500`, one place for the form and the schema. Item 6 adds the GHS 200 buffer cap beside it.
- **`GuestCreateBody`** gains `declaredValueCedis`, **required**: `z.number().finite().int().min(0).max(500)`, following `piAmount`. The form reads it from a text input, so NaN is one keystroke away.
- **Refusal reasons**, both named in `reasonFor`: above the cap, `declared_value_over_cap`; anything else wrong (missing, negative, fractional, a string, NaN), `invalid_declared_value`. Both 400, nothing written, as every create refusal.
- **`/api/guest/create`** writes `declared_value_cedis` on every insert, listed and off-list alike ("every new guest job" includes `pending_quote`).
- **The insert's `.select()` narrows to `"tracking_id, status"`,** the two fields the response uses. Today it reads the whole row back, which after this would include the value. It never left the server, but nothing should fetch it back that does not use it.
- **The value is not in the create response.** The sender already holds it in the form.

**A cached `/send` bundle sends no value and is refused** with `invalid_declared_value` until the page reloads. `/send` is an ordinary browser page, not Pi Browser, so a reload fixes it. The form message for that reason (7.3) says what to do.

### 7.3 Form, `app/send/page.tsx`

- One field on the form step, after "What is it?": a text input with `inputMode="numeric"`, whole cedis, digits only.
- "Get my price" stays disabled until it holds a whole number from 0 to 500. Above 500 the field shows the over-cap line and the button stays disabled, so a sender learns before the quote step, not at submit.
- The quote step shows it back in one summary line, so the sender sees what they declared before confirming.
- The WhatsApp fallback message (`waFallbackLink`) carries it, because that message is everything the operator needs to post the job by hand, and the route now requires it.
- **Not on the tracker.** `/api/guest/track` and both tracker components answer anyone holding a tracking id, and every courier holds one. "Shown to the sender" is the sender's own form only.

**COPY DRAFT** (founder review and the gyema-accuracy checklist before it ships; GHS 500 traces to answer 6):

| Where | Text |
| --- | --- |
| Label | "Value of the package (GHS)" |
| Placeholder | "e.g. 150" |
| Help line | "Required. During the pilot we carry packages worth up to GHS 500. Your courier does not see this." |
| Over the cap (field and `declared_value_over_cap`) | "During the pilot we can only carry packages worth up to GHS 500." |
| `invalid_declared_value` | "Enter the package value in whole cedis, from 0 to 500. If this keeps happening, reload the page." |
| Quote step summary | "Declared value: GHS {n}" |
| WhatsApp fallback line | "Value: GHS {n}" |

**Not in the copy, on purpose:** any word on insurance, cover, compensation or liability. Nothing pays out on this figure, and escrow and payouts are never described in the present tense until live. Nor does the copy say what the value is used for: until item 6 lands it is recorded and nothing reads it, so "we use it to match your courier" would be a roadmap claim in the present tense.

### 7.4 Never returned to a courier, and the test that pins it

Today no select list under `app/api/guest/` or `app/api/courier/` names the column, and only one call reads a whole `guest_jobs` row (the create insert's bare `.select()`, narrowed in 7.2).

**`tests/declared-value-exposure.test.ts`, a static scan with an allowlist,** so item 6's new routes are covered the day they appear:

1. Every file under `app/`, `lib/` and `components/` is read. `declared_value` and `declaredValue` (any case) may appear only in `app/api/guest/create/route.ts`, `app/send/page.tsx`, `lib/schemas.ts` and `lib/declared-value.ts`.
2. **One exception, for item 6 and only in this form:** a filter call, `.lte("declared_value_cedis", ...)` (or `.lt`, `.gt`, `.gte`), is stripped before the scan. A filter compares in the database and returns nothing. Any other occurrence, in a select string, a `*_COLUMNS` array, a row type or a mapper, fails.
3. Every route file that reads `guest_jobs`, except create, must not call `.select()` with no argument or with `"*"`, which would return the column without naming it.
4. Named explicitly in the test, so a reviewer sees them: `guest/accept`, `guest/mine`, `guest/open`, `guest/track`, `guest/confirm-pickup`, `guest/confirm-delivery`, `guest/delivery-code`, and everything under `app/api/courier/`.

**Other tests:**

- `tests/schemas.test.ts`: required; 0 and 500 accepted; 501 gives `declared_value_over_cap`; -1, 1.5, NaN, `"150"` and missing give `invalid_declared_value`. The existing `GuestCreateBody` fixtures gain the field.
- `tests/routes/guest.test.ts` and `tests/routes/limits.test.ts`: fixtures gain the field. Create writes `declared_value_cedis`, listed and off-list; 501 and missing are refused with no insert; the insert reads back `tracking_id, status` only; the value is not in the response.
- `tests/guest-declared-value-migration.test.ts`: static checks on the file (nullable, integer, the named check and its bounds, guarded add, no grant, verification cell last).
- **Docker, as before:** a throwaway `postgres:17-alpine` with the Supabase roles and a fake `guest_jobs` reduced to the columns the file and the probes touch, holding old rows. No Gyema database touched. Two runs, both `all_present` true; catalog checks before and after; probes: an old null row still accepts a status UPDATE; 0 and 500 accepted; -1 and 501 refused by the check; service_role reads and writes the column; anon, authenticated and gyema_reader refused.

### 7.5 Mirroring

The migration, `lib/declared-value.ts`, `lib/schemas.ts`, the create route and the new tests name no network: bytes. `app/send/page.tsx` names the pinet host (the disabled-state link) and hits the scan: the change is hand-applied onto Mainnet's own copy. `docs/deploy-order.md` and these notes, as before.

### 7.6 Open questions for the founder

1. **Type and floor.** Recommended: `integer`, whole cedis, 0 allowed. `quote_cedis` is whole cedis too, and both caps (200, 500) are whole, so `.lte(200)` in 6.4 compares exactly. 0 is an honest declaration for documents with no resale value. The alternative floor is 1, which forces a non-zero figure but cannot force a true one.
2. **Where the GHS 500 lives.** Recommended: in both the schema and the database check, so raising the pilot cap is a reviewed code change plus a reviewed migration, and a hand edit or a code bug cannot store a value above the liability cap. The alternative is a database check of `>= 0` only, so raising the cap is one code change.
3. **"Shown to the operator": which surface.** The Supabase table editor shows it the moment P12b lands. The dispatch reader does not: that needs `guest_jobs_dispatch` to carry it. Recommended: no view change in item 7; **amend P14** (approved in item 6) to append both `assigned_courier_id` and `declared_value_cedis`, in that order, and the reader to show it. The alternative is a view replace in item 7 (P12c), after which P14's pre-flight and column positions change. Either way the approved P14 text changes, so it needs your word.
4. **P-number.** `P12b`, as above, rather than renumbering item 6's approved rows.

All four are answered in 7.7.

### 7.7 Founder decisions, 10 Oct 2026

Approved as designed, with these answers to 7.6:

1. **`integer`, whole cedis, 0 allowed.**
2. **GHS 500 in both the schema and the named database check,** `guest_jobs_declared_value_cedis_check`. Raising the pilot cap is a reviewed code change plus a reviewed migration.
3. **No view change in item 7.** P14 (item 6) is amended to append `assigned_courier_id` then `declared_value_cedis`, and the dispatch reader shows the value. The 6.6 P14 text is updated to match.
4. **`P12b`.**

### 7.8 Built, 10 Oct 2026

**Files:**

- `db/migrations/2026-10-10_guest_jobs_declared_value.sql` (P12b): the column, the guarded named check, and the verification cell (11 rows, `all_present`). No grant, no revoke, no view.
- `docs/catalog-checks.sql`: the three check 9 rows and check 16, with expectations. Check 16 reads the column through `query_to_xml`, so it parses and reads `exists: false` before P12b.
- `lib/declared-value.ts`: `DECLARED_VALUE_CAP_CEDIS = 500`, no imports, shared by the form and the schema.
- `lib/schemas.ts`: `declaredValueCedis`, required in `GuestCreateBody`, and the two reasons in `reasonFor`.
- `app/api/guest/create/route.ts`: writes `declared_value_cedis`; the insert reads back `tracking_id, status` only.
- `app/send/page.tsx`: the field, the over-cap line, the quote step summary, the WhatsApp fallback line, and the two refusal messages. Every string is marked COPY DRAFT in the source.
- `docs/deploy-order.md`: the P12b row, and the P14 note.

**Tests:** 807 pass (778 before, 29 new), in 42 files. 28 are written for item 7, below; the 29th is `tests/logging.test.ts` picking up `lib/declared-value.ts` as a new file to sweep.

- `tests/declared-value-exposure.test.ts` (6 at first commit, 7 after the follow-up below): the allowlist scan, the filter exception tested on its own, no bare or `"*"` select on `guest_jobs` outside create, and every route under `app/api/courier/`. Mutation-checked: adding the column to `guest/mine`'s column list failed the scan, and adding `.select("*")` to `guest/open` failed the select rule. Both reverted.
- `tests/guest-declared-value-migration.test.ts` (8): static checks on the file and the catalog checks.
- `tests/schemas.test.ts` (4 new): required; 0, 1, 200, 499 and 500 accepted; 501, 1000 and 1e9 give `declared_value_over_cap`; -1, 1.5, 0.01, NaN, Infinity, `"150"`, `""`, null and `true` give `invalid_declared_value`.
- `tests/routes/guest.test.ts` (10 new): written on listed and off-list jobs; the cap accepted; never in the response; 501 refused with no database call; missing, null, negative, fractional and string refused with no database call; the read-back is `tracking_id, status`.
- Fixtures in `guest.test.ts`, `limits.test.ts` and `schemas.test.ts` gain the field.

**Checks:** `tsc --noEmit` shows the same 4 errors as before the change, none new (`app/page.tsx:200`, `components/track-view.tsx:239` and `:314`, `tests/audit-gate.test.ts:2`). `next build` passes. `npm run security`: gitleaks finds no leaks, and the audit gate passes with only the two recorded postcss exceptions.

**Database:** run on 10 Oct 2026 against a throwaway `postgres:17-alpine` (17.11) in Docker. The setup had the four Supabase roles, grant baseline section 1a, and a fake `guest_jobs` with RLS on, service_role holding the table-wide grant, and three rows posted before the column. No Gyema database was touched.

- The migration ran twice. Both runs exited 0 and both verifications read `all_present: true` over 11 rows. The stored check reads `CHECK (((declared_value_cedis IS NULL) OR ((declared_value_cedis >= 0) AND (declared_value_cedis <= 500))))`.
- **Catalog checks before and after:** the three check 9 rows went from false to true; check 16 went from `exists: false` to 0 with a value, 3 without, and 0 null rows after the first valued row; check 12 stayed empty; check 4 still shows nothing on `guest_jobs`.
- **21 probes passed in one run:**
  - old null rows still take a status UPDATE and a `phone_verified` UPDATE (the F14 hand writes)
  - 0, 200 and 500 accepted
  - -1 and 501 refused on insert, and an update to 501 (valued row) or 600 (old null row) refused, all by the named check (23514)
  - text refused by the type (22P02)
  - service_role reads, inserts and updates the column, and is still refused over the cap
  - anon, authenticated and gyema_reader refused (42501)
- **Recorded, not a refusal:** a numeric literal `1.5` inserted in SQL is rounded to 2 by Postgres's assignment cast. The string `'1.5'` is refused. The schema refuses any fraction before the route inserts, so the route never sends one.
- **Negative runs:**
  - A column-level `SELECT` granted to anon turned the anon row and `all_present` false; revoking it turned both true again.
  - A pre-existing `numeric(10,2) not null default 0` column was kept (`add column if not exists` skipped it), and the verification read false on the type, nullability and bounds rows.
  - With a value of 900 already stored, the check could not be added: the file stopped with a 23514 error naming the check. The file is not one transaction, so the column add before it stays, and re-running after fixing the row completes it. This cannot happen on a real network, where the column is new and every row is null.

**Follow-up after review (own commit):** the star rule in the exposure test first caught only a select string that was exactly `"*"`. It now catches a star anywhere in the string, so `"*, remit_cedis"` and an embedded `"id, courier_registry(*)"` fail too, with a control test of its own (7 tests in the file, 808 in the suite).

**A constraint item 6 inherits from the exposure test.** The scan's one exception is the literal filter call, `.lte("declared_value_cedis", ...)` (or `.lt`, `.gt`, `.gte`), written in place. Item 6's buffer guard (`bufferJobGuards()` in `lib/courier-ladder.ts`, the claim UPDATE in `lib/guest-claim.ts`) must use that literal form. A guard written as data, with the column name in a constant or an object, fails the scan, and widening the allowlist is a founder decision, not a build choice.

**Mirroring:** the migration, `lib/declared-value.ts`, `lib/schemas.ts`, the create route and the two new test files name no network: bytes. `app/send/page.tsx` hits the scan (the pinet host in the disabled state), so its change is hand-applied onto Mainnet's own copy. `tests/schemas.test.ts`, `tests/routes/guest.test.ts`, `tests/routes/limits.test.ts`, `docs/catalog-checks.sql`, `docs/deploy-order.md` and these notes are scanned at mirror time as usual.

**Founder steps, per network:** P12b, read the cell (`all_present` true), then `docs/catalog-checks.sql` (the three 2026-10-10 rows true, check 16 `exists: true`). Only then deploy the item 7 code. Mainnet on a go-ahead.

## Item 8 (design, 11 Oct 2026)

Design only. Designed on `feat/anchoring-phase1` at `81c0509`. No code, no SQL, nothing applied. Read from: `CLAUDE.md`, these notes (item 6 including 6.13, item 7, and "Item 8 scope additions" A and B at the top, which this section answers and does not restate), `app/api/guest/track/route.ts`, `lib/guest-jobs.ts`, `components/delivery-tracker.tsx`, `components/track-view.tsx`, `components/track-tab.tsx`, `components/guest-courier-card.tsx`, `components/guest-job-sheet.tsx`, `components/trips-tab.tsx`, `components/listing-detail-sheet.tsx`, `components/ui/badge.tsx`, `app/globals.css`, `app/layout.tsx`, `middleware.ts` (matcher), `lib/csp.ts` (img-src), `public/`, `app/courier/{page.tsx,courier-panel.tsx,courier-jobs.tsx,courier-view.ts}`, `components/courier-test-banner.tsx`, `components/testnet-banner.tsx`, `app/send/page.tsx`, `lib/guest-pricing.ts`, `lib/listings.ts`, `lib/listings-async.ts`, the listings status writers (`cancel-open`, `cancel-matched`, `cron/expire-stale-listings`), and the tests that call the track route.

**Stop rule, checked.** Every fix proposed below lands in a guest route, a lib module, a component, a static asset or a comment. None needs a migration, a payments or listings route, or `lib/route-auth.ts`. One defect found would need those to fix properly, and so is reported in 8.3 with no fix designed: a cancelled listing and an expired one are the same row.

### 8.1 `/api/guest/track`: courier identity out, `courierAssigned` in

**Today's response, exactly** (`route.ts:66-85`). 404 `{ found: false }`; 429 `{ error, reason: "rate_limited" }`; 500 `{ error: "Lookup failed" }`; 200:

| Field | Source |
| --- | --- |
| `found` | `true` |
| `job.kind` | `"guest"` |
| `job.trackingId` | `tracking_id` |
| `job.pickupArea`, `job.dropoffArea` | `pickup_area`, `dropoff_area` |
| `job.status` | `status` |
| `job.createdAt` | `created_at` |
| `job.assignedCourier` | `assigned_courier`: **a Pioneer's `pi_username`**, null on a legacy claim |
| `job.pickupConfirmedAt` | `pickup_confirmed_at` |
| `job.deliveryConfirmedAt`, `job.deliveryConfirmedBy` | `delivery_confirmed_at`, `delivery_confirmed_by` |
| `job.hasDeliveryCode` | `delivery_code_hash !== null`; the hash itself never leaves |

The select (`route.ts:53`) reads those columns plus `delivery_code_hash`. It does not read `assigned_courier_id`.

**Proposal.**

- Select `assigned_courier_id` beside `assigned_courier`. Both are read, and neither is emitted.
- Replace `assignedCourier` with `courierAssigned: boolean`, true when `assigned_courier` or `assigned_courier_id` is not null. That is the same both-columns rule the claim and the board use (6.1).
- The select stays a named column list. `tests/declared-value-exposure.test.ts:28` names this route and refuses a bare or star select.
- The header comment (`route.ts:8-11`) adds courier identity, by username or by id, to its "never expose" list.
- `lib/guest-jobs.ts:42`: `assignedCourier` leaves `GuestJobView`. `courierAssigned?: boolean` joins it, optional like `deliveryConfirmedBy` and `hasDeliveryCode` (`:45-50`), because a cached older payload will not carry it.

**Every consumer of the removed field:**

| Where | Use |
| --- | --- |
| `lib/guest-jobs.ts:42` | the `GuestJobView` type |
| `components/delivery-tracker.tsx:74-76` | the guest Accepted caption, the only reader |
| `tests/routes/guest.test.ts:224`, `tests/routes/limits.test.ts:213` | the column in a mocked row; no assertion reads it from the response |

`components/track-view.tsx` and `components/track-tab.tsx` pass the job to `DeliveryTracker` and read no courier field. `/api/guest/track` is pinet host only: the courier host refuses it (`lib/courier-host.ts:76`, `tests/courier-host.test.ts:95`). Nothing else in `app/`, `components/`, `lib/` or `scripts/` reads `assignedCourier`. The dispatch reader reads `assigned_courier` from the view, not from this route, and is unchanged.

**The visible change for Pioneer jobs, stated plainly.** Today anyone holding a tracking ID for a guest job taken by a Pioneer sees that Pioneer's Pi username on the tracker, as "@username · Pi Pioneer is carrying it". After this change **no username is shown on any guest job**, Pioneer or legacy. The sender, the recipient and anyone they share the link with can no longer see which Pioneer took the job. Nothing else on the guest tracker changes. The Pioneer's own My Activity card (`/api/guest/mine`) is untouched.

**What the tracker shows for each case:**

The flag decides the Accepted caption. That is its only use.

- `courierAssigned` true: "A courier is carrying it" (8.2, COPY DRAFT).
- `courierAssigned` false on an `accepted`, `in_transit` or `delivered` row: a hand-edited row (F14). A status-only caption, "Accepted" (COPY DRAFT), with no carrier claim. The row records no courier, so the tracker does not say there is one.
- `courierAssigned` absent (a cached payload): treated as unknown, with the same caption as false. The cost, stated plainly: until the page reloads, a stale bundle shows a real Pioneer or legacy job with the no-claim caption. That is the safe direction.

The Pioneer rail is not touched. Listing usernames come from the public `listings` read (`lib/listings-async.ts:188-204`, `posted_by_username`, `matched_with_username`), by design of the marketplace. Changing that is a listings question, outside item 8.

### 8.2 Tracker copy

Every string on the tracker surfaces that names or implies who carries, collected, or signed for a job. "Courier" is already the neutral word on the guest rail. The replacements are marked **COPY DRAFT**: founder review and the gyema-accuracy checklist before any ships.

| file:line | Rail | Text today | Problem | Proposed (COPY DRAFT) |
| --- | --- | --- | --- | --- |
| `delivery-tracker.tsx:75` | guest | "@{assignedCourier} · Pi Pioneer is carrying it" | names the Pioneer publicly (8.1) | "A courier is carrying it" |
| `delivery-tracker.tsx:76` | guest | "A Pi Pioneer is carrying it" | false for every legacy job (6.8, the go-live gate) | chosen by `courierAssigned` (8.1): "A courier is carrying it" when true, "Accepted" when false or absent |
| `delivery-tracker.tsx:77` | guest | "Waiting for a courier" | also shown for `pending_quote`, which is waiting for a price (8.3) | unchanged for `posted`; "Waiting for a price" for `pending_quote` |
| `delivery-tracker.tsx:66` | guest | "Phone-verified sender · {date}" | not about the carrier; listed because it is a trust claim. `phone_verified` is set by the operator after matching the sender's WhatsApp message, with no OTP (`route.ts:18-22`) | no change proposed; founder to confirm the wording against how the flag is set |
| `delivery-tracker.tsx:87` | guest | "Signed for in {dropoffArea}" | implies a recipient signature; no stamp records one. The row holds `delivery_confirmed_by` (sender, courier code, or both) | "Delivered in {dropoffArea}" |
| `delivery-tracker.tsx:32` | listing | "@{postedByUsername} · {date}" | names the poster; by marketplace design | no change proposed |
| `delivery-tracker.tsx:40` | listing | "@{matchedWithUsername} is carrying it" | **wrong party on a trip.** On a `trip` the poster is the traveller and the matched user is the sender (`listing-detail-sheet.tsx:61-70`), so this names the sender as the carrier | `package`: unchanged; `trip`: "@{postedByUsername} is carrying it" |
| `delivery-tracker.tsx:41` | listing | "Waiting for a traveller" | fine | unchanged |
| `delivery-tracker.tsx:38` | listing | "Match cancelled" | shown for every `expired` listing, including an open one the cron expired with no match (8.3) | "Closed before delivery" |
| `delivery-tracker.tsx:51` | listing | "Signed for in {toCity}" | as `:87` | "Delivered in {toCity}" |
| `track-view.tsx:185-187` | guest | "Give this code to whoever is receiving the package. The courier will ask for it at handover, and can only close this delivery once they have been told it in person." | neutral already | unchanged |
| `track-view.tsx:244` | guest | "You confirmed the courier collected this package." | neutral; true only when `pickup_confirmed_by` is `sender`, the only value written (`confirm-pickup/route.ts:88`) | unchanged |
| `track-view.tsx:252` | guest | "Courier collected your package?" | neutral | unchanged |
| `track-view.tsx:320-321`, `:333-335` | guest | the sender and courier-code sign-off lines | neutral; each is chosen from `deliveryConfirmedBy` | unchanged |
| `track-view.tsx:396` | guest | "You confirmed this delivery and the courier entered your delivery code at handover. …" | chosen from `hasDeliveryCode` alone, not the stamps (scope addition A) | from stamps: see below |
| `track-view.tsx:397` | guest | "You confirmed pickup and delivery. …" | chosen from `hasDeliveryCode` alone (A); a hand-closed row gets it too | from stamps: see below |
| `track-view.tsx:398` | listing | "Both sender and traveller confirmed this delivery as done. …" | `completed` is not proof that both flags are set (A) | from `senderConfirmed` and `travellerConfirmed`: see below |
| `track-tab.tsx:109` | both | "Both sender and traveller confirmed this delivery as done." | shown for guest jobs too (A, the report on a Mainnet guest job (ID held privately)); no traveller on the guest rail | same rule as `track-view.tsx:396-398` |
| `listing-detail-sheet.tsx:870` | listing | "Both sender and traveller confirmed this delivery as done." | as `:398` | same listing rule |

**The completion line, from the stamps on the row (scope addition A), COPY DRAFT.** One pure function per rail, shared by `track-view.tsx`, `track-tab.tsx` and `listing-detail-sheet.tsx`:

| Rail | Stamps on the row | Line |
| --- | --- | --- |
| guest | `deliveryConfirmedBy` = `sender+courier_code` | "You confirmed this delivery and the courier entered your delivery code at handover." |
| guest | `sender`, and pickup confirmed | "You confirmed pickup and delivery." |
| guest | `sender`, pickup not confirmed | "You confirmed delivery." |
| guest | `courier_code` only | "The courier entered your delivery code at handover." |
| guest | none | "This delivery is marked complete." (nothing about who confirmed) |
| listing | `senderConfirmed` and `travellerConfirmed` | "Both sender and traveller confirmed this delivery as done." |
| listing | either one, or neither | "This delivery is marked complete." |

"Thanks for moving things across Gyema the safer way." stays as the second sentence, also for founder review: "safer" is a comparative claim.

**One field to add for A.** "Pickup confirmed" today reads `pickupConfirmedAt` only. The track route does not return `pickup_confirmed_by`. The stamp-based line needs only the timestamp, since `sender` is the one value ever written, so **no field is added**. If the founder wants the rule keyed on the stamp itself, `pickupConfirmedBy` is the field to add, in the same select as 8.1. The listing rule needs nothing new: `sender_confirmed` and `traveller_confirmed` are already in `LISTING_COLUMNS` (`lib/listings-async.ts:124-125`).

### 8.3 Status chips

**Where a status is shown today.** Colours come from `components/ui/badge.tsx` and `app/globals.css`, the same in light and dark:

- `default`: gold fill `#F5B800`, indigo text `#1E1B4B`
- `secondary`: green fill `#15803D`, cream text `#FEF7E6`
- `outline`: no fill, a border, text in `--foreground` (indigo in light, cream in dark)

| Surface | Audience | How |
| --- | --- | --- |
| `listing-detail-sheet.tsx:508-521`, rendered `:542` | Pioneer | label map; the fallback is the raw value on `secondary` |
| `trips-tab.tsx:290` | Pioneer | **raw value**, `outline`; past rows muted (`opacity-70`) |
| `guest-courier-card.tsx:103` | Pioneer courier | **raw value**, `outline`; delivered, cancelled and expired muted (`:29`) |
| `app/courier/courier-jobs.tsx:60-66`, rendered `:242` | legacy courier | label map, plain text, no chip; the fallback is the raw value |
| `delivery-tracker.tsx:23-91` | anyone with the ID | not a chip: four stages, coloured done green `#15803D`, current gold `#F5B800`, cancelled vermillion `#DC2626`, upcoming grey |

**Guest statuses: the seven in `guest_jobs_status_check`.**

| Status | Tracker (stage, caption, colour) | Pioneer courier card | Legacy courier list | Mismatch |
| --- | --- | --- | --- | --- |
| `posted` | Accepted current, "Waiting for a courier", gold | not reached (mine lists assigned jobs) | not reached; would print `posted` | none on the tracker |
| `pending_quote` | **as `posted`**, "Waiting for a courier", gold | not reached | not reached; would print `pending_quote` | waiting for a price, not a courier; absent from `GuestJobStatus` (`lib/guest-jobs.ts:7-13`) |
| `accepted` | Accepted done, the Pioneer caption, green | `accepted`, outline | "Accepted, not picked up yet" | raw on the card |
| `in_transit` | In transit current, gold | **`in_transit`**, outline | "On the way" | raw on the card (scope addition B) |
| `delivered` | Delivered done, "Signed for in …", green | `delivered`, outline, muted | "Delivered" | raw on the card |
| `cancelled` | Accepted cancelled, "Cancelled", vermillion | `cancelled`, outline, muted | "Cancelled" | raw on the card |
| `expired` | **Accepted cancelled, "Cancelled", vermillion** (`delivery-tracker.tsx:59`, `:72`) | `expired`, outline, muted | "Expired" | **an expired guest job is shown as Cancelled** on the tracker |

**Listing statuses: the five observed** (`open`, `matched`, `in_transit`, `completed`, `expired`).

| Status | Writers | Sheet chip | Trips tab | Tracker | Mismatch |
| --- | --- | --- | --- | --- | --- |
| `open` | create, release | "Open", **green** `secondary` | `open`, outline | Accepted current, "Waiting for a traveller", gold | green means done on the tracker, waiting here |
| `matched` | accept | "Matched", gold | `matched` | Accepted done, "@… is carrying it" (wrong party on trips, 8.2) | raw on the tab |
| `in_transit` | mark-in-transit | "In transit", gold | **`in_transit`** | In transit current, gold | raw on the tab (B) |
| `completed` | `listing_confirm_completion` (2026-08-14, called by the confirm-completion route); the authenticated role can also write it directly (scope addition A) | "Completed", **gold** | `completed`, muted | Delivered done, green | done shares gold with in-progress on the sheet |
| `expired` | **cancel-open, cancel-matched and the cron**, all three | **"Expired"**, outline | `expired`, muted | **"Match cancelled"**, vermillion | see below |

**The listing `expired` defect: reported, no fix designed.** `cancel-open` (`route.ts:52`), `cancel-matched` (`route.ts:51`) and the cron (`expire-stale-listings/route.ts:59`, `:72`) all write `expired`. So:

- a Pioneer who cancels their own listing sees "Expired" on the sheet
- a listing the cron aged out without ever being matched reads "Match cancelled" on the tracker

The row records nothing that tells the three apart. A label that tells them apart needs a new status value or a reason column (a migration), and the three writers changed (listings routes). **That is outside item 8 under the stop rule, so it is reported here, not designed.** What item 8 can do is stop either label from claiming more than the row holds: one neutral label for `expired` on every surface.

**A contradiction to settle by catalog read, not by either source.** `lib/listings.ts:26-27` says "Aligned with the DB CHECK constraint: `listings_status_check` allows exactly these 5 values." CLAUDE.md says `listings.status` has "no enum, no CHECK". No migration in the repository creates one. This is the same shape as the `guest_jobs_status_check` found on 11 Oct (Status checks (c)). Read-only founder query, per network:

```
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.listings'::regclass and contype = 'c';
```

Whichever source is wrong gets corrected in its own commit. The chip map does not depend on the answer.

**Proposed: one label map per rail, in one place, COPY DRAFT.** `lib/status-labels.ts`: pure, no imports, so the courier page can import it without the Pi client. It exports `guestStatusChip(status)` and `listingStatusChip(status)`, each returning `{ label, tone }`, and one `tone` to Badge variant map:

| Tone | Variant | Meaning |
| --- | --- | --- |
| `waiting` | `outline` | nothing has happened yet |
| `active` | `default` (gold) | under way |
| `done` | `secondary` (green) | finished, matching the tracker's green |
| `stopped` | `outline`, muted text | ended without delivery |
| `unknown` | `outline`, muted text | a value the map does not know |

| Rail | Status | Label (COPY DRAFT) | Tone |
| --- | --- | --- | --- |
| guest | `posted` | "Waiting for a courier" | waiting |
| guest | `pending_quote` | "Waiting for a price" | waiting |
| guest | `accepted` | "Courier assigned" | active |
| guest | `in_transit` | "On the way" | active |
| guest | `delivered` | "Delivered" | done |
| guest | `cancelled` | "Cancelled" | stopped |
| guest | `expired` | "Expired" | stopped |
| listing | `open` | "Open" | waiting |
| listing | `matched` | "Matched" | active |
| listing | `in_transit` | "In transit" | active |
| listing | `completed` | "Completed" | done |
| listing | `expired` | "Closed" (the row cannot tell cancelled from expired) | stopped |
| either | anything else | "Status unavailable", never the raw string | unknown |

**Consumers:**

- `listing-detail-sheet.tsx:508-521` and `trips-tab.tsx:290` use `listingStatusChip`.
- `guest-courier-card.tsx:103` and `courier-jobs.tsx:60-66` use `guestStatusChip`. The legacy list keeps plain text; it takes the label only.
- The tracker keeps its four stages and takes its `expired` and `pending_quote` captions from 8.2. On the guest tracker `expired` is separated from `cancelled`: the stage still shows vermillion, captioned "Expired".
- `GuestJobStatus` gains `pending_quote`.

Changing the sheet's `open` from green to `outline` and `completed` from gold to green is a visible change for every Pioneer. It is listed so the founder can refuse the colour part and keep only the labels.

### 8.4 Site title and favicon

From code, not observed live. No request was made to either network.

| | Pinet host (both networks) | Courier host (both networks) |
| --- | --- | --- |
| Title | "Gyema [em-dash] P2P Delivery on Pi" (the dash written out here, per the copy rule) (`app/layout.tsx:13`) for `/`, `/send`, `/track`, `/track/[id]` | "Gyema couriers" (`app/courier/page.tsx:19`) for `/`, which is rewritten to `/courier` |
| Description | "Gyema connects routine travellers with senders needing packages delivered. Decentralized P2P delivery powered by Pi Network." (`:14-15`) | the same root description, inherited: it tells a courier with no Pi account about Pi Network |
| Other paths | Next pages as usual | middleware's plain-text 404 for every refused path (`middleware.ts:115-116`) |
| `themeColor` | `#7B2CBF` (`:53`), a purple that is not in the palette (`globals.css`: indigo, gold, green, vermillion, cream) | the same |
| Icons | **none emitted** | **none emitted** |

**Why `/favicon.ico` is a 404 on both hosts:**

- No `app/favicon.ico`, no `app/icon.*`, no `app/apple-icon.*`, and no `metadata.icons`. So no `<link rel="icon">` is emitted, and browsers fall back to requesting `/favicon.ico`.
- No `public/favicon.ico` exists.
- The middleware matcher excludes `favicon.ico` (`middleware.ts:125`), so the request never reaches the surface split. It is Next's own 404 on both hosts, not the courier host's refusal.

**The files that are in `public/` must not be wired up.** `apple-icon.png` (180×180), `icon-light-32x32.png`, `icon-dark-32x32.png` and `icon.svg` are the v0 template's mark, not Gyema's. Nothing references them today (they are in `public/`, which Next's icon file convention does not read). Linking them would put another product's logo on Gyema's tab (the spirit of invariant 6). `placeholder-logo.*`, `placeholder.*` and `placeholder-user.jpg` are also referenced nowhere. Only `gyema-hand.png` is used (`components/sign-in.tsx:48`).

**What is needed:**

1. **An asset from the founder.** A Gyema mark as a square source, at least 180×180, from which the files are cut: `favicon.ico` (16 and 32), a 180×180 `apple-icon.png`, and optionally `icon.svg`. This is a founder deliverable. No asset is drawn by an agent.
2. Place them under `app/` (`app/favicon.ico`, `app/icon.png` or `app/icon.svg`, `app/apple-icon.png`), so Next emits the links on every page of both surfaces with no metadata code. `/favicon.ico` is already outside middleware. The hashed `/icon*.png` and `/apple-icon*.png` URLs match the matcher's `.*\.png$` exclusion. Both CSPs allow `img-src 'self'` (`lib/csp.ts:184`, `:234`). Nothing else changes.
3. Remove the v0 files from `public/` in the same part, so no later edit links them by accident. `middleware.ts:125` names `icon.svg` and `apple-icon.png` and can stay as it is.
4. **Title and description, COPY DRAFT:**
   - root title: "Gyema: peer to peer delivery on Pi" (the current one carries an em-dash, against CLAUDE.md's copy rule)
   - the courier page gets its own description, so it no longer inherits the Pi one: "Sign in to see and take Gyema delivery jobs."
   - whether `themeColor` moves to a palette colour is the founder's call

The three static pages carry an em-dash in their `<title>` too: `public/methodology.html:6`, `privacy.html:6`, `terms.html:6`. They are listed here, not changed. `methodology.html` is a carbon page; invariant 5 governs its content, and it is not reviewed in this item.

### 8.5 Copy inventory

Every user-visible string marked COPY DRAFT, plus the Pioneer test banner, which the brief names but which is not marked. Not rewritten here; the founder reviews copy separately. `{x}` is an interpolated value. Audience: S sender, R recipient, C legacy courier, P Pioneer (including a Pioneer acting as a courier).

**`app/courier/page.tsx`** (C)

| Line | Text |
| --- | --- |
| 19 | title "Gyema couriers" |
| 26 | heading "Gyema couriers" |

**`app/courier/courier-panel.tsx`** (C)

| Line | Text |
| --- | --- |
| 50-53 | account labels "Registered", "Buffer", "Full", "Paused" |
| 57-62 | verification labels "Started, not submitted", "In progress", "Waiting for the result", "Approved", "Not approved", "Could not be completed" |
| 66-67 | "That code did not work. Check it and try again, or ask for a new one." (`invalid_code`, `no_match`) |
| 68 | "That code has expired. Ask for a new one." |
| 69 | "This courier account cannot sign in." |
| 70-71 | "Too many attempts. Try again in a few minutes." (`rate_limited`, `limiter_unavailable`) |
| 74 | "Something went wrong. Try again in a few minutes." (fallback) |
| 77 | "We could not start verification just now. Try again in a few minutes." |
| 78 | "Verification is paused for this account. Contact Gyema." |
| 79 | "This courier account cannot start verification." |
| 80 | "Too many attempts today. Try again tomorrow." |
| 81 | "We could not start verification just now. Try again in a few minutes." (`limiter_unavailable`) |
| 226 | "Loading..." |
| 232 | "We could not check your sign-in just now." |
| 241 | button "Try again" |
| 251 | label "Enter the sign-in code Gyema sent you" |
| 263 | placeholder "XXXXX-XXXXX" |
| 272 | button "Signing in..." / "Sign in" |
| 286 | "Not started" (verification) |
| 291 | "Your courier reference: {reference}" |
| 294, 296 | "Account", "Verification" |
| 301 | "Your verification has been submitted. We are waiting for the result. This page checks again every minute." |
| 311 | button "Opening..." / "Continue verification" / "Start verification" |
| 320 | button "Sign out" |
| 329 | "Your verification has taken longer than 30 days. Jobs are paused until it completes." (not accurate for a buffer row with a null `buffer_since`, 6.13) |

Flag, not rewritten: `:51-52` show a courier the ladder's internal words, "Buffer" and "Full".

**`app/courier/courier-jobs.tsx`** (C)

| Line | Text |
| --- | --- |
| 61-65 | job labels "Accepted, not picked up yet", "On the way", "Delivered", "Cancelled", "Expired" |
| 69 | "Someone else took this job, or it is no longer open." (`not_open`) |
| 70 | "Your account cannot take this job yet." (`not_eligible`, 8.6) |
| 71 | "Your account cannot take jobs yet." (`courier_not_active`) |
| 72-73 | "This courier account cannot take jobs. Contact Gyema." (`courier_not_registered`, `unavailable`) |
| 74 | "Too many attempts. Try again in a few minutes." |
| 75 | "We could not take that job just now. Try again in a few minutes." |
| 79 | "Enter the 4 digits the recipient gave you." |
| 80 | "Too many wrong codes for this delivery. Contact Gyema." |
| 81-82 | "This delivery cannot be confirmed now." (`not_confirmable`, `state_changed`) |
| 83 | "This delivery is not assigned to you." |
| 84 | "This delivery has no code to enter." |
| 85 | "Too many attempts. Try again in a few minutes." |
| 88 | "Something went wrong. Try again in a few minutes." (fallback) |
| 91 | "?" for a missing figure, "{n} GHS" otherwise |
| 95-96 | " (MoMo)", " (cash)" |
| 167 | "You took {trackingId}. It is in your jobs below." |
| 194 | "Code accepted. The delivery is complete." |
| 195 | "Code accepted. Waiting for the sender to confirm." |
| 201 | "That code did not match. {n} try/tries left." |
| 219 | "We could not load your jobs just now." |
| 221 | button "Try again" |
| 228 | "Loading jobs..." |
| 234 | heading "Your jobs" |
| 235 | "You have no jobs yet." |
| 244, 248, 252 | "From:", "To:", "Package:" |
| 256, 261 | "Recipient:", "Recipient phone:" |
| 265 | "Collect at the door: {quote}{payment}" |
| 271, 274 | "You keep: {n}", "You owe Gyema: {n}" |
| 278 | "Delivery code accepted." |
| 288 | label "Enter the code the recipient gives you" |
| 297 | placeholder "0000" |
| 305 | button "Checking..." / "Confirm delivery" |
| 320 | heading "Open jobs" |
| 321 | "You can take jobs once your account is active." |
| 323 | "No open jobs right now." |
| 329 | "{pickupArea} to {dropoffArea}" |
| 335 | "You keep {n}" |
| 342 | button "Taking..." / "Take this job" |
| 357 | button "Refresh" |

**`app/send/page.tsx`**, declared value, item 7 (S; the WhatsApp line is read by the operator)

| Line | Text |
| --- | --- |
| 54 | "During the pilot we can only carry packages worth up to GHS {cap}." (`declared_value_over_cap`) |
| 58 | "Enter the package value in whole cedis, from 0 to {cap}. If this keeps happening, reload the page." (`invalid_declared_value`) |
| 191 | WhatsApp fallback line "Value: GHS {n}", or "Value: not given" |
| 331 | label "Value of the package (GHS)" |
| 335 | placeholder "e.g. 150" |
| 342 | "During the pilot we can only carry packages worth up to GHS {cap}." (over the cap, in the field) |
| 346-347 | "Required. During the pilot we carry packages worth up to GHS {cap}. Your courier does not see this." |
| 397 | "Declared value: GHS {n}" (quote step) |

`{cap}` is `DECLARED_VALUE_CAP_CEDIS`, 500, which traces to answer 6 (7.3).

**The test-environment banners** (Testnet only, `NEXT_PUBLIC_IS_TESTNET` exactly `"true"`)

| file:line | Audience | Text | Marked |
| --- | --- | --- | --- |
| `components/courier-test-banner.tsx:21` | C | "Test environment. Deliveries here are not real." | COPY DRAFT |
| `components/testnet-banner.tsx:24-25` | S, R, P | "Test environment. Deliveries posted here are not real. The live app is gyema8841.pinet.com, open it in Pi Browser." | not marked; live since #34 |

**The tracker drafts** are in 8.2, the chip labels in 8.3, the title and description in 8.4.

**A missing string, not a draft.** 6.7 A, step 2, promised the Pioneer UI a "contact Gyema to register as a courier" line (COPY DRAFT, item 8). It does not exist. `acceptGuestJobAsync` (`lib/guest-jobs.ts:300-303`) drops the refusal reason and returns null. `guest-job-sheet.tsx:106` then shows every refusal as "This job is no longer available. Another courier may have taken it." So an unregistered Pioneer (`courier_not_registered`) or a paused one (`courier_not_active`) is told, falsely, that the job may have been taken. Nothing in `components/` reads either reason. The fix:

- `acceptGuestJobAsync` returns the reason
- the sheet maps `courier_not_registered` to the promised line, and `courier_not_active` to a paused line (both COPY DRAFT)
- the existing line stays for `not_open`

The Pioneer accept is a buffer courier's route too, so `not_eligible` needs a line there only if a Pioneer row is ever `buffer`. Today none can be: decision A registers every Pioneer `full`.

### 8.6 The `not_eligible` signal (6.10 decision 4, 6.12 choice 1)

**What leaks.** A buffer courier refused `not_eligible` on a job whose areas are both on the list learns that its declared value is over GHS 200 or was never declared. One bit, per job they try. The legacy accept limit (30 per 10 minutes, failing closed) bounds the probing. Nothing about the attempt is recorded.

**Where the bit comes from.** Eligibility for a buffer courier depends on the value. So any outcome a courier can observe that differs by eligibility carries the bit: a reason, a missing job, or a job that stays on the board after a refusal. The options differ in how directly they say it, and in what else they cost.

| Option | What changes | The bit | Cost |
| --- | --- | --- | --- |
| **K. Keep** (today) | nothing | stated directly, at once | none; one extra read for a buffer courier (6.12 choice 1) |
| **R1. Collapse into `not_open`** | the buffer pre-read goes; a refused buffer claim answers `not_open` | still there: the job stays on the board after refresh, so "taken" is visibly untrue | `courier-jobs.tsx:69` says "Someone else took this job", which would be false; that line would have to become neutral for every courier, losing a true message for full couriers. The accuracy checklist weighs against telling a courier something untrue |
| **R2. One generic refusal for every buffer outcome** | buffer couriers get one reason for `not_open` and `not_eligible` alike | delayed, not removed (as R1) | a buffer courier can no longer tell "taken" from "not for you"; full couriers unchanged |
| **H. Hide over-cap jobs from a buffer courier's board** | a courier-only board route applying `bufferJobGuards` in its query | by absence: a listed-area job missing from the board is over the cap or unset. The same bit, said less directly | a new route under `/api/courier/jobs/`. `/api/guest/open` is public and cannot import a courier resolver (`tests/routes/identity-separation.test.ts`). It also moves board filtering from display (`app/courier/courier-view.ts`) to the server. The value is still never returned, and the exposure test's filter exception covers the guard |
| **H+K. Both** | H, and keep `not_eligible` for the race where a job changes between board and accept | by absence, plus rarely by reason | H's cost |

Any change to either accept route is an `ATTESTATION WRITE: founder review required` edit. **No decision is taken here.**

### 8.7 The stale comment at `lib/guest-pricing.ts:78`

`:78-82` reads: "Pioneer-rail advisory benchmark. Maps the coarse GHANA_CITIES vocabulary onto zone SETS … "Accra" spans zones A to C; "Tema" is the D corridor." It is stale in two ways:

- **`GHANA_CITIES` is the wrong name.** It is the coordinate table in `lib/carbon.ts:41`, a different vocabulary, and `guest-pricing.ts` does not use it.
- **The forms stopped offering a coarse vocabulary at `2cfcdb5`** (26 Jul 2026). Both Pioneer forms select from `TRIP_AREAS`, which is `GUEST_AREA_NAMES` plus "Other" (`components/home-tab.tsx:44`). `CorridorBenchmark` (`:55-56`) passes the select state to `pioneerBenchmarkCedis`, and "Other" resolves to null. So the "Accra" and "Tema" fallback in `CITY_ZONE_SETS` cannot be reached from the forms. Only `tests/pioneer-offer-units.test.ts:27` and `:51` reach it.

**Proposed, comment only:** say that the city fallback serves only the values "Accra" and "Tema", that no form offers them since `2cfcdb5`, and that the exact cell is the live path. **Removing `CITY_ZONE_SETS` and `quoteCedisRangeForCities` is a separate decision.** It changes `pioneerBenchmarkCedis` and its tests, and does nothing for item 8.

Also stale, at `:1`: "four zones". The file defines five, A to E (`:6`, `:43-45`). Same comment-only fix.

### 8.8 Build plan

One part at a time, stopping after each for review, as in item 6. **(a) is first, and is the gate:** 6.13 ties the item 6 deploy on every network to it.

**(a) The gate: `/api/guest/track` and the guest tracker caption.**

- Files: `app/api/guest/track/route.ts` (8.1), `lib/guest-jobs.ts` (the type), `components/delivery-tracker.tsx:74-77` (the guest captions, once the founder approves them).
- Tests, in `tests/routes/guest.test.ts`:
  - a Pioneer row: the response text does not contain the fixture username, no `assignedCourier` key, `courierAssigned` true
  - a legacy row (`assigned_courier` null, id set): `courierAssigned` true
  - both columns null: `courierAssigned` false
  - through a pure caption export from `delivery-tracker.tsx`: an `accepted` row with `courierAssigned` false, and one with it absent, carry no carrier claim; true gives the carrying caption
  - the select names `assigned_courier_id`
  - the existing sanitised-payload test unchanged
- Static pin, the `tests/courier-view.test.ts` pattern (`readFileSync`, then `not.toMatch`): `delivery-tracker.tsx` contains no "Pioneer" and reads no `assignedCourier`; `lib/guest-jobs.ts` declares no `assignedCourier`.
- Mutation checks: emitting `assigned_courier` again, and `courierAssigned` computed from one column only, each fail a test.

**(b) Status chips.**

- Files: `lib/status-labels.ts` (new, pure), `listing-detail-sheet.tsx:508-521`, `trips-tab.tsx:290`, `guest-courier-card.tsx:103`, `app/courier/courier-jobs.tsx:60-66`, `GuestJobStatus` gaining `pending_quote`, and the tracker's guest `expired` and `pending_quote` captions.
- Tests, `tests/status-labels.test.ts`: every one of the seven guest values and five listing values maps to a label and a tone; unknown, empty and null give "Status unavailable", never the input; no label contains an underscore.
- Static pins: none of the four sites renders `{job.status}` or `{listing.status}` as text; `courier-jobs.tsx` keeps no label map of its own; `lib/status-labels.ts` imports nothing (so the courier page may use it, `tests/courier-host.test.ts`).
- If the founder refuses the colour change, the tone column goes and the variants stay as today.

**(c) Completion lines from stamps (scope addition A).**

- Files: one pure function per rail, used by `track-view.tsx:390-401`, `track-tab.tsx:103-113` and `listing-detail-sheet.tsx:863-874`.
- Tests: every row of the 8.2 table; a `completed` listing with one flag set never says "Both"; a `delivered` guest row with no stamps says nothing about who confirmed; `track-tab.tsx` never prints the listing line for a guest result.
- Kept apart from (a) on purpose, so the gate part stays small. It needs no route change unless the founder wants `pickupConfirmedBy` (8.2); in that case that one field folds into (a).

**(d) Listing tracker captions** (`delivery-tracker.tsx:38`, `:40`, `:51`, `:87`).

- The trip-kind carrier fix and the neutral `expired` caption. Its own part, because it changes a Pioneer surface and not the gate.
- Tests: through a pure stage-derivation export. A `trip` listing names `postedByUsername` as the carrier; a `package` listing names `matchedWithUsername`; `expired` never says "Match".

**(e) Title and icons** (8.4).

- Files: `app/favicon.ico`, `app/icon.*`, `app/apple-icon.png` from the founder's asset; the v0 files removed from `public/`; `app/layout.tsx` title (and `themeColor`, if decided); `app/courier/page.tsx` description.
- Tests: the three files exist under `app/`; none of the v0 files remains in `public/`; the root title contains no em-dash; the courier page's metadata has its own description.
- Browser check per host after deploy: the tab icon shows, and `/favicon.ico` answers 200. Pi Browser caches hard: close fully and reopen.

**(f) Approved copy.** Every COPY DRAFT string the founder approves in 8.2 to 8.5, and the missing Pioneer refusal lines (8.5): `acceptGuestJobAsync` returning the reason, and the sheet mapping it. Tests: the sheet's message per reason, and `not_open` keeping its line. The gyema-accuracy checklist before it ships.

**(g) `lib/guest-pricing.ts` comments** (8.7). Comment only; no test.

**Mirror impact.** The scan (`pinet\.com|Testnet|testnet|8841|3681`) over every file the parts touch:

| File | Hits | Mirror |
| --- | --- | --- |
| `components/listing-detail-sheet.tsx` | 4 | hand-applied (the known network file) |
| `app/layout.tsx` | 5 (`.pinet.com` in the Pi init, comments, the banner import) | hand-applied |
| `components/testnet-banner.tsx` | 5 | hand-applied, only if its copy changes in (f); it names this network's live host |
| `app/send/page.tsx` | 1 (the pinet link at `:209`) | hand-applied, only if (f) touches it |
| `app/api/guest/track/route.ts`, `lib/guest-jobs.ts`, `components/delivery-tracker.tsx`, `track-view.tsx`, `track-tab.tsx`, `guest-courier-card.tsx`, `guest-job-sheet.tsx`, `trips-tab.tsx`, `app/courier/*`, `courier-test-banner.tsx`, `lib/guest-pricing.ts`, `lib/status-labels.ts` (new), the new and changed tests | 0 | bytes |
| the icon files | binary, 0 | bytes; the same mark on both networks unless the founder wants a Testnet variant |

These notes are scanned at mirror time as usual.

### 8.9 Open decisions for the founder

1. **The listing `expired` conflation (8.3).** Cancelled and expired listings are one value, written by three writers. Reported only: telling them apart needs a migration and listings route changes, outside item 8. Item 8 proposes the neutral "Closed". Is that accepted, and is the real fix queued as its own item?
2. **`listings_status_check`.** `lib/listings.ts:27` says it exists; CLAUDE.md says no CHECK. The read-only catalog query in 8.3, per network, settles it.
3. **The chip colours (8.3).** Labels and tones as proposed, or labels only, keeping today's variants.
4. **Scope addition A's pickup field (8.2).** Key the line on `pickupConfirmedAt` (no route change), or add `pickupConfirmedBy` to the track route in part (a).
5. **`not_eligible` (8.6):** K, R1, R2, H or H+K.
6. **The icon asset and the title (8.4):** the source mark; the title and courier description drafts; whether `themeColor` changes; whether Testnet gets a distinct icon.
7. **The listing tracker captions (8.2, part (d)):** the trip-kind carrier fix as its own part, as proposed.
8. **The city fallback (8.7):** comment only, as proposed, or a later removal.
9. **"Phone-verified sender" and "the safer way" (8.2):** keep or reword. Both are trust claims on public surfaces. "Phone-verified sender" appears at four sites (`delivery-tracker.tsx:66`, `guest-courier-card.tsx:100`, `guest-job-sheet.tsx:46` and `:134`), so a rewording touches all four.
10. **The order of parts:** (a) alone, then (b) to (g), or (a) with (c) folded in.

All ten are answered in 8.10.

### 8.10 Founder decisions, 11 Oct 2026

Item 8 approved as designed, with these answers to 8.9. They win over anything earlier in this section.

1. **Listing `expired`: the neutral "Closed" now** (8.3), on every surface. The real fix, a reason column and its migration, is queued as its own item after Phase 1.
2. **Listings constraints, read by the founder (read only), 11 Oct 2026. The networks have drifted.**
   - **Testnet** has `listings_status_check` (`open`, `expired`, `matched`, `in_transit`, `completed`), `listings_kind_check`, `listings_size_check` and `listings_capacity_check`.
   - **Mainnet** has no check constraints on `listings`.
   - So `lib/listings.ts:26-27` is right for Testnet only, and CLAUDE.md's "no enum, no CHECK" is right for Mainnet only. CLAUDE.md is founder-only; its correction is batched for the end of Phase 1.
   - A later migration brings the four checks to Mainnet, after a read of Mainnet's live values. No repository file records any of the four (there is no schema baseline). The chip map does not depend on either network's answer.
3. **Chip labels and colours as proposed** (8.3): `lib/status-labels.ts`, the five tones and their variants.
4. **The completion line is keyed on `pickupConfirmedAt`** (8.2). No field is added to the track route.
5. **`not_eligible`: K, keep** (8.6). The one-bit signal stands. Revisit at scale.
6. **Icons:** the founder supplies a Gyema mark. The same icon ships on both networks. The title wording is decided in the copy review (8.4).
7. **The listing tracker captions are part (d),** built right after (a).
8. **`lib/guest-pricing.ts`: comment-only fix** (8.7), at `:1` and `:78-82`. Removing the dead city fallback comes later.
9. **"Phone-verified sender" and "the safer way"** are decided in the copy review.
10. **Order of parts: (a), (d), (b), (c), (e), (f), (g).**

**Change to part (a).** The Pioneer refusal mapping moves from (f) into (a), because it must ship with item 6. `acceptGuestJobAsync` (`lib/guest-jobs.ts`) returns the refusal reason. `components/guest-job-sheet.tsx` maps `courier_not_registered` and `courier_not_active` to their own lines (COPY DRAFT), and `not_open` keeps "This job is no longer available. Another courier may have taken it." So (a) is now:

- the track route, `GuestJobView` and the guest captions (8.1)
- the Pioneer refusal mapping
- the tests from 8.8 (a), plus: the sheet's message for each of the three reasons, and a reason that is not mapped keeping the `not_open` line

Every file in the new (a) names no network, so it mirrors as bytes (`lib/guest-jobs.ts` and `components/guest-job-sheet.tsx` both scan clean). Part (f) keeps the rest of the approved copy.

**The gate (6.13) is now part (a) as amended.** On every network the item 6 code deploys only together with it.

### 8.11 Part (a) built, 11 Oct 2026

Built on `feat/anchoring-phase1` from `3d514a7`, code and tests in `a3a353f`. Not pushed, not merged, not deployed. No SQL, no migration, no env var.

**Files** (lines added and removed, from `git show --numstat`):

| File | + / - | Change |
| --- | --- | --- |
| `app/api/guest/track/route.ts` | 12 / 3 | selects `assigned_courier` and `assigned_courier_id`, emits neither; `courierAssigned` is `assigned_courier != null \|\| assigned_courier_id != null`; header comment adds courier identity to the never-expose list |
| `lib/guest-jobs.ts` | 39 / 6 | `assignedCourier` leaves `GuestJobView`, `courierAssigned?: boolean` joins it; `guestAcceptedCaption` and its two strings; `acceptGuestJobAsync` returns `GuestAcceptResult`, `{ ok: true, job }` or `{ ok: false, reason }`, reason null on no session, a network failure, or a body naming none |
| `components/delivery-tracker.tsx` | 2 / 8 | the guest Accepted caption is `guestAcceptedCaption(j)` |
| `components/guest-job-sheet.tsx` | 4 / 3 | refusals go through `acceptRefusalMessage(result.reason)`; success reads `result.job` |
| `lib/guest-accept-message.ts` (new) | 27 / 0 | the pure refusal mapping, imports nothing |
| `tests/routes/guest.test.ts` | 83 / 0 | the track route cases |
| `tests/delivery-tracker-caption.test.ts` (new) | 71 / 0 | the caption cases and static pins |
| `tests/guest-accept-message.test.ts` (new) | 159 / 0 | the mapping, `acceptGuestJobAsync`, static pins |

**Tests: 961 before, 995 after** (47 files to 49). The track route cases cover:
- a Pioneer row with both columns set
- a pre-item-6 Pioneer row (`assigned_courier` set, `assigned_courier_id` null)
- a legacy row (`assigned_courier` null, id set)
- both null giving false

Each checks that neither the username nor the id appears in the response text, and that no courier key is present. Also covered: the select naming both columns, with no bare or star select; a source pin that the route emits no courier field; and the existing sanitised-payload test, unchanged.

The caption cases cover `accepted`, `in_transit` and `delivered`, each with `courierAssigned` true, false and absent. Static pins: `delivery-tracker.tsx` says no "Pioneer", reads no `assignedCourier`, and takes the caption from `guestAcceptedCaption`; `lib/guest-jobs.ts` declares no `assignedCourier`.

The mapping cases cover `courier_not_registered`, `courier_not_active`, `not_open`, an unknown string, null and undefined. `acceptGuestJobAsync` has five cases:
- a 403 refusal passes the reason through
- a 200 `not_open` passes it through
- a network failure gives a null reason
- no session gives a null reason and sends nothing
- success maps the job exactly as before

`tsc --noEmit` is clean, and so is `npm run security` (gitleaks, the audit gate, tsc).

**Mutation checks.** Each was applied, seen to fail, and restored. The restore was checked by blob hash against the pre-mutation file, then by `git status` and `git diff` being clean.

| Mutation | Caught by |
| --- | --- |
| the route emits `assignedCourier: data.assigned_courier` again | 5 tests: the four `courierAssigned` row cases (username or key in the response) and "pins in source that the route emits no courier field" |
| `courierAssigned` from `assigned_courier` only | "is true on a legacy row (assigned_courier null, assigned_courier_id set), with no id" |
| `courierAssigned` from `assigned_courier_id` only | "is true on a Pioneer row claimed before item 6 (assigned_courier set, assigned_courier_id null), with no username" |
| `courier_not_registered` mapped to the generic line | "tells an unregistered Pioneer to contact Gyema to register" |

**The COPY DRAFT strings, exactly:**
- `GUEST_CARRYING_CAPTION` (`lib/guest-tracker-caption.ts`): "A courier is carrying it"
- `GUEST_ACCEPTED_CAPTION` (`lib/guest-tracker-caption.ts`): "Accepted"
- `ACCEPT_NOT_REGISTERED_MESSAGE` (`lib/guest-accept-message.ts`): "To take guest deliveries, contact Gyema to register as a courier."
- `ACCEPT_NOT_ACTIVE_MESSAGE` (`lib/guest-accept-message.ts`): "Your courier account is paused, so it cannot take jobs right now. Contact Gyema."

The `not_open` line is unchanged and not a draft: "This job is no longer available. Another courier may have taken it."

**Deviations from 8.8 (a).**
- **The caption export.** 8.8 (a) put `guestAcceptedCaption` in `delivery-tracker.tsx`. It lives instead in a pure module, `lib/guest-tracker-caption.ts`, with `GUEST_CARRYING_CAPTION` and `GUEST_ACCEPTED_CAPTION`. Its only import is the type-only one of `GuestJobView`, the same pattern as `lib/guest-accept-message.ts`. The component imports it. (In `a3a353f` the three sat in `lib/guest-jobs.ts`; the follow-up below moved them.) The test runner cannot load `.tsx`: `tsconfig.json` sets `jsx: preserve`, `vitest.config.ts` adds no JSX transform, and no test before this one imported a component. A first attempt failed in `vite:import-analysis` on the JSX. Changing the vitest config was outside this part's files.
- **Where the caption tests live.** 8.8 (a) put them in `tests/routes/guest.test.ts`; they are in `tests/delivery-tracker-caption.test.ts` instead, with the static pins. The route tests are in `tests/routes/guest.test.ts`, as planned.
- **Consequence for part (d).** Its "pure stage-derivation export" (8.8 (d)) meets the same runner limit. It should follow the same pattern: a pure `.ts` module with no runtime import, imported by `delivery-tracker.tsx`, and tested directly with no `vi.mock`.
- **The paused line is broader than its wording.** `courier_not_active` is also the ladder's reason for a `registered` row, and for a buffer row that has lapsed or has no `buffer_since` (`lib/courier-ladder.ts:50-57`). There, "paused" is not literally true. No Pioneer row reaches those states today (decision A registers every Pioneer `full`), so the line is accurate for every Pioneer now. It is flagged for the copy review.

**Follow-up, `e481e6d`: the caption moves to a pure module.** Part (a) was reviewed and accepted, with this one follow-up. No behaviour change: same strings, same cases.

| File | + / - | Change |
| --- | --- | --- |
| `lib/guest-tracker-caption.ts` (new) | 25 / 0 | the two caption strings and `guestAcceptedCaption`; a type-only import of `GuestJobView` |
| `lib/guest-jobs.ts` | 0 / 21 | the three removed |
| `components/delivery-tracker.tsx` | 2 / 1 | imports the caption from the new module |
| `tests/delivery-tracker-caption.test.ts` | 23 / 9 | imports the new module directly, with no `vi.mock` |

Three static pins are added: the tracker imports the caption from `lib/guest-tracker-caption`; that module has no runtime import; and `lib/guest-jobs.ts` no longer defines the caption. The pin that `lib/guest-jobs.ts` declares no `assignedCourier` is kept.

**Tests: 995 to 998.** `tsc` and `npm run security` are clean.

**Mutation check.** `courierAssigned` was ignored, so `guestAcceptedCaption` always returned "Accepted". Three tests caught it: "gives the carrying caption on accepted / in_transit / delivered with courierAssigned true". Restored, and the hash matches the pre-mutation blob, `c0231e4`, which is also the committed blob.

**Mirror.** All nine files scan clean for `pinet\.com|Testnet|testnet|8841|3681`, so they mirror as bytes. These notes are scanned at mirror time as usual.

### 8.12 Part (d) built, 11 Oct 2026

Built on `feat/anchoring-phase1` from `f895d90`, code and tests in `ff69e0e`. Not pushed, not merged, not deployed. No SQL, no migration, no env var.

**Founder decisions, 11 Oct 2026, taken while building:**
1. **An expired listing reads "Closed" on the tracker** (COPY DRAFT). This follows 8.10 decision 1 ("on every surface"), which wins over 8.2's "Closed before delivery". "before delivery" is left off because the row does not record whether a handover happened.
2. **The open trip caption is fixed in this part.** On an open `trip` listing the poster is the traveller, so the Accepted caption reads "Waiting for a sender" (COPY DRAFT). An open `package` listing keeps "Waiting for a traveller". This overrides 8.2's "fine, unchanged" for `:41` of the old file.
3. **The line drift is accepted.** Same text, shifted lines, from `e481e6d` and part (a). In `delivery-tracker.tsx` at `f895d90`, 8.2's lines were:

| 8.2 says | At `f895d90` | Text |
| --- | --- | --- |
| `:38` | `:39` | "Match cancelled" |
| `:40` | `:41` | `` `@${l.matchedWithUsername ?? "traveller"} is carrying it` `` |
| `:51` | `:52` | `` `Signed for in ${l.toCity}` `` |
| `:87` | `:82` | `` `Signed for in ${j.dropoffArea}` `` |

4. **Two part (a) pins were retargeted** (option 1). See below.

**Structure (the 8.11 pattern).** The stage derivation moves out of `delivery-tracker.tsx` into `lib/tracker-stages.ts`: the `Stage` type, `fmtDate`, `deriveStages` and `deriveGuestStages`. The module's runtime import is only `lib/guest-tracker-caption.ts`, which is itself import-free; its other imports are type-only. The component imports `deriveStages`, `deriveGuestStages` and the `Stage` type, which `nodeColor` still uses. Its `guestAcceptedCaption` import is gone, since it no longer calls it. Stage state and colours are unchanged.

**Files** (lines added and removed, from `git show --numstat`):

| File | + / - | Change |
| --- | --- | --- |
| `lib/tracker-stages.ts` (new) | 112 / 0 | the stages for both rails; `listingCarrierCaption`; `deliveredCaption`; the three caption constants |
| `components/delivery-tracker.tsx` | 1 / 78 | the stage code removed, imported from the module |
| `tests/tracker-stages.test.ts` (new) | 171 / 0 | the part (d) cases and static pins |
| `tests/delivery-tracker-caption.test.ts` | 12 / 6 | the two retargeted part (a) pins, nothing else |

**The caption changes:**
- **Carrier by kind** (`listingCarrierCaption`, after `listing-detail-sheet.tsx:61-71`): `trip` gives `` `@${l.postedByUsername} is carrying it` ``; `package` gives `` `@${l.matchedWithUsername ?? "traveller"} is carrying it` ``, as before.
- **Expired listing:** "Closed".
- **Open listing:** "Waiting for a sender" on a trip, "Waiting for a traveller" on a package.
- **Delivered**, on both rails: `` `Delivered in ${place}` ``, `toCity` on a listing and `dropoffArea` on a guest job.
- **Guest Accepted:** still `guestAcceptedCaption(j)`, unchanged from part (a).

**The retargeted pins.** The two part (a) pins checked the source of `delivery-tracker.tsx` for `caption: guestAcceptedCaption(j)`, and for the import from `@/lib/guest-tracker-caption`. Once the guest stages moved, both failed, with no behaviour change. They now hold the same guarantee as a chain:
- `lib/tracker-stages.ts` contains `caption: guestAcceptedCaption(j)`, and imports it from `./guest-tracker-caption`.
- `delivery-tracker.tsx` imports the stages from `@/lib/tracker-stages`, and still hard-codes no "A courier is carrying it".

They are the same two tests, rewritten, so **the retarget leaves the count unchanged**. The kept pins are untouched: no "Pioneer" and no `assignedCourier` in the component, and none in `lib/guest-jobs.ts`. The new "no Match cancelled, no Signed for" pins against the component are in `tests/tracker-stages.test.ts`, so no other part (a) test changed.

**Tests: 998 before, 1016 after** (49 files to 50). All 18 new tests are in `tests/tracker-stages.test.ts`:
- **Carrier by kind:** trip and package, for each of `matched`, `in_transit` and `completed`. A trip names the poster, never the matched user; a package names the matched user, never the poster.
- **Open listings:** a trip waits for a sender; a package waits for a traveller.
- **Expired listings:** both kinds read "Closed", with no "Match" or "cancelled".
- **"Signed":** no caption contains it on the listing rail (every kind and status) or the guest rail (every status). A delivered stage reads "Delivered in Madina" on both rails.
- **Guest Accepted caption:** it equals `guestAcceptedCaption(j)` for every guest status, with `courierAssigned` true, false and absent.
- **Static pins:** the tracker imports the stages from `@/lib/tracker-stages` and defines no stage function; it contains no "Match cancelled" or "Signed for"; and `lib/tracker-stages.ts` has only type imports or imports of import-free modules.

`tsc --noEmit` is clean, and so is `npm run security` (gitleaks, the audit gate, tsc).

**Mutation checks**, all in `lib/tracker-stages.ts` except A1. Each was applied, seen to fail, and restored. Each restore was checked by blob hash against the pre-mutation file, and the tree was clean before the commit.

| Mutation | Caught by |
| --- | --- |
| D1, trip and package carriers swapped | 6 tests: "a trip listing ({status}) names the poster as carrier, never the matched user" and "a package listing ({status}) names the matched user as carrier, never the poster", for `matched`, `in_transit`, `completed` |
| D2, `LISTING_CLOSED_CAPTION` back to "Match cancelled" | 2 tests: "a trip / package listing reads the neutral caption, with no "Match" or "cancelled"" |
| D3a, "Signed for in" restored on the listing rail | "on the listing rail, every kind and status"; "a delivered stage reads Delivered in the place, on both rails" |
| D3b, "Signed for in" restored on the guest rail | "on the guest rail, every status"; "a delivered stage reads Delivered in the place, on both rails" |
| D4, the trip waiting caption back to "Waiting for a traveller" | "a trip listing waits for a sender" |
| A1 (part (a), in the new layout), `guestAcceptedCaption` ignores `courierAssigned` | 3 tests in `tests/delivery-tracker-caption.test.ts`: "gives the carrying caption on accepted / in_transit / delivered with courierAssigned true" |

D2 was applied to the constant, the one place the expired caption now lives. A literal "Match cancelled" put back in the component would also fail the static pin.

**The COPY DRAFT strings, exactly** (`lib/tracker-stages.ts`):
- `LISTING_CLOSED_CAPTION`: "Closed"
- `TRIP_WAITING_CAPTION`: "Waiting for a sender"
- `deliveredCaption(place)`: "Delivered in {place}"

The carrier caption ("@{username} is carrying it") is not a new string: on a trip only the username it reads changed. "Waiting for a traveller" is unchanged for packages.

**Deviations.** None from the part (d) prompt as amended by the decisions above. The new module also holds `fmtDate` and the guest stages, because the guest "Delivered in" change touches `deriveGuestStages`, and the prompt asks for the touched derivation to move.

**Mirror.** All four files scan clean for `pinet\.com|Testnet|testnet|8841|3681`, so they mirror as bytes. These notes are scanned at mirror time as usual.

### 8.13 Part (b) built, 11 Oct 2026

Built on `feat/anchoring-phase1` from `23eb06f`, code and tests in `4a41b43`. Not pushed, not merged, not deployed. No SQL, no migration, no env var.

**Founder decisions, 11 Oct 2026, taken before building:**
1. **`lib/guest-jobs.ts` is allowed for one line only:** `GuestJobStatus` gains `| "pending_quote"` (8.3, 8.8 (b)). Without it the tracker's `pending_quote` caption is a `tsc` error. That one line is the whole change to the file.
2. **8.12 is correct as written.** It already says "from `f895d90`, code and tests in `ff69e0e`", so no 8.12 edit was made.
3. **The legacy courier list follows 8.3.** `app/courier/courier-jobs.tsx` drops `JOB_STATUS_LABELS` and prints `guestStatusChip(job.status).label` as plain text, with no Badge.

**Files** (lines added and removed, from `git show --numstat`):

| File | + / - | Change |
| --- | --- | --- |
| `lib/status-labels.ts` (new) | 58 / 0 | `guestStatusChip`, `listingStatusChip`, `TONE_BADGE`, `STATUS_UNAVAILABLE`; no import of any kind |
| `components/listing-detail-sheet.tsx` | 10 / 19 | the label switch is replaced by `listingStatusChip(listing.status)` and `TONE_BADGE`; muted text on the stopped and unknown tones |
| `components/trips-tab.tsx` | 9 / 3 | `listingStatusChip(listing.status)` and its tone variant in place of the raw `{listing.status}` |
| `components/guest-courier-card.tsx` | 9 / 2 | `guestStatusChip(job.status)` and its tone variant in place of the raw `{job.status}` |
| `app/courier/courier-jobs.tsx` | 3 / 9 | `JOB_STATUS_LABELS` removed; plain-text label from `guestStatusChip` |
| `lib/guest-tracker-caption.ts` | 8 / 1 | the guest `pending_quote` and `expired` captions |
| `lib/guest-jobs.ts` | 1 / 0 | `\| "pending_quote"` |
| `tests/status-labels.test.ts` (new) | 183 / 0 | the part (b) cases and static pins |
| `tests/delivery-tracker-caption.test.ts` | 2 / 1 | one changed assertion, below |
| `tests/tracker-stages.test.ts` | 1 / 0 | one changed list, below |

`lib/tracker-stages.ts` needed no change: its guest Accepted caption already comes from `guestAcceptedCaption`, and stage states are out of scope.

**The map, as 8.3 proposes.**

| Tone | Badge variant | Muted text |
| --- | --- | --- |
| `waiting` | `outline` | no |
| `active` | `default` (gold) | no |
| `done` | `secondary` (green) | no |
| `stopped` | `outline` | yes |
| `unknown` | `outline` | yes |

**The COPY DRAFT labels, exactly:**

| Rail | Status | Label | Tone |
| --- | --- | --- | --- |
| guest | `posted` | "Waiting for a courier" | waiting |
| guest | `pending_quote` | "Waiting for a price" | waiting |
| guest | `accepted` | "Courier assigned" | active |
| guest | `in_transit` | "On the way" | active |
| guest | `delivered` | "Delivered" | done |
| guest | `cancelled` | "Cancelled" | stopped |
| guest | `expired` | "Expired" | stopped |
| listing | `open` | "Open" | waiting |
| listing | `matched` | "Matched" | active |
| listing | `in_transit` | "In transit" | active |
| listing | `completed` | "Completed" | done |
| listing | `expired` | "Closed" | stopped |
| either | anything else, empty, null, undefined | "Status unavailable" | unknown |

On the guest tracker (`lib/guest-tracker-caption.ts`, COPY DRAFT):
- `GUEST_PRICE_WAITING_CAPTION`: "Waiting for a price", for `pending_quote`. The Accepted stage stays current.
- `GUEST_EXPIRED_CAPTION`: "Expired", for `expired`. The stage stays cancelled (vermillion). `cancelled` keeps "Cancelled".

**Visible changes, stated plainly.**
- **The listing sheet:** `open` moves from green to outline; `completed` moves from gold to green; `expired` reads "Closed", where it read "Expired". A value the map does not know reads "Status unavailable", where it showed the raw value.
- **The trips tab and the Pioneer courier card:** these showed raw values (for example `in_transit`) on outline. They now show labels, in tone colours.
- **The legacy courier list:** `accepted` reads "Courier assigned", where it read "Accepted, not picked up yet". `pending_quote` now has a label. An unknown value reads "Status unavailable", not the raw value. "Courier assigned" is written for a sender and reads oddly to the courier who holds the job. Flagged for the copy review.

**Tests: 1016 before, 1042 after** (50 files to 51). Of the 26 new tests, 25 are in `tests/status-labels.test.ts`. The 26th is the per-file case `tests/logging.test.ts` generates for every `lib/` file, here for `lib/status-labels.ts`. The 25:
- **The maps:** all seven guest values and all five listing values map to their label and tone.
- **The fallback:** unknown, empty, null, undefined, wrong case, a leading space, `constructor` and `__proto__` all give "Status unavailable" with tone unknown, never the input. A listing value is unknown on the guest map, and the reverse.
- **Labels and tones:** no label contains an underscore. `TONE_BADGE` is exactly the table above. Only `done` is `secondary`.
- **The tracker:** `pending_quote` reads "Waiting for a price" (stage current); `expired` reads "Expired" (stage cancelled) and `cancelled` keeps "Cancelled"; the Accepted caption for every other status is unchanged.
- **Static pins:**
  - none of the four consumers renders a raw status as text, and each imports `@/lib/status-labels`
  - the sheet and the trips tab use `listingStatusChip`; the courier card uses `guestStatusChip`
  - `courier-jobs.tsx` keeps no label map and prints the label in a plain `<p>`
  - the sheet keeps no label switch
  - `lib/status-labels.ts` has no import or re-export of any kind

`tests/courier-host.test.ts` still passes, with `courier-jobs.tsx` importing `lib/status-labels.ts`. `tsc --noEmit` is clean, and so is `npm run security` (gitleaks, the audit gate, tsc).

**Existing assertions changed, each one:**
- `tests/delivery-tracker-caption.test.ts`, in "keeps the cancelled and waiting captions": `guestAcceptedCaption({ status: "expired" })` was `"Cancelled"` and is now `"Expired"`. It pinned the old caption for exactly `expired`.
- `tests/tracker-stages.test.ts`, `GUEST_STATUSES`: `"pending_quote"` is added, so the guest-rail "no Signed" and "the guest Accepted caption still comes from guestAcceptedCaption" tests now cover it. The test count is unchanged, since the list drives loops inside existing tests.

**Mutation checks.** Each was applied, seen to fail, and restored. Each restore was checked by blob hash against the pre-mutation file.

| Mutation | Caught by |
| --- | --- |
| B1, the unknown fallback returns `{ label: status, tone: "unknown" }` | "reads "Status unavailable" with tone unknown, never the input, on both rails"; "a listing value is not a guest label, and the reverse" |
| B2, listing `expired` back to "Expired" | "expired is "Closed", stopped" |
| B3, `trips-tab.tsx` prints `{listing.status}` again | "none of the four consumers renders a raw status as text" |
| B4, `GUEST_PRICE_WAITING_CAPTION` back to "Waiting for a courier" | "pending_quote waits for a price, not a courier" |
| B5, listing `completed` tone `done` to `active` (gold) | "completed is "Completed", done" |

**Deviations.**
- **The trips tab mutes text on outline chips only.** The row's existing `muted` (past rows) adds muted text, as before, but only when the chip is outline. On a filled chip (a past `completed` row, now green) muted text would lose contrast, and the row's `opacity-70` already mutes it.
- **Two cases go beyond 8.8 (b)'s list:** the cross-rail fallback test, and the check that only `done` is green.

**Erratum for 8.11 and 8.12 (test attribution only; the totals were right).** `tests/logging.test.ts` generates one test per `lib/` file. So each part that added a `lib/` module gained a test there, which the earlier records attributed elsewhere:
- **8.11, the follow-up (995 to 998):** two new static pins, plus the logging case for `lib/guest-tracker-caption.ts`. The "`lib/guest-jobs.ts` no longer defines the caption" check was an assertion added to an existing test, not a new test.
- **8.11, part (a) (961 to 995):** the 34 include the logging case for `lib/guest-accept-message.ts`.
- **8.12 (998 to 1016):** `tests/tracker-stages.test.ts` holds 17 tests, not 18. The 18th is the logging case for `lib/tracker-stages.ts`.

8.11 and 8.12 are left as written, and this erratum corrects them.

**Mirror.**
- `components/listing-detail-sheet.tsx` is the known network-specific file. It scans 4 hits, the same as before, and the part (b) diff adds none. Its change is **hand-applied** onto the Mainnet version, not copied as bytes.
- The other nine files scan clean for `pinet\.com|Testnet|testnet|8841|3681`, so they mirror as bytes.
- These notes are scanned at mirror time as usual.

### 8.14 Part (c) built, 11 Oct 2026

Built on `feat/anchoring-phase1` from `03c7c69`, code and tests in `d3bcbc2`. Not pushed, not merged, not deployed. No SQL, no migration, no env var, and no route, payload or type change (8.10 decision 4).

**Structure (the 8.11 pattern).** `lib/completion-lines.ts` is a pure module:
- Its one runtime import is `lib/delivery-stamps.ts` (`STAMP_BOTH`, `STAMP_SENDER`, `STAMP_COURIER_CODE`), which has no imports; its other imports are type-only.
- `guestCompletionLine` reads `deliveryConfirmedBy` and `pickupConfirmedAt`.
- `listingCompletionLine` reads `senderConfirmed` and `travellerConfirmed`.
- `completionMessage(result)` picks the rail from `result.kind` and adds the second sentence. It is the one function the three consumers call.

**Files** (lines added and removed, from `git show --numstat`):

| File | + / - | Change |
| --- | --- | --- |
| `lib/completion-lines.ts` (new) | 56 / 0 | the two rail functions, `completionMessage`, the lines |
| `components/track-view.tsx` | 3 / 5 | the completion block renders `completionMessage(result)` (was `:394-398`, chosen from `hasDeliveryCode` alone) |
| `components/track-tab.tsx` | 4 / 2 | renders `completionMessage(result)` (was `:109-110`, the listing line for every result) |
| `components/listing-detail-sheet.tsx` | 4 / 2 | renders `completionMessage(listing)` (was `:861-862`) |
| `tests/completion-lines.test.ts` (new) | 229 / 0 | the part (c) cases and static pins |

**The COPY DRAFT lines, exactly** (8.2's table, row for row):

| Rail | On the row | Line |
| --- | --- | --- |
| guest | `deliveryConfirmedBy` = `sender+courier_code` | "You confirmed this delivery and the courier entered your delivery code at handover." |
| guest | `sender`, and `pickupConfirmedAt` set | "You confirmed pickup and delivery." |
| guest | `sender`, `pickupConfirmedAt` null | "You confirmed delivery." |
| guest | `courier_code` only | "The courier entered your delivery code at handover." |
| guest | none, or a value not listed | "This delivery is marked complete." |
| listing | `senderConfirmed` and `travellerConfirmed` both true | "Both sender and traveller confirmed this delivery as done." |
| listing | either one, or neither | "This delivery is marked complete." |

The second sentence is unchanged on every line: "Thanks for moving things across Gyema the safer way." It stays for the copy review (8.10 decision 9).

**Visible changes, stated plainly.**
- **track-view:** a coded guest job used to read the sender-and-code line, and an uncoded one "You confirmed pickup and delivery", whatever was stamped. Each now reads only what its stamps say. A job closed by hand with no stamp (F14) reads "This delivery is marked complete."
- **track-tab:** this tab used to print "Both sender and traveller confirmed this delivery as done." for guest jobs too (scope addition A, the report on a Mainnet guest job (ID held privately)). A guest result now gets its guest line.
- **The sheet and both tracker pages:** a `completed` listing says "Both" only when both flags are set.

**Tests: 1042 before, 1060 after** (51 files to 52). Of the 18 new tests, 17 are in `tests/completion-lines.test.ts`. The 18th is the `tests/logging.test.ts` case for `lib/completion-lines.ts`. **No existing assertion changed.** The 17:
- **Guest (7):** each of the five rows of the table. An unknown stamp value (`""`, `operator`, `SENDER`, `sender+`) makes no claim. The pickup half reads `pickupConfirmedAt` only.
- **Listing (2):** both flags give "Both". One flag or neither (true/false, false/true, true/undefined, undefined/true, false/false, undefined/undefined) never says "Both".
- **`completionMessage` (3):**
  - the second sentence is added unchanged
  - a guest result gets exactly its guest line for every stamp and pickup combination, never the listing line or "traveller"
  - a listing never gets a guest line
- **Static pins (5):**
  - the three consumers import `completionMessage` from `@/lib/completion-lines` and render it
  - none holds a completion line of its own
  - "the safer way" lives in the module (track-view keeps it once, on its sign-off card, below)
  - track-tab names no rail function or listing line
  - the module's runtime imports are import-free modules only

`tsc --noEmit` is clean, and so is `npm run security` (gitleaks, the audit gate, tsc).

**Mutation checks.** Each was applied, seen to fail, and restored. Each restore was checked by blob hash against the pre-mutation file, and C1 to C4a were rerun against the final test file.

| Mutation | Caught by |
| --- | --- |
| C1, the listing line says "Both" with one flag (`&&` to `\|\|`) | "a completed listing with one flag, or neither, never says "Both"" |
| C2, the guest line ignores `deliveryConfirmedBy` (always the sender-and-code line) | 7 tests: the sender-with-pickup, sender-without-pickup, code-only and no-stamp rows; "an unknown stamp value makes no claim either"; "the pickup half reads pickupConfirmedAt only"; "adds the second sentence, unchanged" |
| C3, the pickup half ignores `pickupConfirmedAt` (always "pickup and delivery") | "sender, pickup not confirmed: you confirmed delivery, nothing about pickup"; "the pickup half reads pickupConfirmedAt only (8.10 decision 4)" |
| C4a, track-tab hard-codes the listing line again, as before part (c) | "the three consumers import the module and render completionMessage"; "the three consumers hold no completion line of their own" |
| C4b, `completionMessage` routes a guest result through the listing rule | "adds the second sentence, unchanged"; "never gives a guest result the listing line, whatever its stamps" |
| C4c, `completionMessage` gives a guest result the "Both" line | the same two tests |

C4b first survived "never gives a guest result the listing line". A guest routed through the listing rule lands on "This delivery is marked complete.", a line both rails share, so "never the listing line" did not see it. That test now asserts the exact guest line for each combination, and C4b and C4c both fail it.

**Deviations.**
- **`hasDeliveryCode` is not an input.** The part (c) prompt listed it with the stamps, but 8.2's table keys the guest line on `deliveryConfirmedBy` and the pickup stamp only, and the table is the spec. The stamps already carry what `hasDeliveryCode` would add: `courier_code` and the composite only exist on a coded job. Choosing the line from `hasDeliveryCode` was the old defect (scope addition A).
- **The guest "none" row also takes unknown values.** A `deliveryConfirmedBy` outside the three legal stamps (`lib/delivery-stamps.ts`) makes no claim, like a null one. 8.2's table lists only the legal values.
- **The static pin for the code-only line is narrowed.** `track-view.tsx:333` opens its in-transit prompt with "The courier entered your delivery code at handover. Confirm with the last 4 digits ...", which 8.2 leaves unchanged. So that line is pinned only in its completion form: on its own, or followed by the thanks.
- **"the safer way" stays once in track-view,** on the sender's sign-off card at `:321` ("You signed off on this delivery. Thanks for moving things across Gyema the safer way."). 8.2 lists that line as unchanged, and the pin allows exactly that one.

**Mirror.**
- `components/listing-detail-sheet.tsx` is the known network-specific file. It scans 4 hits, the same as before, and the part (c) diff adds none. Its change is **hand-applied** onto the Mainnet version, not copied as bytes.
- `lib/completion-lines.ts`, `components/track-view.tsx`, `components/track-tab.tsx` and `tests/completion-lines.test.ts` scan clean, so they mirror as bytes.
- These notes are scanned at mirror time as usual.

### 8.15 Part (g) built, 11 Oct 2026

**What changed.** Comment only, in `lib/guest-pricing.ts`, built in `c97ec69` from `05832f5`. Line 1 now says five zones (A to E), not four. The city-fallback comment at `:78-85` no longer names `GHANA_CITIES`. `git diff` showed 0 non-comment lines.

**The corrected reading.** The Accra/Tema fallback is reached only by tests (`tests/pioneer-offer-units.test.ts:27`, `:51`), not by older listings. Both callers of `pioneerBenchmarkCedis` are in `components/home-tab.tsx` and read the forms' own dropdown state. Since `2cfcdb5` (confirmed by `git show`: it replaced the local `GHANA_CITIES` list with `TRIP_AREAS` in all four dropdowns), that state comes only from `TRIP_AREAS`. Removing the fallback is a later item.

**Checks.** 1060 tests unchanged. `tsc` and `npm run security` are clean. The file scans clean, so it mirrors as bytes.

### 8.16 Part (e) built, 11 Oct 2026

Icons only. Built on `feat/anchoring-phase1` from `aa335c2`, in `ee27f8c`. Not pushed, not merged, not deployed. No SQL, no migration, no env var. The title, `themeColor` and the courier page description are not in this part; they go to the copy review.

**Founder decisions, 11 Oct 2026:**
1. **The hand mark only.** No wordmark, no tagline.
2. **Vector, traced from the founder's JPG.** `assets/brand/gyema-logo-1024.jpg` (1024 x 1024: mark, wordmark, tagline) is the original raster, kept as the trace origin. Two SVGs, same shape:
   - `gyema-hand-mark.svg`: the master, mark only, transparent
   - `gyema-icon.svg`: the square app icon, mark centred on white, 6 percent margin

   A first cut from the JPG (crop box left 238, top 165, 571 x 244, padded to 640 x 640) was approved and then replaced by the vector before any commit.
3. **White background, no alpha.** A dark mark on transparent vanishes in a dark tab.
4. **The same icon on both networks.**
5. **`middleware.ts` is unchanged.** See "Middleware" below.
6. **`sharp` comes via Next.js.** It is a dependency of `next`, not a declared dependency, and `package.json` is unchanged. The script's header says so.
7. **The icons are numbered** (`icon1.svg`, `icon2.png`). See "Why the rename" below.

**Files.**

| File | Bytes | What |
| --- | --- | --- |
| `app/icon1.svg` | 9,936 | byte copy of `assets/brand/gyema-icon.svg` |
| `app/icon2.png` | 8,468 | 512 x 512, RGB, no alpha |
| `app/apple-icon.png` | 2,626 | 180 x 180, RGB, no alpha |
| `app/favicon.ico` | 803 | 16 x 16 and 32 x 32, PNG-encoded entries |
| `assets/brand/gyema-hand-mark.svg` | 9,855 | the master |
| `assets/brand/gyema-icon.svg` | 9,936 | the square icon |
| `assets/brand/gyema-logo-1024.jpg` | 82,490 | the original raster |
| `assets/brand/README.md` | 714 | which file is which, and how to recut |
| `scripts/cut-icons.mjs` | | renders each size from `gyema-icon.svg` at 4x and reduces with Lanczos3 (no size is a downscale of another output), writes the ICO, copies the SVG |
| `tests/site-icons.test.ts` | | 10 tests, below |

**Removed from `public/`** (the v0 template, 8.4): `apple-icon.png`, `icon-dark-32x32.png`, `icon-light-32x32.png`, `icon.svg`, `placeholder-logo.png`, `placeholder-logo.svg`, `placeholder-user.jpg`, `placeholder.jpg`, `placeholder.svg`. A repo-wide search found no reference to any of them, apart from the middleware matcher (below). `public/gyema-hand.png` is kept (`components/sign-in.tsx:48`).

**SVG safety check, both SVGs.** Only `svg`, `rect` and `path` elements. No script, no style, no href or xlink:href, no `on*` attributes, no `url(`, no `data:`, no doctype or entity. The only URL is the SVG namespace, an identifier that is never fetched. The path data holds only path syntax.

**Why the rename.** With an unnumbered `app/icon.svg` and `app/icon.png` both present, Next 15 emitted only the PNG link. `/icon.svg` was served (200) but linked from no page. This was verified on a local production build serving both hosts (`next start`, with `COURIER_HOST` set for that one local process). The number suffix is Next's documented way to ship several icons. A guard test now refuses the unnumbered pair.

**Middleware.** `middleware.ts:125` names `icon.svg` and `apple-icon.png` in the matcher's exclusion list.
- `apple-icon.png` now covers `app/apple-icon.png`.
- `icon.svg` is **a dead entry again**: no file serves `/icon.svg`. `.*\.svg$` and `.*\.png$` already cover `/icon1.svg` and `/icon2.png`.
- It is left alone, because `middleware.ts` is a security file and the entry is harmless.

**Build check.** `npm run build` lists `/icon1.svg`, `/icon2.png` and `/apple-icon.png` as static routes, and emits `favicon.ico`. On a local production server, `/`, `/send`, `/track` (pinet surface) and the courier page (courier surface, "Gyema couriers", requested with `x-forwarded-proto: https`) each emit all four links:

```
<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="16x16"/>
<link rel="icon" href="/icon1.svg?329f83a5c82b6fc2" type="image/svg+xml" sizes="any"/>
<link rel="icon" href="/icon2.png?59e0f34ddbf7eebe" type="image/png" sizes="512x512"/>
<link rel="apple-touch-icon" href="/apple-icon.png?600a184578587f85" type="image/png" sizes="180x180"/>
```

All four files answer 200 on both hosts. Browser check after deploy, per 8.8 (e): the tab icon shows on each host. Pi Browser caches hard, so close it fully and reopen.

**Tests: 1060 before, 1070 after** (52 files to 53). No `lib/` file was added, so there is no `logging.test.ts` case. The 10:
- the three PNG and ICO sizes, read from the headers, each RGB with no alpha
- `app/icon1.svg` is a byte copy of `gyema-icon.svg`
- the guard: no unnumbered `icon.svg` and `icon.png` pair in `app/`
- both SVGs pass the safety check (2 tests)
- none of the nine v0 files is in `public/`
- `gyema-hand.png` is kept
- no source file references a removed file

**Mutation checks**, each seen to fail and reverted:
- `public/icon.svg` restored from HEAD: "none of the v0 template files remains" failed.
- `app/icon.svg` and `app/icon.png` added beside the numbered pair: "app/ never holds both an unnumbered icon.svg and icon.png" failed.

**SHA-256** (`assets/brand/`, the working files as committed):
- `gyema-logo-1024.jpg`: `a7d52202fa5cf0fa63407483becadeeb476cc445d4223491bde53dc65864ab5f`
- `gyema-hand-mark.svg`: `36f0aa60999849d762558a0d328ca6a07763a1676c874ae65b00c1da28a2223e`
- `gyema-icon.svg`: `b794c5c550622deebdebb1f613f14e8d11342d3ffb560badc076544430624959`
- `README.md`: `d3e032d41f6d0d254f776c8994e6d31052e21ef67df306485fdeb3f2fe40cb6a`

**Mirror.** Every added file scans clean for `pinet\.com|Testnet|testnet|8841|3681`, including the binaries. Nothing is network-specific: the same icon ships on both networks, so all of it mirrors as bytes, and the removals mirror as the same removals.

### 8.17 Part (f) built, 11 Oct 2026

The approved copy. Built on `feat/anchoring-phase1` from `fbb0c3f`, in `2cbbf66`. Not pushed, not merged, not deployed. No SQL, no migration, no env var. The source was a read-only inventory of 143 strings (C1 to C143), written to an uncommitted `tmp/copy-inventory.md`, which was deleted after this commit. The IDs below are its rows.

**Founder decisions, 11 Oct 2026, 16:13:**
- **D1.** "Thanks for moving things across Gyema the safer way." becomes "Thanks for using Gyema." It is the completion line's second sentence (`COMPLETION_THANKS`, C35). The sender sign-off card (C36) now reads "You signed off on this delivery. Thanks for using Gyema." The comparative claim is gone.
- **D2.** "Phone-verified sender" becomes "Sender confirmed on WhatsApp", on the guest tracker's Posted stage (C9, which keeps " · ${fmtDate(j.createdAt)}") and on three badges (C10 to C12).
  - **Verified first, from the code.** The only code that writes `phone_verified` is `app/api/guest/create/route.ts:214`, which inserts `false`. Every other reference in routes, `lib/`, `scripts/` and `db/migrations/` is a `WHERE` or `.eq` filter, or a view column. Nothing in the repository sets it `true`.
  - The documented process (`create/route.ts:10-12`, `track/route.ts:25-29`): the operator matches the sender's WhatsApp message to the row and sets the flag by hand in the dashboard.
  - The repository cannot rule out a hand-added database object (there is no schema baseline). A read-only catalog read of triggers on `guest_jobs` would settle that.
- **D3.** C1 "A courier is carrying it" becomes "A courier took this job".
- **D4.** C18, the guest accepted label, becomes "Accepted, not picked up yet". This is the legacy list's wording from before part (b).
- **D5.** C8: with no matched username, the package carrier caption reads "A traveller is carrying it", with no "@" (`UNNAMED_TRAVELLER_CAPTION`). With a username it is unchanged.
- **D6.** C39 to C42, the courier page Account labels: registered "Signed up", buffer "Starter (limited jobs)", full "Verified courier", paused "Paused". This replaces the ladder's internal words (8.5 flag).
- **D7.**
  - C137: the root title becomes "Gyema: peer to peer delivery on Pi".
  - C140: the courier page sets its own description, "Sign in to see and take Gyema delivery jobs.", with no Pi mention. It no longer inherits the root one.
  - The `<title>` em-dashes in `public/methodology.html`, `public/privacy.html` and `public/terms.html` become a colon: "Gyema: Carbon Methodology", "Gyema: Privacy Policy", "Gyema: Terms of Service".
- **D8.** C13 is unchanged.
- **Every other inventory row is approved as written.**

**Markers.** Each COPY DRAFT marker on an approved string, and each file header, now reads "Copy approved 11 Oct 2026 (8.17)". No COPY DRAFT marker remains in the code. Three items stay open, marked "COPY: later (8.17)":
- `themeColor` `#7B2CBF` (C139, `app/layout.tsx`), a purple that is not in the palette
- the refusal wording differences between the Pioneer sheet (`lib/guest-accept-message.ts`, C13 to C15) and the courier page (`app/courier/courier-jobs.tsx`, `ACCEPT_ERRORS`, C78, C80, C81). The same reasons are worded differently on each surface.
- the three "You confirmed" completion lines (`lib/completion-lines.ts`, C29 to C31). They are worded to the sender, but the tracker shows them to anyone holding the tracking ID.

**Files** (lines added and removed, from `git show --numstat`):

| File | + / - |
| --- | --- |
| `app/courier/courier-jobs.tsx` | 4 / 1 |
| `app/courier/courier-panel.tsx` | 4 / 4 |
| `app/courier/page.tsx` | 4 / 1 |
| `app/layout.tsx` | 3 / 1 |
| `app/send/page.tsx` | 5 / 5 (markers only) |
| `components/courier-test-banner.tsx` | 1 / 1 (marker only) |
| `components/guest-courier-card.tsx` | 1 / 1 |
| `components/guest-job-sheet.tsx` | 2 / 2 |
| `components/track-view.tsx` | 1 / 1 |
| `lib/completion-lines.ts` | 6 / 4 |
| `lib/guest-accept-message.ts` | 3 / 2 (markers only) |
| `lib/guest-tracker-caption.ts` | 4 / 4 |
| `lib/status-labels.ts` | 2 / 3 |
| `lib/tracker-stages.ts` | 10 / 5 |
| `public/methodology.html`, `public/privacy.html`, `public/terms.html` | 1 / 1 each |
| `tests/approved-copy.test.ts` (new) | 140 / 0 |
| `tests/completion-lines.test.ts` | 6 / 6 |
| `tests/delivery-tracker-caption.test.ts` | 3 / 3 |
| `tests/status-labels.test.ts` | 1 / 1 |

**Existing assertions changed, each one:**
- `tests/completion-lines.test.ts`, "adds the second sentence, unchanged": `COMPLETION_THANKS` is "Thanks for using Gyema.".
- `tests/completion-lines.test.ts`, the "safer way" pin, renamed to '"Thanks for using Gyema." lives in the module; track-view keeps it only on its sign-off card (8.2, 8.17 D1)':
  - track-tab and the sheet hold no "Thanks for using Gyema"
  - track-view holds it exactly once, as "You signed off on this delivery. Thanks for using Gyema."
- `tests/delivery-tracker-caption.test.ts`, "the drafts are the strings 8.2 proposed", renamed "the captions are the approved strings (8.17)": `GUEST_CARRYING_CAPTION` is "A courier took this job".
- `tests/delivery-tracker-caption.test.ts`, the chain pin: `delivery-tracker.tsx` does not hard-code "A courier took this job" (was "A courier is carrying it").
- `tests/status-labels.test.ts`, the guest table: `accepted` is "Accepted, not picked up yet" (was "Courier assigned").

**Tests: 1070 before, 1084 after** (53 files to 54). No `lib/` file was added. The 14 new tests are in `tests/approved-copy.test.ts`:
- **Repo-wide, over `app/`, `components/`, `lib/` and `public/*.html`:**
  - the scan covers a real file set
  - no "safer way"
  - no "Phone-verified"
  - no "@traveller" or `?? "traveller"`
  - no em-dash in any `<title>`, `title:` or `description:` value
- **The approved strings:**
  - the root title
  - the three static page titles
  - the courier page's own description, with no "Pi"
  - the sender badges and the tracker caption
  - the courier page Account labels
- **D5:** with no username (null, undefined, empty), "A traveller is carrying it" with no "@", through the stages too; with a username, unchanged.
- **Markers:** no COPY DRAFT left in the code; the three "COPY: later (8.17)" markers are in place.

`tsc --noEmit` is clean, and so are `npm run security` and `npm run build`. On a local production server:
- the pinet `/` renders `<title>Gyema: peer to peer delivery on Pi</title>`
- the courier page renders `<title>Gyema couriers</title>` with `<meta name="description" content="Sign in to see and take Gyema delivery jobs.">`
- the three static pages render their colon titles

**Mutation checks.** Each was applied, seen to fail, and restored. Each restore was checked by blob hash against the pre-mutation file.

| Mutation | Caught by |
| --- | --- |
| "the safer way" back in C35 | "no file holds "safer way" (8.17 D1)"; "adds the second sentence, unchanged" |
| the em-dash back in the root title | "no page title or metadata holds an em-dash (8.17 D7)"; "the root title is "Gyema: peer to peer delivery on Pi"" |
| "Phone-verified sender" back in the Pioneer courier card badge | "no file holds "Phone-verified" (8.17 D2)"; "the sender badges read "Sender confirmed on WhatsApp"" |
| the D5 fallback back to `@${l.matchedWithUsername ?? "traveller"}` | "no file holds "@traveller" (8.17 D5)"; "reads "A traveller is carrying it", with no "@"" |

**Mirror: hand-applied on Mainnet.**
- `app/layout.tsx`: 5 scan hits, the known network-specific file. The title and the `themeColor` marker are hand-applied.
- `app/send/page.tsx`: 1 hit, the pinet link. The four marker lines are hand-applied.
- `public/privacy.html`: named network-specific by the founder. It scans 0 hits on Testnet, but its Mainnet version is to be hand-applied, not copied.

Every other changed file scans clean and mirrors as bytes: the courier page files, the four components, the five `lib/` modules, `public/methodology.html`, `public/terms.html` and the four test files. `components/listing-detail-sheet.tsx` and `components/testnet-banner.tsx` are not touched by this part. These notes are scanned at mirror time as usual.

## Hardening (a): function privileges and the catalog checks

Committed separately from the Phase 1 items, at the founder's request, 8 Oct 2026.

- **`docs/catalog-checks.sql`:**
  - The check 9 default-privileges row is scoped to `defaclrole = 'postgres'::regrole`.
  - Check 12 now lists every security definer function in public that PUBLIC, anon or authenticated can execute, read from the ACL with `aclexplode`. The old text match skipped any ACL that also named `service_role`; in the Docker run it would have missed a function granted to anon and service_role together.
  - The check 12b expectation is corrected: there is a postgres functions row, and on Testnet it granted EXECUTE to anon and authenticated.
  - Check 12's expectation is exactly one row, `listing_counterpart_contact` for `authenticated`, which is by design.
- **`db/migrations/2026-10-08_default_function_privileges.sql`:** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated`, idempotent, with a verification cell.

**Measured, and the reason for a decision below.** In Docker (postgres 17.11), with the Supabase-shaped default in place, the statement removed anon and authenticated from the default (`{service_role=X/postgres}` afterwards). But a function created afterwards was still executable by anon, through PUBLIC: its ACL read `{=X/postgres,postgres=X/postgres,service_role=X/postgres}`. A schema-scoped default can only add to Postgres's built-in defaults. The global form, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` with no `IN SCHEMA`, did remove PUBLIC: a new function's ACL read `{postgres=X/postgres,service_role=X/postgres}`, and anon could not execute it. That corrects section 1a of the grant baseline, which measured only the `IN SCHEMA` form and concluded no default could take EXECUTE from PUBLIC. That file is an applied record and is not edited here.

### Founder decision, 8 Oct 2026: the global form is not applied

Role postgres owns 49 functions in schema `extensions` on Testnet. A global `REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` for role postgres would leave functions from future extension installs, including `pg_cron` and `pg_net`, unexecutable by the roles that call them. So it is not applied, and the controls stay as three:

- the schema-scoped default (P7, `2026-10-08_default_function_privileges.sql`)
- the explicit per-function revoke from public, anon and authenticated (invariant 2)
- catalog check 12, which lists any security definer function in public that PUBLIC, anon or authenticated can execute

New functions in public therefore remain executable through PUBLIC until their own migration revokes it. Recorded in the migration header too.

## Orphan drop (b): `couriers` and `legacy_couriers`

Committed separately, 8 Oct 2026, per decision 4. Recorded by the founder: `legacy_couriers` held one row, their own July test.

- **`db/migrations/2026-10-08_drop_orphan_courier_tables.sql`:** `drop table if exists` for both, with no `cascade`, a read-only `pg_depend` pre-flight in section 1, and a verification cell. Irreversible, so `docs/orphan-courier-tables.sql` runs first on each network and its output is kept. The read query stays in `docs/` as that record.
- **`docs/catalog-checks.sql`:** both tables removed from the unreferenced list (check 13 now watches `a2u_payments` alone), from the check 2 ordering and from the expectations. Two `2026-10-08 orphan drop` rows in check 9 confirm both are gone.
- **Tested in Docker** (postgres 17.11):
  - With a dependent view and a foreign key in place, the pre-flight listed both, and the drop failed naming the view, with both tables left in place.
  - Without them, the pre-flight returned nothing, the migration ran twice with `all_present` true, the check 9 rows went from false to true, and check 13 listed only `a2u_payments`.
- **Partial run.** If only one table has a dependent, the editor can stop after dropping the other. Re-running after the dependent is dealt with finishes the job, since both drops are `if exists`.

## Status checks (c): `guest_jobs.status` and the courier registry timing rules

Built 11 Oct 2026. Two migrations, P16 and P17 in `docs/deploy-order.md`. P17 applied on Testnet 11 Oct 2026 at 09:30 (founder approved; `all_present` true, fifteen constraints, catalog clean); Mainnet not applied. P16 not applied on either network, and a no-op on both (below).

**Found 11 Oct 2026, by catalog read: `guest_jobs_status_check` pre-existed on both networks.** The founder's read-only checks found it on Testnet and Mainnet with the identical live definition `CHECK ((status = ANY (ARRAY['pending_quote'::text, 'posted'::text, 'accepted'::text, 'in_transit'::text, 'delivered'::text, 'cancelled'::text, 'expired'::text])))`. It was added by hand before `db/migrations` existed. The repository had no record of it because there is no schema baseline: no file creates `guest_jobs`, so a constraint added by hand leaves no trace here, and the code search that settled the seven values could not have found it. P16 is therefore a no-op on both networks that records the constraint in the repository. As committed in `e70fde7` it would have skipped the add on any constraint of that name, matching or not; `4ae6ecc` makes section 1 read the live constraint first, pass exactly the seven values in any order, and stop the file on any other definition, NOT VALID included, printing it. It never drops or replaces a constraint. Docker, postgres:17-alpine, twice, 21 of 21: absent adds it; the live definition and a reversed order are no-ops with `all_present` true and the same constraint oid; six values without `pending_quote`, eight values and NOT VALID each stop and print the definition, leaving the constraint untouched.

- **P16, `db/migrations/2026-10-11_guest_jobs_status_check.sql`:** the named check `guest_jobs_status_check`, status in seven values: `posted`, `pending_quote`, `accepted`, `in_transit`, `delivered`, `cancelled`, `expired`.
  - **Why seven, not six (founder decision, 11 Oct 2026).** The brief named six. A search of the codebase and every migration before the file was written found one more value written to `guest_jobs.status`: `pending_quote`, from `app/api/guest/create/route.ts:219`, for every off-list post, and read by the dispatch reader's sections 1 and 2. A six-value check would refuse every off-list guest post. No other value is written: `posted` (create), `accepted` (`lib/guest-claim.ts`), `in_transit` (confirm-pickup), `delivered` (`guest_stamp_delivery`), and `cancelled` and `expired` by hand (F14).
  - A check passes a null. Whether `status` is NOT NULL is not recorded in this repository, so the hand-run pre-flight reads it.
- **P17, `db/migrations/2026-10-11_courier_registry_timing_checks.sql`:** `courier_registry_full_needs_approval_check` (`status <> 'full' or kyc_approved_at is not null or vouched_at is not null`) and `courier_registry_buffer_needs_since_check` (`status <> 'buffer' or buffer_since is not null`). Needs P2 and P13.
  - **This reverses P2's recorded choice** to leave these two rules as counts rather than checks, so a hand fix of status could never be blocked (decision 7). P2 is applied and not edited. Neither check constrains a hand pause: `status = 'paused'` is free of both.
  - Every writer was read. `courier_register_legacy`, `courier_register_pioneer` and `courier_apply_kyc_status` pass. `courier_bind_piverify_session` keeps the status of a row under an operator pause while nulling `buffer_since`, so a row with `paused_reason = 'operator'` and status `buffer` would now make bind fail with 23514 instead of writing a buffer row with no clock. The P17 pre-flight counts such rows.
- **Both files** stop themselves at a guard, before anything is written, on any violating row (P16 names the bracketed values and counts, P17 gives counts only), and end with an `all_present` verification cell. `docs/catalog-checks.sql` gains three check 9 rows, one per check; check 14 expects fifteen constraints after P17.
- **Tested in Docker** (postgres:17-alpine), the whole proof run twice from fresh containers, 25 of 25 each time. P17 ran over the real P2, P5, P9 and P13; P16 over a minimal `guest_jobs`, since no file in the repository creates that table.
  - Clean rows, `pending_quote` among them, apply and re-run clean with `all_present` true.
  - A violating row (`completed`, `'posted '` with a trailing space, a full row with no stamp, a buffer row with no clock) stops the file at the guard, and no constraint is written.
  - Without P13, the P17 guard says so rather than failing with 42703.
  - After apply, a bad insert or update is refused with 23514 naming the check. A `pending_quote` insert and an operator hand pause are still accepted.
- **Also in this pass.** The four pre-existing `tsc` errors are cleared (`589c59b`), and `npm run security` now ends with `tsc --noEmit` (`095fdba`), so any new type error fails the gate.
- **Mirroring:** neither migration names a network, so both mirror as bytes.

## Item 10 (design, 12 October 2026): operator-checked buffer for legacy couriers

Design only. No code, no SQL file, no migration written. Built on `design/operator-checked-buffer` off main `c8b5384`. Every column, constraint and function name below was copied from the migrations at `c8b5384`, with file and line.

**Why.** PiVerify API access has never authenticated for Gyema's account (GitHub issue pi-apps/pi-platform-docs #618, open since 18 July, no reply). The legacy ladder moves a courier from `registered` to `buffer` only on PiVerify `pending_review` (`db/migrations/2026-10-08_piverify_resubmission.sql:271-272`), so no legacy courier can reach a job.

### 10.0 Founder decisions, 12 October 2026 (verbatim)

1. An in-person operator check moves a legacy courier from registered to BUFFER ONLY (guest jobs, both areas on the list, declared value up to GHS 200). Full still requires PiVerify approval (kyc_approved_at). A legacy courier is never vouched to full.
2. Sight only: the founder sees the Ghana Card in person. Store only when the check happened and who did it. No ID number, no photo, nothing about the document.
3. Sunset: once PiVerify authenticates, operator-checked couriers must complete PiVerify within a set number of days or be paused. The number of days is decided at design review.
4. Scope: only riders the founder personally knows (met, phone known).

The buffer limits in decision 1 are already the ladder's buffer limits, so nothing new enforces them: `bufferJobGuards` in `lib/courier-ladder.ts:106-111` requires both areas on `GUEST_AREA_NAMES` and `declared_value_cedis` at or below `BUFFER_VALUE_CAP_CEDIS`, which is 200 (`lib/declared-value.ts:28`). A null declared value fails the comparison and counts as over the cap.

### 10.1 What is there today, and the two things that would break

The table is `public.courier_registry` (P2, `db/migrations/2026-10-08_courier_registry.sql`), with `status` held to `registered`, `buffer`, `full`, `paused` by `courier_registry_status_check` (`:109-110`) and `paused_reason` to `rejected`, `failed`, `pending_timeout`, `operator` by `courier_registry_paused_reason_check` (`:118-120`). P9 added `piverify_allowed_action` and `courier_registry_piverify_allowed_action_check`; P13 added `vouched_at` and `courier_registry_vouched_pioneer_only_check` (`2026-10-09_guest_jobs_courier_assignment.sql:156,166`); P17 added `courier_registry_full_needs_approval_check` and `courier_registry_buffer_needs_since_check` (`2026-10-11_courier_registry_timing_checks.sql:127,137`). Seventeen columns and fifteen constraints today, per catalog check 14's expectation.

Reading the code against the decisions finds two things that would undo an operator check without anyone touching it. Both are designed around below.

- **The first "Start verification" tap would drop the courier out of buffer.** `courier_bind_piverify_session` resets status and the clock on every successful bind, `2026-10-08_courier_piverify_bind.sql:165-167`:

  ```
         buffer_since            = null,
         status                  = case when coalesce(r.paused_reason, '') = 'operator'
                                        then r.status else 'registered' end,
  ```

  An operator-checked courier has no bound session, so `decideKycStart` (`lib/courier-kyc.ts:94-99`) answers `create`, the route binds, and the courier is back at `registered` with no jobs. The file says the reset is on purpose (`:55-57`): it stops a new session's 30-day clock starting from an old one. That reason does not apply to a courier whose buffer comes from the check (10.4).

- **The ladder would lock them out on day 30 while PiVerify is still down.** `effectiveTier` refuses any buffer courier at 30 days from `buffer_since` (`lib/courier-ladder.ts:69-76`), computed on read (decision 7). With PiVerify unreachable there is no way to finish, so every operator-checked courier would stop on the same day of the month they were checked.

### 10.2 (a) Schema

Three columns on `public.courier_registry`, all `timestamptz null` or `text null`, added with `add column if not exists`, every existing row null:

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `operator_checked_at` | `timestamptz` | null | When the in-person check happened. Set once, by the function in 10.3, never changed after. |
| `operator_checked_by` | `text` | null | Who did it, as a role label, not a name. Today the only value is `founder`. |
| `operator_check_deadline` | `timestamptz` | null | The sunset deadline (10.6). Null until the founder starts the sunset. |

Four named checks, each guarded on `pg_constraint` by name as P13 and P17 do:

- `courier_registry_operator_checked_legacy_only_check`: `operator_checked_at is null or class = 'legacy'`. The mirror of `courier_registry_vouched_pioneer_only_check`: a Pioneer is vouched, never operator-checked, and a hand UPDATE cannot do either to the wrong class.
- `courier_registry_operator_check_pair_check`: `(operator_checked_at is null) = (operator_checked_by is null)`. Never a time without a who, or the reverse.
- `courier_registry_operator_checked_by_check`: `operator_checked_by is null or operator_checked_by in ('founder')`. A closed list, so no free text (and so no name) can land there. A second operator is a migration, not a typo.
- `courier_registry_operator_check_deadline_check`: `operator_check_deadline is null or operator_checked_at is not null`. A deadline belongs to a check.

No check ties the new columns to `status`, for the same reason P2 gave for its timing rules (`2026-10-08_courier_registry.sql:79-83`): the founder sets status by hand (decision 7), and a courier who was checked and later paused or approved keeps the record of the check.

After P18: twenty columns and nineteen constraints. Indexes unchanged.

Nothing on the table changes its grants: service_role already holds SELECT, INSERT and UPDATE table-wide (`2026-10-08_courier_registry.sql`, section 3), and the app never writes these columns.

### 10.3 (b) The check function

Name and signature: `public.courier_record_operator_check(p_courier_id uuid, p_checked_by text)`, returning `table (courier_id uuid, outcome text, status text, buffer_since timestamptz, operator_checked_at timestamptz)`.

Style. Owner only, like `courier_register_legacy`, `courier_issue_signin_code`, `courier_revoke_sessions` and `courier_register_pioneer`: `language plpgsql`, `security definer`, `set search_path = public, pg_temp`, EXECUTE revoked from `public, anon, authenticated, service_role` and granted to nobody (the pattern of `2026-10-08_courier_signin.sql:551-556`). The SQL editor runs as the owner; the app's service_role key cannot call it. It locks the courier row first, the way `courier_issue_signin_code` does (`2026-10-08_courier_signin.sql:282-284`, `select * into v_courier ... for update`). `courier_register_legacy` itself is an INSERT and locks nothing; it is the model for the privileges, not for the lock. Marked IDENTITY WRITE and ATTESTATION WRITE: founder review required.

Before the row lock, the function takes a transaction-level advisory lock with a fixed key, the same key `courier_start_operator_check_sunset` takes first (10.6). The two then run one after the other, so a check cannot commit in the gap after the sunset has picked its rows and land with no deadline, exempt for good.

Guards, in this order, after the lock. Every refusal raises, so a refused call writes nothing and the editor shows red:

| # | Condition | SQLSTATE | Message ends |
| --- | --- | --- | --- |
| 1 | `p_checked_by` null or not in the list (`founder`, decision 7) | 22023 | `bad_checked_by` |
| 2 | no row for `p_courier_id` | P0002 | `unknown_courier` |
| 3 | `shredded_at` set | 55000 | `shredded` |
| 4 | `class <> 'legacy'` | 55000 | `not_legacy` (a Pioneer is vouched with `courier_register_pioneer`, never checked) |
| 5 | `operator_checked_at` already set | none: not a refusal | returns `already_checked`, see re-run |
| 6 | any row of `courier_registry` has `operator_check_deadline` not null | 55000 | `sunset_started` (decision 6: once the sunset has started, no new checks) |
| 7 | `status <> 'registered'` | 55000 | `not_registered` (buffer, full and paused are all refused here) |
| 8 | `paused_reason` not null | 55000 | `paused` (an operator pause can sit on a registered row: the bind keeps it, `courier_piverify_bind.sql:166-169`) |
| 9 | `kyc_approved_at` not null | 55000 | `already_approved` (cannot coexist with `registered` today; checked anyway, since this function writes) |
| 10 | `piverify_status in ('rejected', 'failed')` | 55000 | `piverify_refused` (decision 5: a PiVerify refusal on the current session outranks a sight check) |
| 11 | no row in `public.courier_sessions` with this `courier_id` | 55000 | `never_signed_in` (decision 11) |

Guard 6 sits after guard 5, so a re-run on a courier checked before the sunset still answers `already_checked` rather than an error. It reads the sunset as started from the rows themselves (decision 3), with no flag of its own; 10.6 covers the case where the sunset finds no row to mark.

Guard 11 counts any session row, live, expired or revoked: a session row exists only once a code is redeemed, since `courier_sessions.code_id` is `not null` (`2026-10-08_courier_signin.sql:137-140`). It proves the code the founder issued reached the person, not that the session is still live. The sessions table is read, not locked; the lock order of item 5 (registry row first) is kept.

Each message starts `courier_record_operator_check:` and ends with the code word, so the probes and the founder can match it.

What it writes, in one UPDATE on the locked row, with RETURNING (invariant 8):

- `status = 'buffer'`
- `buffer_since = now()`
- `operator_checked_at = now()`
- `operator_checked_by = p_checked_by`
- `updated_at = now()`

`now()` is the transaction start, so `buffer_since` and `operator_checked_at` are equal to the microsecond. 10.5 relies on that. `courier_registry_buffer_needs_since_check` is satisfied by the same statement. Nothing else changes: no session, no code, no PiVerify column, no `vouched_at`.

Return value: one row, outcome `checked`, with the courier id and the status, `buffer_since` and `operator_checked_at` as written. The founder then reads the row back by id, which is invariant 8's second half; the read-back statement is drafted with the migration.

Re-run: guard 5 comes before the status guard on purpose. A second call on a checked courier writes nothing and returns one row with outcome `already_checked` and the stored values, whatever the status is now. It never moves `buffer_since` or `operator_checked_at`, so running it twice cannot restart a clock. A courier checked, then paused by hand, is not re-admitted by a re-run.

Guards it does not have, because they cannot be expressed in data (decision 4): that the founder met the rider and knows their phone. That is the founder's step before running it. The runbook, per courier: issue a sign-in code (`courier_issue_signin_code`) and have the courier sign in on the courier host; see the Ghana Card in person, sight only (10.11); then run the check, then the read-back.

### 10.4 (c) Once PiVerify works: `courier_apply_kyc_status` and `courier_bind_piverify_session`

The starting state: `status = 'buffer'`, `buffer_since = operator_checked_at`, no bound session, `piverify_status` null.

**The bind, on the first Start verification tap.** As written, it drops the courier to `registered` (10.1). P18 replaces the function, same signature, with one change to the UPDATE: when the row is operator-checked and in buffer through the check (`operator_checked_at is not null and status = 'buffer' and buffer_since = operator_checked_at`), `status` and `buffer_since` are left as they are, but only while the sunset deadline has not passed (`operator_check_deadline is null or now() < operator_check_deadline`). Past the deadline the bind resets the courier to `registered` as it does everyone, so a courier the ladder has already stopped gets the ordinary path whether or not the founder's hand pause (10.6) has landed yet: without that term, an unpaused courier past the deadline would keep `buffer_since = operator_checked_at` through `pending_review` (`:284-285`) and stay refused until `approved`, while a paused one would reset. Every other row behaves exactly as today, including the reset and the operator-pause rule. Its other guards are untouched: `already_full` (`courier_piverify_bind.sql:131-134`), `session_live` (`:141-147`), `bad_status` (`:155-158`).

**Then each status through `courier_apply_kyc_status`** (`2026-10-08_piverify_resubmission.sql`, six-argument function). The ranks and the forward check, `:244-266`, then the ladder, `:269-278`:

```
  v_status := v_courier.status;
  if coalesce(v_courier.paused_reason, '') <> 'operator' then
    if p_status = 'pending_review' and v_courier.status = 'registered' then
      v_status := 'buffer';
    elsif p_status = 'approved' then
      v_status := 'full';
    elsif p_status in ('rejected', 'failed') then
      v_status := 'paused';
    end if;
  end if;
```

and the clock, `:284-285`:

```
         buffer_since            = case when p_status = 'pending_review'
                                        then coalesce(buffer_since, now()) else buffer_since end,
```

| PiVerify says | Status after | `buffer_since` | Why |
| --- | --- | --- | --- |
| `created` | buffer | unchanged | the bind already stored `created` (rank 0), so a repeat is `not_forward` (`:255`); no ladder branch matches |
| `started` | buffer | unchanged | forward (1 > 0); no ladder branch matches |
| `pending_review` | buffer | unchanged | the branch needs `status = 'registered'`, which a checked courier is not; `coalesce` keeps the check time. **No fresh clock**: correct under 10.5 option B, a finding under option A |
| `approved` | full | unchanged | `:273-274`; `kyc_approved_at` set by `:286-287`; `paused_reason` nulled for full (`:295`) |
| `rejected` | paused, reason `rejected` | unchanged | `:275-276`, `:293-294`. Out of buffer, as decision 1 intends: the check never outranks a PiVerify refusal |
| `failed` | paused, reason `failed` | same as rejected | |

Flags:

1. **The bind reset**, above. Without the P18 change every operator-checked courier loses their jobs on the first tap. This is the one that matters.
2. **A rejection with RESUBMIT or APPEAL keeps the courier paused through the resubmission.** The reopened session moves `started` and `pending_review` forward again (`:241-253`), but `pending_review` only lifts `registered`, never `paused`, so they stay paused until `approved`. That is today's behaviour for every legacy courier, not new; open question 9.
3. **After a final rejection or failure, a new session puts them on the ordinary path.** The bind for that session sees `status = 'paused'`, not buffer, so it resets them to `registered` with `buffer_since` null as today. Their next `pending_review` gives a fresh `buffer_since` that is no longer equal to `operator_checked_at`, so the check stops counting for the ladder (10.5) while the record of it stays.
4. **Nothing in either function resets an operator-checked courier to `registered` other than the bind**, and nothing else drops them out of buffer other than a rejection, a failure, approval to full, or a hand pause.

### 10.5 (d) The 30-day window while PiVerify is down

Reader section 10 lists `status = 'buffer'` couriers 30 or more days past `buffer_since` (`scripts/dispatch-reader.mjs:970-1004`), and `effectiveTier` refuses them on read (`lib/courier-ladder.ts:75`). Three ways to treat an operator-checked courier:

- **A. No change.** The window applies from the check. On day 30 the ladder refuses them, section 10 lists them, and the founder pauses by hand. With PiVerify down they have no way back, so the check buys 30 days per courier, once. Simplest; makes decision 1 a one-month trial rather than an interim route.
- **B. Exempt until the sunset (recommended).** A courier is exempt from the 30-day window while they are in buffer through the check, that is `operator_checked_at is not null and buffer_since = operator_checked_at`. Their bound is the sunset deadline instead (10.6): no bound while `operator_check_deadline` is null, refused on read at and after it. Section 10 leaves them out: its first arm (buffer 30 days or more) gains `and buffer_since is distinct from operator_checked_at`, written without parentheses for the reader's guard, and its second arm (buffer with no `buffer_since`) is left as it is, since a null clock is never a clock from the check and the ladder refuses it either way. Section 12 lists them. The equality test is what keeps flag 3 in 10.4 honest: a courier who came back through PiVerify after a rejection is on the ordinary 30-day clock again.
- **C. Renewal by re-check.** The window applies, and the founder sees the courier in person again every 30 days and runs a renewal that moves `buffer_since`. Keeps one rule for everyone, but every renewal is a hand write that restarts a clock, and decision 2 then needs a record per visit.

Recommendation: **B.** The 30-day window bounds a courier waiting on a PiVerify review that is under way. An operator-checked courier is not waiting on anything Gyema or the courier can move until PiVerify authenticates, and decision 3 already names the bound that applies to them.

Code under B (build time): `LadderRow` gains `operator_checked_at` and `operator_check_deadline`, both optional so the Pioneer route, which reads `courier_find_pioneer`, passes neither. `effectiveTier` keeps every existing row of its table (`lib/courier-ladder.ts:47-58`) and adds one inside `buffer`: through the check, refused at or after the deadline, otherwise buffer. The courier accept route's `REGISTRY_COLUMNS` (`app/api/courier/jobs/accept/route.ts:56`) and `KYC_COLUMNS` (`lib/courier-kyc.ts:38`, which `/api/courier/me` reads) each gain the two columns. A missing or unparseable deadline fails closed only when the column is set; null means no sunset yet.

### 10.6 (e) The sunset

Tracked per row, in `operator_check_deadline` (10.2, decision 3), so the ladder, the courier page and the reader all read one stored fact.

A second owner-only function in P18: `public.courier_start_operator_check_sunset()`, no argument, returning `table (couriers_given_a_deadline integer, deadline timestamptz)`. Same style and privileges as 10.3. It first takes the same advisory lock as `courier_record_operator_check`, then sets `operator_check_deadline = now() + interval '30 days'` (decision 1: 30 days from when it is run) on every eligible row: `operator_checked_at` set, `operator_check_deadline` null, `shredded_at` null and `status <> 'full'`. It returns the count and the deadline, and the founder reads the rows back. The 30 is written once, in the function; the ladder, the page and the reader read the stored deadline and never the number.

Re-run: it touches only rows still without a deadline, and after the first run guard 6 of 10.3 stops any new check, so a second run normally sets nothing and returns 0. It never moves an existing deadline.

One gap, from reading the sunset as started from the rows: run when no row is eligible (no checked courier left in buffer or paused), it marks nothing, so guard 6 still reads not started and new checks stay possible. The function therefore refuses to run with no eligible row, with 55000 `no_eligible_couriers`, so a run either marks the sunset or says it could not. If every checked courier is already full or shredded at that point, there is nothing to sunset. Further checks are then the founder's choice, not something the data refuses.

Enforcement, three layers, none automatic in the sense of writing:

1. **On read, at once:** from the deadline, `effectiveTier` refuses the courier (10.5 B), so accept answers 403 `courier_not_active` and the page stops offering jobs. The same pattern as decision 7.
2. **Reader section 12** (10.8) flags every operator-checked courier past the deadline whose stored status still reads buffer.
3. **The founder's hand pause** of each one listed: `status = 'paused'`, `paused_reason = 'pending_timeout'`, guarded on the courier id and on `status = 'buffer'`, with RETURNING and a read-back. `pending_timeout`, not `operator`, on purpose: `decideKycStart` refuses only an `operator` pause (`lib/courier-kyc.ts:96`), so the courier can still finish PiVerify, and approval lifts a `pending_timeout` pause (`2026-10-08_piverify_resubmission.sql:270,295`; probed in item 3, notes line 158). The statement is drafted with the migration, with the bracketed pre-flight CLAUDE.md asks for.

**Runbook, per network, after PiVerify authenticates for Gyema's account:** on the same day, the founder sets `PIVERIFY_ENABLED=true` for Production in that network's Vercel project, redeploys, confirms the new Production deployment, and runs `courier_start_operator_check_sunset()` once, then the read-back. Same day, so the 30 days a courier has match the days PiVerify is open to them. After that, `npm run dispatch`, and the hand pause for each section 12 row past its deadline. There is no scheduler, as in decision 7.

### 10.7 (f) Trust and wording

**Anchoring and the trust bureau read `kyc_approved_at` only.** Neither is built yet: no code at `c8b5384` computes a trust record or an anchor leaf. The rule is already written where they will be built: `lib/courier-ladder.ts:15-18` ("FULL IS FULL FOR DISPATCH ONLY ... Anchoring and the trust bureau read kyc_approved_at only"), the `vouched_at` column comment (`2026-10-09_guest_jobs_courier_assignment.sql:172-173`), notes 6.10 (line 955), and the spec's launch record ("KYC approval event", `docs/anchoring-spec.md:54`), whose attestor byte `0x06` is PiVerify (`docs/anchoring-design-notes.md:177`). P18 adds the same sentence to the comments on `operator_checked_at` and on both new functions. The operator check is never an attestor, never a leaf, never a trust bureau event, and never a reason to show "verified".

What the courier sees today, from `app/courier/courier-panel.tsx`, with an operator-checked courier: Account "Starter (limited jobs)" (`:51`), Verification "Not started" (`:286`), and a "Start verification" button (`:311`). None of these says verified, and "Verified courier" (`:52`) is reachable for a legacy courier only through `kyc_approved_at`. Strings that would change or be added, each **COPY DRAFT** for the gyema-accuracy review:

**Superseded by 10.13.** The four drafts below are kept as designed, for the record. The approved wording is in 10.13; draft 3 changed, and drafts 1, 2 and 4 were approved as written.

1. **New line under the status card, while in buffer through the check.** COPY DRAFT: "You have starter access after an in-person check by Gyema. This is not identity verification. Full access needs verification through PiVerify."
2. **The lapsed line,** today "Your verification has taken longer than 30 days. Jobs are paused until it completes." (`courier-panel.tsx:329`, pinned in `tests/courier-view.test.ts:68`). For a courier stopped at the sunset deadline that is false. COPY DRAFT: "Starter access from the in-person check has ended. Jobs are paused until your verification through PiVerify is complete."
3. **While PiVerify is not enabled,** the Start verification tap would end in "We could not start verification just now. Try again in a few minutes." (`:77`), which promises a few minutes. Decision 10: the button is hidden whenever `/api/courier/me` reports `piverifyEnabled: false`, for every signed-in courier, checked or not, and this line is shown in its place. COPY DRAFT: "Verification through PiVerify is not open yet. Gyema will tell you on WhatsApp when it is." (Superseded by 10.13.)
4. **Once the sunset starts.** COPY DRAFT: "Complete your verification through PiVerify by {date} to keep taking jobs." The date only, in Accra time, no time of day.

`GET /api/courier/me` gains three fields: `operatorChecked` (boolean: in buffer through the check, the 10.5 test), `operatorCheckDeadline` (the deadline or null) and `piverifyEnabled` (boolean, below). Never `operator_checked_by`, and never the word "verified" in a field name. The status labels pinned in `tests/approved-copy.test.ts:92-94` do not change.

**PiVerify on or off (decision 10).** A new server-side environment variable, `PIVERIFY_ENABLED`:

- **Values.** Set for Production only, per network. Unset by default on both networks, and Preview and Development leave it unset. It is on only when it reads exactly `true`; unset, empty, `false`, `TRUE`, ` true` or anything else is off, so it fails closed. It is never `NEXT_PUBLIC_`: it is read on the server at request time, from one helper beside the other PiVerify config in `lib/piverify.ts` (`getBaseUrl` and `getApiKey`, `:34-48`). It is not a secret, but a change still needs a redeploy, as for any Vercel env change.
- **`GET /api/courier/me`** reports it as `piverifyEnabled`. `canStartKyc` also reads false while it is off, so the field keeps its contract: "whether POST /api/courier/kyc/start would act rather than refuse" (`app/api/courier/me/route.ts:29-35`). The page hides Start verification when `piverifyEnabled` is false and shows COPY DRAFT 3. While it is off the page does not poll `/api/courier/kyc/refresh` either.
- **`POST /api/courier/kyc/start`** refuses while it is off with 503 and reason `piverify_not_enabled`. **`POST /api/courier/kyc/refresh`** refuses with the same reason. Both refuse before any PiVerify call and before any registry read, at a new step in their ORDER lists: after `resolveCourier` (a signed-out caller still gets 401) and before the rate limit (so a refusal spends no limiter call). In `kyc/start/route.ts` that is after `:119`; in `kyc/refresh/route.ts`, after `:85`. The reason is new, so it is never confused with `verification_unavailable`, which means PiVerify was asked and failed. The panel maps it to COPY DRAFT 3 if a cached page taps the button anyway.
- **Not covered: `POST /api/kyc/webhook`.** It keeps its own gate, the signature over `PIVERIFY_WEBHOOK_SECRET`, which answers 500 `misconfigured` while the secret is unset (`app/api/kyc/webhook/route.ts:79-85`). It needs no second switch.

### 10.8 (g) Reader, view and catalog

**The view.** `courier_registry_dispatch` (P15) should carry `operator_checked_at` and `operator_check_deadline`: two times, no person. Not `operator_checked_by`: the reader has no use for it, and the view's rule is that it carries only what the reader lists. P18 replaces the view with columns 1 to 9 unchanged and the two appended as 10 and 11, restating `security_invoker = false` and repeating P15's revoke and grant (`2026-10-10_courier_registry_dispatch_view.sql:132-133`), since the view is automatically updatable. P15's own verification cell then reads false on "exactly 9 columns", as P2's does after P9; check 9 is the live truth. P15 is applied on Testnet, so this has to be a new file, not an edit of P15.

**The reader** (`scripts/dispatch-reader.mjs`):

- `REQUIRED_COLUMNS.courier_registry_dispatch` gains the two columns, with `COLUMN_SOURCES` naming P18, so the reader refuses to run until P18 is in.
- Section 10's where clause, as in 10.5 B.
- A new section 12, "OPERATOR-CHECKED COURIERS", appended so no section is renumbered (the reader's own rule, `:1067-1071`). From the view: operator-checked, not shredded, not `full`. One row per `courier_ref`, with `status`, `operator_checked_at`, `operator_check_deadline`, `buffer_since`, `piverify_status` and `paused_reason`. Flags: no deadline yet (sunset not started); past the deadline with status still buffer (due a hand pause, `pending_timeout`); in buffer through PiVerify rather than the check; and an alarm, expected empty, for a checked courier with no deadline while another row has one, which the shared advisory lock (10.3, 10.6) should make impossible.
- The dry run's statement count, 19, becomes 20 (`:1662-1664`).
- Unrelated, found while reading: `DECLARED_GUEST_STATUSES` (`:184-191`) lacks `pending_quote`, which `lib/guest-jobs.ts:7-14` now carries. Recorded here; a separate fix.

**Catalog checks** (`docs/catalog-checks.sql`):

- **Check 9:** new `2026-10-12 operator check` rows: each of the three columns with its type; each of the four constraints, validated; both functions present, security definer, `search_path` pinned; service_role cannot execute either, from both `has_function_privilege` and the ACL, as the P11 and P13 rows do; the bind function's body carries the keep-buffer clause; the view's columns 10 and 11. The existing P15 row "courier_registry_dispatch column 9 is piverify_allowed_action, the last of 9 columns" is amended to drop "the last of 9", or it reads false after P18.
- **Check 7:** both new function names added to its list.
- **Check 14:** the expectation text gains the P18 step: twenty columns, nineteen constraints. `timing_rule_breaks` gains two counts: `operator_checked_buffer_past_deadline` (status buffer through the check and past the deadline: information, a hand pause due) and `operator_checked_not_legacy` (can only read zero after P18).
- **Check 12:** unchanged, still exactly one row, since both functions are owner only.
- **Check 11 and check 3:** the view's column count, and gyema_reader SELECT alone, unchanged in form.

### 10.9 (h) Tests and Docker probes, at build time

Vitest, with no database:

- Migration text pins, in the style of `tests/piverify-webhook-guards.test.ts`:
  - the guard order of 10.3: the advisory lock, the row lock, then guards 1 to 11, then the one UPDATE;
  - the UPDATE writes exactly the five columns;
  - the re-run branch sits before `sunset_started` and before the status guard;
  - `never_signed_in` reads `courier_sessions` by `courier_id` and takes no lock on it;
  - both functions take the same advisory lock key, each as its first statement;
  - the sunset function has no parameter, and its deadline is `now() + interval '30 days'`, the only place the 30 is written;
  - `no_eligible_couriers` is raised before any UPDATE;
  - the revoke from all four roles and no grant, for both functions;
  - the bind's keep-buffer clause, and that the bind's other branches are byte-for-byte as P12.
- `PIVERIFY_ENABLED`:
  - the helper is true only for exactly `true`, and false for unset, empty, `false`, `TRUE`, `1`, `yes` and ` true`;
  - no file under `app/` or `components/` reads it except through the helper, and no `NEXT_PUBLIC_PIVERIFY_ENABLED` exists anywhere.
- `/api/courier/kyc/start` and `/api/courier/kyc/refresh`, with it off:
  - 503 `piverify_not_enabled`;
  - no PiVerify fetch is made, no registry read, no limiter call, no RPC;
  - a signed-out caller still gets 401 and an off-surface request still gets 404, before the switch is read.
  - With it on, every existing route test passes unchanged.
- `/api/courier/me`: `piverifyEnabled` reported both ways; `canStartKyc` false whenever it is off, for every row `decideKycStart` would answer `continue` or `create`.
- The panel, with `piverifyEnabled` false: no Start verification or Continue verification button, COPY DRAFT 3 shown, and no refresh poll started. The reason `piverify_not_enabled` maps to COPY DRAFT 3.
- `effectiveTier`: every existing row of its table unchanged; through the check with no deadline is buffer on day 31, day 365; at and after the deadline is none; `buffer_since` not equal to `operator_checked_at` falls back to the 30-day rule; an unparseable deadline fails closed; the Pioneer route's row without the fields behaves as today.
- `/api/courier/me` and `/api/courier/jobs/accept`: the new columns are read, `operator_checked_by` is never selected or returned, and the two new fields.
- The panel: the COPY DRAFT lines once approved, and that no rendered string on the courier page contains "verified" for a courier who is not `full`.
- The reader: section 12's statement passes `assertReadOnlySql`; section 10's new clause; the dry run counts 20.

Docker, on a throwaway `postgres:17-alpine` with the item 6 fixture's roles (anon, authenticated, service_role, gyema_reader), over the real P2, P9, P11, P12, P13, P15, P17 and then P18. Positive:

- A registered legacy courier who has redeemed a code is checked: status buffer, the two times equal, `checked`, and the read-back agrees. A revoked or expired session still counts for guard 11.
- A re-run returns `already_checked` and changes nothing, `updated_at` included.
- The bind keeps a checked courier in buffer before the deadline, resets a checked courier past the deadline to `registered` (paused by hand or not), and still resets an unchecked one exactly as before.
- `courier_apply_kyc_status` through `created`, `started`, `pending_review`, `approved`, `rejected` and `failed`, each from the checked state, matches the 10.4 table; a rejected-then-rebound courier lands at `registered` with a `buffer_since` that no longer equals the check.
- The sunset function, called with no argument, sets every eligible row's deadline to the same value, 30 days after its `now()`. A re-run sets none and returns 0, and moves no deadline. `full` and shredded rows get none.
- A re-run of the check on a courier checked before the sunset still returns `already_checked` after it.
- Two sessions, one running the check and one the sunset, with the check held open: the sunset waits on the advisory lock. After both commit, the newly checked courier either has a deadline or was refused `sunset_started`, never neither.
- gyema_reader reads columns 10 and 11 and cannot read `operator_checked_by`; the reader's section 12 statement, run as gyema_reader, lists the right rows.

Negative, each with the SQLSTATE expected:

- Pioneer refused (`not_legacy`, 55000).
- Buffer refused, full refused, paused refused (`not_registered`, 55000), for unchecked couriers.
- Registered with an operator pause refused (`paused`).
- Shredded refused; unknown id refused (P0002).
- `p_checked_by` null, empty, `Founder` or a name refused (22023).
- A courier whose current session is rejected or failed refused.
- service_role cannot execute either function (42501); neither can anon or authenticated.
- A hand UPDATE setting `operator_checked_at` on a Pioneer (23514), a time without a who (23514), a deadline without a check (23514), `operator_checked_by = 'someone'` (23514).
- After the sunset has started, a check on any new registered legacy courier refused (`sunset_started`, 55000), and nothing written.
- A registered legacy courier with no `courier_sessions` row (a code issued but never redeemed, or never issued) refused (`never_signed_in`, 55000).
- The sunset function with no eligible row refused (`no_eligible_couriers`, 55000), nothing written, and guard 6 still reads not started.
- `courier_start_operator_check_sunset(30)`, or any argument, fails: there is no such signature (42883).
- P18 run without P17 or P15 stops at its guard and writes nothing; P18 run twice reads `all_present` true both times.

### 10.10 (i) Deploy order

**P18:** `db/migrations/2026-10-12_courier_operator_check.sql`. One file: the columns, the four checks, both functions with their revokes, the bind replaced, the view replaced, and an `all_present` verification as the last statement. Its row in `docs/deploy-order.md`, drafted:

> | P18 | Operator-checked buffer | `db/migrations/2026-10-12_courier_operator_check.sql` | Phase 1 item 10 (founder decisions 12 Oct 2026). Needs P2, P9, P12, P13, P15 and P17; the guard stops the file if any is missing. Adds `courier_registry.operator_checked_at`, `operator_checked_by` and `operator_check_deadline` with four named checks, `courier_record_operator_check(uuid, text)` and `courier_start_operator_check_sunset()` (owner only, executable by no role, service_role included; the sunset sets a 30-day deadline and takes no argument), replaces `courier_bind_piverify_session` so a checked courier keeps buffer on the first bind, and appends columns 10 and 11 to `courier_registry_dispatch`. Writes no row. Apply BEFORE the item 10 code deploys: the accept route and `/api/courier/me` name the new columns, so until they exist every courier accept and every courier page load answers 503. Last statement is its verification: `all_present` true. Then the catalog check: the `2026-10-12 operator check` rows in check 9 true, check 7 showing both functions with the owner alone, check 12 still exactly one row, check 14 at twenty columns and nineteen constraints. P15's own cell now reads false on its column count. **Never re-run P12 after P18:** it restores the bind that resets a checked courier to registered (re-running P18 fixes it); the P12 row gains the same sentence, as P5's row carries one for P9. Then the item 10 code, then the reader. `PIVERIFY_ENABLED` stays unset when the code deploys, so Start verification stays hidden and the two KYC routes refuse; it is set to `true` only on the day PiVerify authenticates, with a redeploy, and `courier_start_operator_check_sunset()` is run the same day (10.6). Testnet first; Mainnet only once P2 to P17 are in there, and on a go-ahead. |

Order per network: (1) P18 and its catalog check. (2) The item 10 code deploy, and the merge gate (main fast-forwards and a new Production deployment). (3) The reader from the item 10 commit. (4) The first checks, by hand, one courier at a time, each after the courier has signed in once, each with a read-back. `PIVERIFY_ENABLED` is left unset throughout. (5) Later, once PiVerify authenticates: the same-day runbook in 10.6. The reverse order breaks the courier host: code before P18 is a 42703 on every registry read.

**Testnet:** every prerequisite is applied: P2 and P9 (`docs/deploy-order.md:32-36`), P12 (notes line 978), P13 (notes line 1045), P15 (founder, 12 Oct 2026) and P17 (`docs/deploy-order.md:39-41`). P18 can follow once approved.

**Mainnet:** nothing from Phase 1 is applied (`docs/deploy-order.md:36`, and the P17 row at `:65`), so P18 queues behind P2 to P17 there, on its own go-ahead.

**Mainnet hand-apply list,** from the scan `pinet\.com|Testnet|testnet|8841|3681` run on the files item 10 would touch:

- Hits, so hand-applied onto Mainnet's own version: `scripts/dispatch-reader.mjs` (4 hits, all comments or messages; its own header says it stays byte identical, so expect the hand-applied result to match by hash), `docs/catalog-checks.sql` (5), `docs/deploy-order.md` and `docs/anchoring-phase1-notes.md`.
- No hit, so byte-identical with the blob-hash gate: `lib/courier-ladder.ts`, `lib/courier-kyc.ts`, `app/api/courier/me/route.ts`, `app/api/courier/jobs/accept/route.ts`, `app/courier/courier-panel.tsx`, `app/courier/courier-view.ts`, `lib/piverify.ts`, `app/api/courier/kyc/start/route.ts`, `app/api/courier/kyc/refresh/route.ts` (0 hits each) and the P18 file itself, which must be scanned again once written.
- Not touched: `components/listing-detail-sheet.tsx`, `app/layout.tsx`, `app/send/page.tsx`, `public/privacy.html`, CLAUDE.md.

### 10.11 (j) Data protection (Data Protection Act 2012, Act 843)

Not legal advice; the spec already flags registration with the Data Protection Commission for counsel to confirm (`docs/anchoring-spec.md:56`).

**Stored:** when the check happened (one timestamp), who did it (a role label from a closed list, today `founder`), and later a deadline. On a row whose only other identifier is a random id and a salt (`2026-10-08_courier_registry.sql:41-45`). None of the three names the courier, and none says anything about their card.

**Not stored, anywhere in Gyema's systems:** the Ghana Card number, a photo or scan of the card, the name or date of birth on it, its expiry, its serial, a description of it, whether the face matched, or any note about the document. The check's purpose is limited to admitting the courier to buffer, and the record is limited to the fact that it happened.

**Sight only (founder, 12 Oct 2026):** the founder does not photograph, copy or forward the courier's ID by any means; the check is sight only.

**What the founder must not record anywhere,** in or out of the app:

- The card number or a photo of the card, in WhatsApp, in phone notes or the camera roll, in a spreadsheet, in this repository, in a GitHub issue or commit, or in these notes.
- Anything about the card in the Supabase SQL editor: query text is kept in its history and saved snippets, so the function is called with the courier id and `founder` and nothing else, never with a comment naming the person.
- The pairing of a courier reference with the person's name in any shared place. The 5.1 note (courier reference beside the WhatsApp contact) stays on the founder's phone, as item 5 already has it.

**The courier is told** what is kept: that Gyema records the date of the in-person check, and nothing from the card. That sentence belongs in the courier-facing privacy text at build time, as a COPY DRAFT. `public/privacy.html` is network-specific and would be hand-applied.

**Shredding.** `courier_shred` (item 9) is not built. The three columns identify no one, so keeping them on a shredded row keeps history's shape without linking it to anyone; open question 8.

### 10.12 (k) Open questions for the founder

1. **The sunset length,** in days (decision 3). The function accepts 1 to 90.
2. **The 30-day window:** A, B or C (10.5). B is recommended.
3. **Sunset tracking:** a per-row `operator_check_deadline` set by one function (recommended, 10.6), or a single date in code, which needs a deploy to start and cannot be read by the reader without a new parser.
4. **One file or two:** P18 as one file (recommended), or the view replacement split into its own P18b.
5. **A PiVerify refusal:** should a courier whose current session is `rejected` or `failed` be refused a check (guard 9, recommended), and should an earlier refused session count too? None exists today, since PiVerify has never authenticated.
6. **Checks after the sunset starts:** refuse new checks once any deadline is set, or give a new check the deadline at once.
7. **Who:** `founder` as the only `operator_checked_by` value. Any second person is a migration.
8. **Shredding:** keep the three columns on a shredded row (recommended, they identify no one), or null them in `courier_shred`.
9. **Resubmission:** an operator-checked courier rejected with RESUBMIT or APPEAL stays paused until approval (10.4 flag 2), as every legacy courier does today. Keep, or let a resubmission in progress restore buffer.
10. **The Start verification button while PiVerify is down:** hide it for a courier in buffer through the check and show COPY DRAFT 3 (recommended), or keep the button and its error.
11. **Signed in first:** should the check require the courier to have redeemed a sign-in code at least once (a row in `courier_sessions`), so the founder knows the code reached the person they met?
12. **Undo:** no function to undo a check (recommended); a mistaken check is answered with a hand pause, `paused_reason = 'operator'`. Or a revoke function.
13. **The COPY DRAFTs** in 10.7 and 10.11, for the gyema-accuracy review.

**Founder decisions on Item 10, 12 October 2026,** one per question above:

1. Sunset length: 30 days from when courier_start_operator_check_sunset is run.
2. 30-day window: option B.
3. Sunset tracking: per-row operator_check_deadline set by the owner-only function.
4. One file: P18.
5. Refuse a check when the courier's current PiVerify session is rejected or failed.
6. Refuse new checks once the sunset has started.
7. founder is the only allowed operator_checked_by value.
8. courier_shred keeps the three fields.
9. Resubmission: keep today's rule (rejected stays out of buffer until approved).
10. Hide Start verification while PiVerify is unavailable (COPY DRAFT 3).
11. The check requires the courier to have redeemed a sign-in code at least once.
12. No undo function; a mistaken check is answered by a hand pause with paused_reason = 'operator'.
13. Copy review at build time with the gyema-accuracy checklist.

### 10.13 Copy approved, 12 October 2026

The founder approved the item 10 copy on 12 October 2026, after the gyema-accuracy review (decision 13). These strings supersede the COPY DRAFTs in 10.7. Each is marked "Copy approved 12 Oct 2026 (item 10)." where it is defined, and no COPY DRAFT marker is left in the code.

1. **Under the status card, while in buffer through the check** (`OPERATOR_CHECK_LINE`, `app/courier/courier-view.ts`): "You have starter access after an in-person check by Gyema. This is not identity verification. Full access needs verification through PiVerify." As drafted.
2. **The lapsed line for a courier stopped at the sunset deadline** (`OPERATOR_CHECK_ENDED_LINE`): "Starter access from the in-person check has ended. Jobs are paused until your verification through PiVerify is complete." As drafted.
3. **In place of the verification button while PiVerify is not enabled** (`PIVERIFY_NOT_OPEN_LINE`): "Verification through PiVerify is not open yet. Gyema will let you know when it opens." Changed from draft 3, whose second sentence read "Gyema will tell you on WhatsApp when it is."
4. **Once the sunset starts** (`OPERATOR_CHECK_DEADLINE_TEMPLATE`): "Complete your verification through PiVerify by {date} to keep taking jobs." As drafted. `{date}` is the deadline, the date only, in Accra time, no time of day.
5. **The welcome sheet's Stay safe line** (`components/welcome-sheet.tsx`): "Gyema connects users. Payments and coordination happen on Pi Chat or WhatsApp."

**Removed from the Stay safe line:** "Verify identity via Pi KYC before sending valuables." **Why:** it told users that a Pi sign-in stands for a KYC check, and that is not established. `/v2/me` returns no KYC status, and sign-in as proof of KYC is an unverified assumption (`docs/anchoring-spec.md:64`, gate 4). Couriers are verified through PiVerify, so no visible string may point users to Pi KYC instead. The dash after "connects users" was also replaced by a full stop, under the no em-dash rule.

**Pins.** `tests/operator-check.test.ts` holds the four item 10 strings exactly. `tests/approved-copy.test.ts` holds the Stay safe line, fails on any COPY DRAFT marker left under `app/`, `components/`, `lib/`, `scripts/` or `middleware.ts`, and fails if "via Pi KYC" appears in any user-facing string.

**Not covered by this approval:** the courier-facing privacy sentence in 10.11 (the date of the in-person check is kept, nothing from the card). It is not built, and `public/privacy.html` is unchanged.
