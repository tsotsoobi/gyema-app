# Anchoring and courier trust bureau: Phase 0 design notes

Phase 0 output for `docs/anchoring-brief.md`. Read only: no code, no SQL run, no database touched.

- Repository: `tsotsoobi/gyema-app` (Testnet), confirmed with `pwd` and `git remote get-url origin`.
- Branch: `feat/anchoring-design`, cut from `main` at `f4d1032`.
- Date: 8 Oct 2026.
- Line numbers refer to the tree at `f4d1032` unless a commit is named.

Each claim below was checked against code and migration files in this repository. None was checked against a live database. Where a claim depends on live schema or grants, a catalog query is given for the founder to run. Agents do not run them.

---

## 1. Verification of the twelve claims

| # | Claim | Evidence (file:line) | Verdict |
| --- | --- | --- | --- |
| 1 | Guest delivery closes only inside `guest_stamp_delivery` once both stamps land, and every job accepted since the delivery-code feature has a code minted at accept. | `db/migrations/2026-08-13_delivery_code.sql:156-163` is the only place `status = 'delivered'` is written, and only when `v_by = 'sender+courier_code'`. `:142` returns early for an uncoded row. In app code, `delivered` is only ever read (`app/api/guest/confirm-delivery/route.ts:228`). The code is minted in the same UPDATE as the claim: `app/api/guest/accept/route.ts:103-110`. That route is the only code path that writes `status: "accepted"` (`:107`) or `assigned_courier` (`:108`). | **Confirmed in code**, with a caveat. Code cannot rule out an operator assigning a job by hand in SQL without a code. `scripts/dispatch-reader.mjs:906` and `:1380` are the existing detectors for `delivered` rows whose stamp is not `sender+courier_code`. Those are exactly the rows Gate 2 must exclude. **Stale comment:** `2026-08-13_delivery_code.sql:208-217` says nothing in the app writes `in_transit` and speculates about an outside trigger. `confirm-pickup/route.ts:89` now writes `in_transit`. Per CLAUDE.md, nothing in code moves an uncoded job to `delivered`, and that comment should not be read as evidence of a trigger. |
| 2 | Uncoded older guest jobs close on one sender stamp and are never set to `delivered` by the app. | `app/api/guest/confirm-delivery/route.ts:184-203`: the uncoded branch writes `delivery_confirmed_at` and `delivery_confirmed_by: "sender"` only, with no status column in the UPDATE. `:113-116` refuses a courier stamp on an uncoded job (`no_code`). | **Confirmed.** Any uncoded row reading `delivered` was set by hand (F14). |
| 3 | `confirm-pickup` moves a job from accepted to in transit on the sender's last-4 stamp. | `app/api/guest/confirm-pickup/route.ts:61-73` (last-4 guard), `:79-81` (must be `accepted`), `:84-96` (UPDATE sets `pickup_confirmed_by: "sender"`, `status: "in_transit"`, guarded on `status = 'accepted'` and `pickup_confirmed_at is null`). | **Confirmed.** Note `:76-78`: a row already stamped returns early and is never flipped. `:23-25` says such rows need one hand flip, so the pickup leaf must come from this UPDATE's return, never from a status read. |
| 4 | Pioneer completion closes inside `listing_confirm_completion`, with the party derived server side. | `db/migrations/2026-08-14_listing_completion_rls.sql:276-394`. The party is derived from the row at `:307-321`. There is no role parameter (`:223-226`). `completed` is written only in the CASE at `:369-373` / `:383-386`. The route passes the session pi_uid only: `app/api/listings/confirm-completion/route.ts:61-71`. | **Confirmed in code.** Two caveats. (a) `:69-82` leaves `status` writable by `authenticated`, so a row can read `completed` without the RPC. Only the RPC's returned row may produce a leaf, and `:595-608` is the detector for the rest. (b) Listings store parties by `pi_uid` (`app/api/listings/accept/route.ts:49`), which rotates on Testnet (invariant 7). The Pioneer leaf writer should take `caller.pi_username` from `resolveCaller` at completion time (`confirm-completion/route.ts:61-63`), so no join through `pi_uid` is needed. Whether the Mainnet database has this function is Gate 1, a founder catalog check (`check_06_functions`, `check_07_function_acls` in `docs/catalog-checks.sql`). |
| 5 | There is no courier registry. Guest jobs store `pi_username` in `assigned_courier`; listings store the matched party by uid. Nothing in code references `couriers` or `legacy_couriers`. | `app/api/guest/accept/route.ts:108` (`assigned_courier: caller.pi_username`). `app/api/listings/accept/route.ts:49` (`matched_with_user_id: caller.pi_uid`). `git grep` finds no `.from("couriers")` or `.from("legacy_couriers")` anywhere. The only mentions are as unreferenced tables: `db/migrations/2026-09-07_grant_baseline.sql:28-30` (couriers on both networks, `legacy_couriers` on Testnet only) and `docs/catalog-checks.sql:39-44`, `:455` (`check_13_unreferenced_tables`). | **Confirmed in code on `main`.** One exception off `main`: commit `ed98f9f` writes to `legacy_couriers` (`app/api/kyc/webhook/route.ts:72-76` in that commit), so cherry-picking it re-introduces a reference to an orphan table (see claim 11). The tables' live shape and grants are unknown to me. The founder can read them with `check_13_unreferenced_tables`. |
| 6 | Every courier-facing route resolves identity through `resolveCaller` from a Pi session, so a courier without a Pi account cannot act at all. | `resolveCaller` reads `app_metadata.pi_uid` and `pi_username` and refuses without them (`lib/route-auth.ts:152-159`). Every route that acts calls it: `guest/accept:82`, `guest/mine:107`, `guest/confirm-delivery:128` (courier path), and all listings and payments routes. | **Confirmed for every route that acts.** Two courier-facing routes are public reads with no session: `app/api/guest/open/route.ts:16-39` (the job board) and `app/api/guest/track/route.ts`. A legacy courier can already see the board. Buffer enforcement therefore cannot rely on the board being gated. It must live in accept. |
| 7 | `lib/pi-platform.ts` states that `/v2/me` returns no KYC status. | `lib/pi-platform.ts:21-24`. Primary source agrees: Pi's `platform_API.md` UserDTO (lines 193-211 of the copy fetched 8 Oct) carries `uid`, `credentials.scopes` and optional `username`, and no KYC field. | **Confirmed.** The same comment also says "We treat a successful /v2/me response as proof of Pi-KYC verification", which is the unverified assumption Gate 4 rejects. The assumption is also in shipped copy and docs: `components/profile-tab.tsx:241` ("Verified by Pi Network: Gyema relies on Pi's KYC verification...") and `README.md:97` ("The real auth gate is Pi KYC"), and `app/api/auth/verify/route.ts:3` calls itself "The Pi-KYC gate". Listed here only; not edited. |
| 8 | There is no parcel value field on `guest_jobs`; `quote_cedis` is the delivery fee. | The insert at `app/api/guest/create/route.ts:200-219` writes no value field. `GuestCreateBody` (`lib/schemas.ts:272-287`) has none. `quote_cedis` is computed from the two areas (`create/route.ts:217`, `lib/guest-pricing.ts:70-72`), and `lib/guest-commission.ts` takes its 7.5% of it (`:24`). | **Confirmed in code.** Live columns were not checked. Founder query: `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'guest_jobs' order by ordinal_position;` |
| 9 | Off-list free-text corridors exist (`pending_quote`). | `app/api/guest/create/route.ts:151-153` (off-list skips the area check), `:217-218` (`quote_cedis` null, `status: "pending_quote"`). Read by `scripts/dispatch-reader.mjs:348-350`, `:386-388`. | **Confirmed.** Two details matter for buffer enforcement. `offList` is not stored on the row, and nothing in code moves `pending_quote` to `posted`; the operator does it by hand. After that, a job with off-list areas sits on the board as `posted` with a quote. `pending_quote` is also missing from the `GuestJobStatus` union (`lib/guest-jobs.ts:7-13`), a known gap noted at `dispatch-reader.mjs:855`. |
| 10 | Tracking IDs are `GYM-` plus 3 random bytes. | `app/api/guest/create/route.ts:65-67` and `app/api/listings/create/route.ts:114`: `GYM-${randomBytes(3).toString("hex").toUpperCase()}`. | **Confirmed.** That is 16,777,216 values, so salting is required, as the spec says. Note that the validator `lib/schemas.ts:46` accepts `[A-Z0-9]{6}`, which is wider than hex. That is harmless for anchoring, but the job hash must be computed over the stored `tracking_id` exactly. |
| 11 | `ed98f9f` on `feat/piverify-sandbox` cherry-picks cleanly onto current `main`; its webhook signature has no timestamp and its status writes have no ordering. | `git merge-tree --write-tree --merge-base=ed98f9f~1 f4d1032 ed98f9f` exits 0 (clean tree `51a96b3`). The commit adds 2 files (`lib/piverify.ts`, `app/api/kyc/webhook/route.ts`, 267 lines). The signature is HMAC-SHA256 over the raw body only, with no timestamp input (`lib/piverify.ts:147-163`). The webhook writes `kyc_status` straight from the payload with no current-status guard (`webhook/route.ts:58-76`), ignores `event.id` (no dedupe), and re-stamps `kyc_verified_at` on every replayed `approved` (`:68-70`). `git diff --shortstat f4d1032 origin/feat/piverify-sandbox` reports 104 files changed, 907 insertions, 21,155 deletions. | **Confirmed.** The patch applies cleanly; I did not run a build on it. The drill commits `de625a0` and `56b2297` sit above it and are excluded. Retargeting is needed whatever hardening is chosen: the webhook writes `legacy_couriers`, which decision 1 retires, and `lib/piverify.ts:14-16` describes Pioneers as KYC-verified by Pi Browser sign-in, which contradicts Gate 4. |
| 12 | The only cron is daily, behind a `CRON_SECRET` bearer check, and there is no Stellar SDK dependency. | `vercel.json` has one cron, `/api/cron/expire-stale-listings`, at `0 0 * * *`. The bearer check is at `app/api/cron/expire-stale-listings/route.ts:33-42`. `package.json` has no `stellar` dependency, and `package-lock.json` has 0 matches. `lib/schemas.ts:57` validates a Stellar tx hash string only. | **Confirmed**, with two notes. (a) `route.ts:3` says "(hourly)"; `vercel.json` is authoritative and the comment is stale. (b) The bearer check runs only when `VERCEL === "1"` (`:33`). A new `/api/cron/anchor` copying this pattern inherits that, so it would be unauthenticated in any non-Vercel host. |

### CLAUDE.md invariant 1 wording (flag only; CLAUDE.md not edited)

`CLAUDE.md` line 37 says identity is derived from `admin.auth.getUser` "reading `user_metadata.pi_uid`". The code reads `app_metadata` and refuses to fall back: `lib/route-auth.ts:135-159`, stamped at `app/api/auth/verify/route.ts:250-256`, with RLS moved over in `db/migrations/2026-09-07_identity_from_app_metadata.sql`. Proposed wording:

> 1. **Identity for sensitive operations is derived server-side** from `admin.auth.getUser` reading `app_metadata.pi_uid` and `app_metadata.pi_username`, which only the service_role key can write (stamped by `/api/auth/verify`). Never `user_metadata`, which the user can write, and no fallback to it. No route, RPC, or client function takes a role, party, or side argument. Re-introducing one is the F17 defect.

If legacy couriers get a second identity type (decision 2), this invariant will need a second sentence naming that identity's server-side source.

A second, smaller CLAUDE.md drift: "Off-list area inputs are stored untrimmed (`app/api/guest/create/route.ts`, fix queued)." `areaName` now trims (`lib/schemas.ts:94`) and the route says so (`create/route.ts:122-128`). The fix appears to be shipped. Rows written before it still carry whitespace, so the bracketed pre-flight rule still stands.

---

## 2. Facts established outside the repository (read only, 8 Oct 2026)

| Fact | Source | Value |
| --- | --- | --- |
| Pinet host in a normal browser | `curl` with an Android Chrome user agent to `https://gyema3681.pinet.com/send`, `/track/GYM-000000`, `/send?probe=abc123` | All three return 200, but the HTML is a **PiNet wrapper page** (`x-middleware-rewrite: /tpa/gyema3681/send`; header links "Download Pi Browser", "What is PiNet"). It holds an `<iframe title="PiNet" src="https://gyema-app.vercel.app/send">`. The query string reaches the wrapper's own payload but **not the server-rendered iframe `src`**, which matches `app/track/[id]/page.tsx:3-5`. I did not test whether wrapper script adds it later in the browser. I did not probe the Mainnet host. |
| Pi network passphrases | Horizon root, `api.testnet.minepi.com` and `api.mainnet.minepi.com`; also `pi-apps/pi-nodejs` README line 149 | `Pi Testnet` and `Pi Network`. |
| Pi core versions | Horizon root | Testnet `v28.0.1`, protocol 28. Mainnet `stellar-core 27.1.0`, protocol 27. The two networks are on different protocols. |
| Fee and reserve | Horizon `/fee_stats` and latest ledger, both networks | Base fee 100,000 stroops = 0.01 Pi per operation (this confirms the spec's assumption as of today). Base reserve 4,900,000 stroops = 0.49 Pi, so an account's minimum balance is 0.98 Pi before subentries. |
| Pi's own server SDK | `pi-apps/pi-nodejs` `package.json`, `src/index.ts:204-233` | Uses `@stellar/stellar-sdk ^13.2.0`, `fetchBaseFee()`, `Operation.payment` with `Memo.text`. There is no example of `bumpSequence` or `Memo.hash`. |
| Vercel Hobby cron | vercel.com/docs/cron-jobs/usage-and-pricing (last updated 2026-07-15) | "Hobby accounts are limited to cron jobs that run once per day", with per-hour precision (plus or minus 59 minutes). An hourly expression fails deployment. |
| Twilio SMS to Ghana | twilio.com/en-us/sms/pricing/gh, read 8 Oct 2026, no effective date shown | USD 0.3741 per outbound segment. |
| WhatsApp authentication template, Ghana | Meta pricing pages searched | **Not found.** Rate card download needed. |

---

## 3. The nine design decisions

Options and trade-offs only. No choice is made here.

### Decision 1: Courier table

**Common shape for every option** (the brief's field list, plus what the code review showed is needed):

```
couriers_v2 (name open, see below)
  id                     uuid primary key default gen_random_uuid()
  class                  text not null check (class in ('pioneer', 'legacy'))
  status                 text not null check (status in ('registered', 'buffer', 'full', 'paused'))
  commitment_salt        bytea null (32 random bytes; set at insert, nulled only by shredding)
  pi_username            text null, unique where not null   -- Pioneer link, invariant 7
  piverify_session_id    text null
  piverify_status        text null check (in PiVerify's six values)
  piverify_status_at     timestamptz null   -- ordering for decision 8
  buffer_since           timestamptz null   -- start of the 30-day clock
  kyc_approved_at        timestamptz null
  paused_reason          text null check (in 'rejected', 'failed', 'pending_timeout', 'operator')
  created_at, updated_at timestamptz not null default now()
  shredded_at            timestamptz null
```

- **Why `pi_username` and not a foreign key to `pioneers`.** `public.pioneers` already carries `pi_username` (`lib/supabase-admin.ts:204-211`), but the comment at `:207-208` says several rows per username are currently possible, and a `UNIQUE(pi_username)` constraint there is a pending follow-up. A foreign key needs that constraint first. The options are to (a) add the unique constraint to `pioneers` first, then FK to it, or (b) store `pi_username` here with its own partial unique index and no FK. Option (b) does not depend on `pioneers` being cleaned up first.
- **What `assigned_courier` holds for a legacy courier.** Today the column holds a `pi_username` (`guest/accept:108`) and is matched on it (`guest/mine:116`, `confirm-delivery:131`). A legacy courier has no username. Options: (i) add `guest_jobs.assigned_courier_id uuid` referencing the new table and keep `assigned_courier` for Pioneers; (ii) write a prefixed string such as `legacy:<uuid>` into `assigned_courier`. Option (ii) needs no migration on `guest_jobs`, but it mixes two namespaces in one text column, and a Pi username that happens to match the format would collide. Option (i) costs a migration on `guest_jobs` and keeps one meaning per column.
- **Name.** `couriers_v2` versus a fresh name such as `courier_registry`. A fresh name avoids anyone reading it as a successor to a table that never had a shape in this repo.

**The orphan tables (`couriers` on both networks, `legacy_couriers` on Testnet only):**

| Option | What happens | Trade-off |
| --- | --- | --- |
| A. Read, then drop | Founder runs `check_13_unreferenced_tables` and a row count on each. If empty, drop them in a later migration. | Cleanest end state. If either holds people's data, dropping it is an erasure event and needs its own decision. |
| B. Revoke and rename | Revoke everything from anon and authenticated (the grant baseline may already have done this; check 13 says), and rename to `_retired_couriers` etc. | Nothing is lost, and nothing can reach the tables. The clutter stays. |
| C. Reuse `legacy_couriers` | Adopt it as the registry, matching `ed98f9f`. | Fewer webhook changes. But it exists on Testnet only, its shape is unknown to the repo, and the brief asks for one table for both classes. |

**Retention and shredding:**

- Shredding means: null `commitment_salt`, null `pi_username` and `piverify_session_id`, set `shredded_at`. On-chain roots and stored leaf hashes stay; without the salt they link to no one.
- Enforcement options: (a) a service_role-only `courier_shred(p_id uuid)` RPC the founder runs by hand per request, which is an attestation-class write (founder review); (b) the same RPC called by a scheduled sweep for rejected or failed buffer records older than the retention window; (c) a read-only overdue report in `scripts/dispatch-reader.mjs` that lists couriers past the window, with shredding still done by hand. Option (c) needs no automated write.
- The retention window itself is an open spec question (section 6).
- Every new table and function follows the existing pattern: RLS on, no policies, service_role only, `search_path` pinned, revokes from public, anon and authenticated including EXECUTE, and new rows in `check_06`, `check_07`, `check_12` and `check_09_migration_objects`.

### Decision 2: Legacy courier sign-in

**Constraint found in Phase 0.** In a normal browser, the pinet host serves a PiNet wrapper whose iframe loads `https://gyema-app.vercel.app`, and the query string does not reach the iframe (section 2). Consequences for every option:

1. The legacy courier runs the app inside a **cross-site iframe** on the `vercel.app` origin. Safari, and Chrome with third-party storage partitioning, give that frame partitioned or restricted storage. A Supabase session in `localStorage` may survive only in that partition, or not at all, depending on the browser.
2. **Any sign-in link that carries its token in a query string will lose it** on the pinet host. Supabase magic links use `?code=` (PKCE) or `#access_token` (implicit). The query form is known to be stripped. The fragment form was not tested.
3. Turnstile and any OTP entry would run inside that iframe.
4. Invariant 4 forbids the raw Vercel URL in public copy, even though CLAUDE.md notes that authed DB writes work there. Sending legacy couriers to the raw URL would fix 1 to 3 and break invariant 4. **This is a founder decision**, listed in section 6.

**`resolveCaller` growth, common to all options.** `resolveCaller` stays exactly as it is, Pioneer-only, so no Pioneer route can ever accept a legacy session. A new `resolveCourier(admin, token)` returns a discriminated union: `{ kind: "pioneer", pi_username, courier_id }` or `{ kind: "legacy", courier_id }`. It reads only server-written claims (`app_metadata.courier_id`, stamped with the service_role key, the same rule as `pi_uid`). Only `guest/accept`, `guest/mine` and the courier branch of `guest/confirm-delivery` switch to `resolveCourier`. A test asserts that every listings and payments route still imports `resolveCaller` and nothing else. Supabase users for legacy couriers carry no `pi_uid`, so `resolveCaller` already refuses them with `no_claim` (`lib/route-auth.ts:156-158`).

| Option | How it works | Cost per sign-in | Abuse risk | Fit with rate limits and Turnstile |
| --- | --- | --- | --- | --- |
| **A. Supabase phone OTP via an SMS provider** | Supabase Auth phone provider (Twilio, Vonage, MessageBird, Textlocal), or the Send SMS auth hook to a local Ghana aggregator. The courier types the code, so no link is involved and query stripping does not matter. | Twilio: USD 0.3741 per segment (section 2), so in cedis that is 0.3741 times the day's USD/GHS rate, per attempt including resends. Local aggregators are likely cheaper but were not sourced and would need the hook. | SMS pumping (toll fraud) is the main risk: bots trigger sends to premium numbers. Needs a per-IP limit, a per-phone limit and Turnstile before the send. | Good. New buckets `courier_otp_ip` and `courier_otp_phone`, fail closed (same reasoning as `guest_create_*`, `lib/rate-limit.ts:145-160`), with Turnstile in front of the send as on `/send`. |
| **B. WhatsApp-verified one-time link or code** | The courier messages the Gyema WhatsApp number, and the server replies with a one-time code (not a link, because of query stripping). Automatic replies require the WhatsApp **Cloud API**. Whether `233500005780` (`app/send/page.tsx:17`) is on the Cloud API or the Business app cannot be told from code. | Meta authentication-template rate for Ghana not found; needs the current rate card. A courier-initiated conversation may fall in a cheaper or free service window; not confirmed. | Lower pumping risk because the courier writes first and the number is proven by their own message. Needs a Meta-verified webhook, which is a new public route. | Medium. Needs a webhook route and signature check (the same hardening as decision 8). If the number is on the Business app, this option is manual only (operator replies by hand), which collapses into option C. |
| **C. Operator-issued invite** | The founder vets a courier in person or on a call and issues a single-use invite code (short, typed, not a link) with a short expiry. Redeeming it creates the Supabase user and the registry row. Re-sign-in uses a long-lived device session, or a fresh invite. | Zero per sign-in in cash; costs founder time per courier. | Lowest. Nobody self-registers. The risk moves to invite leakage, handled by single use, short expiry and binding to a phone the founder saw. | Good. One bucket on redemption, and Turnstile optional. Matches the existing pattern where `phone_verified` is flipped by hand. |
| D. Email magic link | Supabase email OTP. | Free tier only. | Weak identity. | Listed for completeness. Many couriers may not use email, and links are hit by query stripping. |

Session persistence for any option: a typed code avoids the link problem, but the session still lives in the iframe partition. If it is lost, the courier signs in again each time, which multiplies option A's cost per sign-in.

### Decision 3: Declared value

- **Where the sender enters it.** `app/send/page.tsx` form state (`:55-72`), in the "package" group next to Package size (`:274`). It goes in the request at `:105-113`, then `GuestCreateBody` (`lib/schemas.ts:272-287`), then the insert at `app/api/guest/create/route.ts:200-219` as `declared_value_cedis`.
- **Required or optional:**
  - Required for every new job. Every new job can then be judged against the cap. Adds friction to `/send`.
  - Optional, where empty means "unknown" and unknown is treated as above the cap. Less friction, but jobs without a value never reach buffer couriers.
- **Validation bounds:**
  - Whole cedis, `int`, at least 1. Pesewas add nothing to a cap check.
  - An upper bound is needed because this is the one unauthenticated write route (`create/route.ts:121-125`). Options are a sanity cap such as GHS 10,000 that rejects above it, or a cap tied to the Trancova pilot liability figure (GHS 500, per the spec's open questions). The second would make `/send` refuse parcels above GHS 500 outright, which is a product decision.
  - Column: `declared_value_cedis integer null check (declared_value_cedis between 1 and <cap>)`, nullable so existing rows stay valid.
- **Accept refusal above GHS 200.** In `guest/accept`, the guarded read at `:89-96` grows to select `declared_value_cedis, pickup_area, dropoff_area`. For a buffer courier, refuse when the value is null or above 200, with a distinct reason such as `buffer_value_cap`. The cap should live in one constant (as `COMMISSION_BASIS_POINTS` does at `lib/guest-commission.ts:24`) so tests and copy read the same number.
- **Race.** Add `.eq("declared_value_cedis", v)` (or `.is(null)`) to the claim UPDATE, the same way the quote guard works (`:118-120`), so a value edited between read and write matches zero rows.
- **Later use.** The same field is the input to parcel cover, so its meaning has to be fixed now: what the sender says the contents are worth, unverified. The form label should say "declared", and cover terms must not promise more than that.
- **Board.** `guest/open` (`:31-39`) could return a boolean such as `withinBufferCap`, never the value itself, so buffer couriers see which jobs they can take. Optional.

### Decision 4: Buffer enforcement in `/api/guest/accept`

The order of checks in `app/api/guest/accept/route.ts`, each refusing before any write:

1. Parse body (`:75-77`). Unchanged.
2. **Identity**: `resolveCourier` replaces `resolveCaller` at `:82-84` (decision 2).
3. **Registry read**: look up the courier row by `courier_id` (legacy) or `pi_username` (Pioneer). No row means status `registered` and a refusal.
4. **Effective status**, computed in one pure function (for example `lib/courier-ladder.ts`) so tests cover it without a database:
   - `registered` or `paused`: refuse (`courier_not_cleared` / `courier_paused`).
   - `buffer` with `buffer_since` older than 30 days: treat as paused (see the options below).
   - `full`: no buffer limits apply.
5. **Job read**: the existing guarded read at `:89-96`, widened to `quote_cedis, pickup_area, dropoff_area, declared_value_cedis`.
6. **Buffer limits**, only when the effective status is `buffer`:
   - Both `pickup_area` and `dropoff_area` must be keys of `GUEST_AREAS` (`lib/guest-pricing.ts:10`). This has to be tested on the area strings. `offList` is not stored, and an operator-priced off-list job reaches `posted` with free-text areas (claim 9).
   - Declared value must be non-null and at most 200 (decision 3).
7. **Claim UPDATE** (`:104-122`), with the extra guards from decision 3, writing `assigned_courier_id` (decision 1). This is an attestation-class write and gets the `ATTESTATION WRITE: founder review required` marker.

**The 30-day pending pause:**

| Option | Mechanism | Trade-off |
| --- | --- | --- |
| A. Computed on read | `now() - buffer_since > 30 days` gives effective status paused. Nothing writes `paused` for a timeout. | No scheduler and no status write. The stored status says `buffer` while behaving as paused, so the status card and the dispatch reader must use the same function. |
| B. Swept by a scheduler | The decision 7 job writes `status = 'paused', paused_reason = 'pending_timeout'`. | The stored state is honest. But it is an automated status write, which needs founder review and depends on decision 7. |
| C. Both | Computed on read for enforcement, and a read-only report in the dispatch reader listing overdue buffer couriers for the founder to pause by hand. | Enforcement never depends on a job having run, and the stored state is fixed by a human. |

"Late approval goes to Full" (spec) holds under all three, because approval writes `full` regardless of the clock.

**`confirm-delivery` and `mine` are in scope too.** `confirm-delivery/route.ts:131` and `guest/mine/route.ts:116` match on `pi_username`. A legacy courier who wins a job but cannot stamp the code or list their jobs is stuck. Phase 1 item 5 names only accept; see question 2.

### Decision 5: Leaf format and Merkle construction

**Canonical leaf: two options.**

*Option L1, fixed binary layout (76 bytes):*

| Offset | Size | Field | Encoding |
| --- | --- | --- | --- |
| 0 | 1 | version | `0x01` |
| 1 | 1 | network | `0x01` Testnet, `0x02` Mainnet |
| 2 | 1 | event type | `0x01` guest accept, `0x02` guest pickup, `0x03` guest delivered, `0x04` Pioneer completion, `0x05` KYC approved |
| 3 | 1 | attestor | `0x01` server (claim), `0x02` sender last-4, `0x03` courier code, `0x04` sender and courier code, `0x05` both Pioneer parties, `0x06` PiVerify |
| 4 | 8 | timestamp | Unix milliseconds, unsigned 64-bit big-endian, taken from the row the RPC or UPDATE returned |
| 12 | 32 | job reference | `SHA-256(job_salt[32] || tracking_id as ASCII)`; all zero bytes for a KYC event |
| 44 | 32 | courier commitment | `SHA-256(courier_salt[32] || courier_uuid as 16 raw bytes)` |

Exact, compact, and easy to verify in a page of JavaScript. Adding a field means a new version byte.

*Option L2, canonical JSON (RFC 8785, JCS).* Readable by a person holding a proof link. But canonicalisation libraries differ on number and Unicode edge cases, and the verify page would need the same library.

**Byte order inside the hashes.** The spec writes "SHA-256(courier salt, courier UUID)". L1 fixes that as raw concatenation, salt first, UUID as its 16 bytes rather than its 36-character string. Whatever is chosen has to be written down once, because changing it later orphans every past proof.

**Merkle construction: two options.**

| | M1: positional, RFC 6962 style | M2: sorted pairs |
| --- | --- | --- |
| Leaf hash | `SHA-256(0x00 || leaf)` | `SHA-256(leaf)` |
| Node hash | `SHA-256(0x01 || left || right)` | `SHA-256(min(a,b) || max(a,b))` |
| Odd count | Split at the largest power of two below n; nothing is duplicated | Odd node promoted unchanged to the next level |
| Proof | Sibling hashes plus left/right position (or leaf index and tree size) | Sibling hashes only |
| Notes | Domain separation stops a node being passed off as a leaf. Duplicating the last leaf (as in Bitcoin) is avoided, which is the source of CVE-2012-2459. A proof also commits to the leaf's position. | Simpler proofs, as in OpenZeppelin. No domain separation unless added: a 64-byte internal node could be presented as a leaf. That cannot happen with 76-byte L1 leaves, but it is a property of the layout, not of the tree. |

**Batch order.** Leaves are ordered by `anchor_leaves.id` (an append-only bigint identity) within the hour. M1 needs this to be deterministic; M2 does not.

**Test vectors** (computed with Node `crypto`; two of them recomputed independently in Python, results matched):

Inputs: courier salt = 32 bytes of `0x11`; courier UUID `00000000-0000-4000-8000-000000000001`; job salt = 32 bytes of `0x22`; tracking ID `GYM-ABC123`; network Testnet; first timestamp `2026-10-08T10:00:00.000Z` (= `0x000001a11af49900` ms), then +1, +2, +3, +4 minutes.

```
commitment  1efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
job_ref     06f3c13885b50d00bb1376f98c1aa5acca84471b96bbec02e0660cd4ee83c085

leaf0 (accept, server)
  bytes  01010101000001a11af4990006f3c13885b50d00bb1376f98c1aa5acca84471b96bbec02e0660cd4ee83c0851efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
  M1     a33ebcd23fe865e9191e95eef26c804af9f9d01baa2104c691fa2cc2b8329bfa
  M2     269d6cd6169a8c5c33a90438700fc29ff09ab0d2129c4a5558ab4e9c200db8f7
leaf1 (pickup, sender last-4)
  bytes  01010202000001a11af5836006f3c13885b50d00bb1376f98c1aa5acca84471b96bbec02e0660cd4ee83c0851efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
  M1     94cc1228dbae760707d237b5c9ca46a0eca2c09a1cb5a91d8446e9428e1a80e0
  M2     a5626f7dede3babedb9dc2ac677e972eeb60bb8083e7329ed4972444ca5b7402
leaf2 (delivered, sender and courier code)
  bytes  01010304000001a11af66dc006f3c13885b50d00bb1376f98c1aa5acca84471b96bbec02e0660cd4ee83c0851efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
  M1     edbffed41ca025a133064f6beeee7a66b71ffb86260b46214ce7b932fbe338e0
  M2     3010f5028704be81cabfbef13735bffef6386d84949e9207e25c5c6dae4db463
leaf3 (Pioneer completion, both parties)
  bytes  01010405000001a11af7582006f3c13885b50d00bb1376f98c1aa5acca84471b96bbec02e0660cd4ee83c0851efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
  M1     2a2f2986f03dc66e03e568ffedbf1c80ad817aecf41e742baf01a82757ec1122
  M2     7c95fb6d7832286d42c0b0a0c2ac7623007d4c0ea9cecdd05126cca7b0623fdc
leaf4 (KYC approved, PiVerify, zero job ref)
  bytes  01010506000001a11af8428000000000000000000000000000000000000000000000000000000000000000001efe0bb59aa4debf6106069e64cd039d7ac59b2cd8a1105598ea323ef9c80d4b
  M1     4c96a8aa9924922f7f1c5d365c3fdf45785059ffcae8c76bd68792bc2aa66f4e
  M2     d1902535a1bd4c12eed7b514867fa43d6ca9bc71135f2ed3e6e2d475825a1ca9

roots        M1 (positional)                                                   M2 (sorted pairs)
n=1 leaf0    a33ebcd23fe865e9191e95eef26c804af9f9d01baa2104c691fa2cc2b8329bfa  269d6cd6169a8c5c33a90438700fc29ff09ab0d2129c4a5558ab4e9c200db8f7
n=2 leaf0-1  800e2aba70a64e5ece2b772b2aa5f1ad696186dce3d6631b71a00b335295c532  d93f66a6dd25fd29f717a0daa043e8ab3a9f03019133b76c53b9ba1df6506abc
n=3 leaf0-2  1ca7ab587332d86f040a3dc70c88ea6a2912e739c98c73db3a4cbe7dfb11557c  c8b8202b88e28c17da9155eb2909cb5b287c85d9e07b9bdfda495336aaecdf6c
n=5 leaf0-4  1514bf7f5ec020a9970c92424a7e22e303c3ab4e60210929bb9e8ac6d7b137b6  de780ee5c2d35484fed2af5a30e4cdc966c9658dea97cea3fb0d749ed53e0325
```

These vectors pin layout L1. If L2 or a different field order is chosen, they are regenerated and become the first test in the Phase 2 suite.

**Privacy check on the leaf.** The only identifiers in a leaf are the salted job reference and the salted commitment. There is no phone, name, Ghana Card number, `pi_uid` or `pi_username`. Only the 32-byte root goes on chain. A proof link reveals the courier's own salt and leaves, plus sibling hashes that cannot be reversed. The brief's phrase "On chain only: salted job hash, ... event type, timestamp, attestor" reads as if those fields are on chain. In this design they sit inside the leaf preimage, off chain. Wording to settle (question 9).

### Decision 6: Anchoring transaction

**Confirmed from primary sources** (section 2): passphrases `Pi Testnet` / `Pi Network`; Horizon at `api.testnet.minepi.com` / `api.mainnet.minepi.com`; base fee 0.01 Pi per operation on both today; account minimum 0.98 Pi; Pi's own server SDK uses `@stellar/stellar-sdk ^13.2.0`.

**Not confirmed from any Pi source:** that Pi accepts a `BUMP_SEQUENCE` operation, or a `MEMO_HASH` memo. Both are standard Stellar protocol features that predate protocol 27 by many versions, and a bump to a value at or below the current sequence is a valid no-op in Stellar. But Pi documents only `payment` with `Memo.text`, and nothing I found states Pi's policy on other operations or memo types. **Per the brief, this becomes a Testnet experiment the founder runs.**

Proposed experiment (founder-run, Testnet only):

1. Create a dedicated Testnet anchoring keypair. **Pi Testnet has no faucet, and Pi Wallet refuses sends to unactivated accounts** (CLAUDE.md), so the account must be created with a `create_account` operation signed by an already-funded Testnet account (for example the app's Testnet wallet, through the SDK), with a starting balance of at least 0.98 Pi plus fees.
2. Build with `@stellar/stellar-sdk` 13.x: source = anchoring account, one `Operation.bumpSequence({ bumpTo: "0" })`, `Memo.hash(<32-byte root from the vectors above>)`, fee from `fetchBaseFee()`, `networkPassphrase: "Pi Testnet"`, timebounds 180 s as pi-nodejs uses.
3. Submit, then read `GET /transactions/{hash}` and check `memo_type: "hash"`, that the memo decodes to the root, `successful: true`, and `fee_charged`.
4. Repeat on Mainnet only after the go-ahead, because Testnet runs protocol 28 and Mainnet protocol 27.

Fallback if `bump_sequence` is refused: a self-payment of the smallest amount with the same hash memo (one operation, same fee, but it does move Pi to itself). If `MEMO_HASH` is refused: `Memo.text` carries at most 28 bytes, too short for a 32-byte root, so the root would need another carrier (for example `manage_data`, which creates a subentry and raises the reserve).

**Fee source.** The anchoring account pays its own fee and holds no revenue (spec). Per the spec's own cost model, an hourly root is at most 24 transactions a day; at 0.01 Pi that is at most 0.24 Pi a day, and empty hours send nothing. The key is a server env variable (`ANCHOR_SECRET_SEED`, never `NEXT_PUBLIC_`); the network passphrase and Horizon URL are env per network.

### Decision 7: Scheduler

Vercel Hobby rejects hourly cron at deploy time (section 2), so `/api/cron/anchor` needs an outside trigger. In every option the route copies the bearer pattern from `expire-stale-listings/route.ts:33-42`. **Recommended change to that pattern:** check the bearer whatever the value of `VERCEL`, so the route is never open on a non-Vercel host.

| Option | How | Cost | Trade-off |
| --- | --- | --- | --- |
| A. Supabase `pg_cron` + `pg_net` | `cron.schedule('anchor', '5 * * * *', $$ select net.http_post(...) $$)` | Free on current plan, if the extensions are enabled. Founder check: `select extname, extversion from pg_extension where extname in ('pg_cron','pg_net');` | The bearer secret has to live in the database. If written into the `cron.job` command text, anyone who can read `cron.job` can read it. **Supabase Vault** (`vault.decrypted_secrets`) keeps it out of the job text. Needs one schedule per network project. |
| B. GitHub Actions `schedule` | Hourly workflow `curl`s the route with the secret from repository secrets. | Free on public repos. | GitHub documents scheduled runs as delayed under load, sometimes much later than scheduled, and disables schedules on repos with no recent activity (per GitHub docs; the inactivity period was not read this session). The Mainnet repo is public; secrets stay hidden, the schedule does not. |
| C. Upstash QStash schedule | QStash calls the route hourly, signing each request. | Upstash is already a dependency (`@upstash/redis`); QStash has its own free tier, not checked here. | Retries on failure. Adds a QStash signature check, or reuses the bearer. |
| D. Vercel Pro | Native hourly cron in `vercel.json`. | Monthly paid plan, price not checked. | Simplest code, at a recurring cost. |
| E. Lazy batching | Each attestation route checks whether the last batch is over an hour old and, if so, triggers a batch. | Free. | Breaks "proof within the hour" for the last events before a quiet period, and puts Horizon latency in user requests. Not recommended; listed for completeness. |

Whatever triggers it, the anchor route must be idempotent: claim the hour's unbatched leaves with a single `UPDATE ... RETURNING` into a new `anchor_batches` row, so two overlapping triggers cannot anchor the same leaves twice.

### Decision 8: PiVerify webhook hardening

From `ed98f9f`, keep `lib/piverify.ts` (client, `getPiVerifySession`, constant-time HMAC compare) and rewrite the webhook body:

1. **Signature first**, on the raw body, unchanged (`webhook/route.ts:25-38` in `ed98f9f`). Still required, but no longer trusted for content.
2. **Re-fetch.** Read only `data.session_id` from the payload, call `getPiVerifySession(session_id)`, and act on the status **PiVerify returns now**, never on the payload's `status`. A replayed old event then carries no power, which covers the missing timestamp.
3. **Bind session to courier.** The re-fetched `external_user_id` must equal the courier row whose `piverify_session_id` equals that session. Mismatch: log and return 200, change nothing.
4. **Forward-only transitions**, enforced inside a service_role RPC (`courier_apply_kyc_status`) with a guarded UPDATE, never as a read-modify-write in the route. Ranks: `created` 0, `started` 1, `pending_review` 2, then terminal `approved` / `rejected` / `failed` at 3. Moves only to a higher rank. Terminal states do not move to each other. A new session (decision 1: "new KYC session returns to Registered") is a separate RPC that replaces `piverify_session_id`, never the webhook.
5. **Processed event ids.** `piverify_events(event_id text primary key, session_id, received_at, applied boolean)`, with `insert ... on conflict do nothing returning`. Zero rows returned means a duplicate: return 200 and stop.
6. **Anchor approval exactly once.** The approval leaf is written by the same RPC, in the same transaction as the `full` transition, and only when that UPDATE returned a row, which can happen once per courier per session. A unique partial index on `anchor_leaves (courier_id) where event_type = kyc_approved` would make a second approval leaf impossible, even through a bug.
7. **Status ladder mapping**, in the same RPC: `created`/`started` gives registered; `pending_review` gives buffer and sets `buffer_since` if null; `approved` gives full and sets `kyc_approved_at`; `rejected`/`failed` gives paused with the reason.
8. **Responses.** 401 bad signature; 200 for duplicate, unknown or mismatched (so PiVerify stops retrying something that will never apply); 503 when the re-fetch fails (so PiVerify retries).

Items 4, 6 and 7 are attestation and status writes: `ATTESTATION WRITE: founder review required`.

### Decision 9: Courier-facing screens

Shared patterns from `components/`: `Card` with `p-4 space-y-3`, `Badge` (amber `#F5B800` for attention, `secondary`, `outline`), `Button` `w-full h-11` in brand green `#15803D`, red `#DC2626` for errors, a cream `#FEF7E6` page background on `/send`, and `Sheet` for drill-down. Error cards use `bg-red-50 border-red-200` (`components/track-view.tsx:145`).

**Copy rules applied to every line below:** no em-dashes; no reputation, escrow or payouts in the present tense; no numbers except the GHS 200 cap and the 30 days, which are product rules; no raw Vercel URL; PiVerify not described as live before it is (the locked answer is "we are studying them"). All copy is draft and goes through the gyema-accuracy checklist again before it ships.

**9.1 Courier sign-up** (route such as `/courier`; works in a normal browser inside the PiNet wrapper)

```
+------------------------------------------+
| Deliver with Gyema                       |
| Take delivery jobs in Accra.             |
|                                          |
| [ I have a Pi account ]   (opens in Pi   |
|                            Browser)      |
| [ I don't use Pi ]                       |
|                                          |
| Phone number  [ 0XX XXX XXXX ]           |
| [Turnstile]                              |
| [ Send my code ]                         |
+------------------------------------------+
```

States: start, sending, code entry, verifying, signed in (go to status card), Pioneer path (hand off to Pi Browser sign-in). Errors: wrong code ("That code did not match. Check the message and try again."), expired ("That code has expired. Send a new one."), rate limited ("Too many tries from this connection. Wait a few minutes, then try again."), bot check failed (reuse `/send` copy). Option C variant: "Invite code" field in place of phone and code.

**9.2 KYC hand-off**

```
+------------------------------------------+
| Verify your identity                     |
| Before you take jobs, we need to confirm |
| who you are. This is done by Pi's        |
| identity service, not by Gyema. Gyema    |
| never sees your ID or your photos.       |
|                                          |
| You will need: your Ghana Card, and a    |
| phone camera.                            |
| [ Start verification ]                   |
+------------------------------------------+
```

States: not started, session created (button opens the hosted flow), returned from flow (show "We are waiting for the result. This page updates on its own."), session error. Error: "We could not start verification just now. Try again in a few minutes." Open question: whether the hosted PiVerify flow runs inside the PiNet iframe or needs a new tab.

**9.3 Status card**

```
+------------------------------------------+
| Your courier status        [ Buffer ]    |
|                                          |
| You can take now:                        |
|  - Guest jobs only                       |
|  - Both areas on the Gyema area list     |
|  - Declared value up to GHS 200          |
|                                          |
| Waiting on: identity review              |
| Review started <date>. If it is still    |
| pending after 30 days, your account      |
| pauses until review finishes.            |
+------------------------------------------+
```

Variants:

- **Registered**: "Finish identity verification to start taking jobs." plus a button.
- **Buffer**: as drawn.
- **Full**: "Verified. You can take any guest job." For a Pioneer: "and Pioneer deliveries".
- **Paused (rejected or failed)**: "Your account is paused. Your past deliveries are kept. You can start a new verification." plus a button.
- **Paused (pending timeout)**: "Review is taking longer than 30 days, so your account is paused. If review is approved, you can take jobs again."

Empty or error: "We could not load your status. Pull to refresh."

**9.4 Proof link view** (courier-only, from the status card; Phase 3)

States: no completed deliveries yet ("Your record starts with your first completed delivery."), deliveries waiting for their hourly anchor ("Recorded. Proof is ready within the hour."), proofs ready (list with date, event, and a "Share proof" button), share sheet (link with a warning: "Anyone with this link can check these deliveries. It does not show your name or phone number."). Wording to avoid: "reputation", "rating", "score". Use "record of completed deliveries".

**9.5 Public verify page** (Phase 3, no sign-in)

```
+------------------------------------------+
| Check a Gyema delivery record            |
|                                          |
| 12 deliveries checked                    |
| [v] Each one matches a record on the Pi  |
|     blockchain.                          |
|                                          |
| 14 Oct  Delivered   [view on explorer]   |
| ...                                      |
|                                          |
| How this works (expandable): the record  |
| is checked in your browser against a     |
| public transaction. Gyema is not asked.  |
+------------------------------------------+
```

(The "12" here and "<date>" in 9.3 are layout placeholders, not data.) States: checking, all match, some do not match ("This record does not match. It may have been changed after it was shared."), link malformed, explorer unreachable ("We could not reach the Pi blockchain to check. Try again later."), proof still pending an anchor.

---

## 4. Proposed slice plan

Each slice is one branch, cut from clean `main`, one logical change, stopping for review. Migrations are drafted, not applied; the founder applies by hand, Testnet first.

**Before Phase 1 (founder, read only):**

- Gate 1 catalog check on Mainnet.
- `check_13_unreferenced_tables` on both networks.
- `guest_jobs` column list.
- `pg_extension` check for `pg_cron` and `pg_net`.
- Whether `233500005780` is on the WhatsApp Cloud API.

**Phase 1** (brief scope, re-ordered so each slice can merge alone):

1. `feat/courier-registry`: migration for the registry table and its catalog checks; `lib/courier-ladder.ts` (pure, tested); `pioneers` uniqueness decision if FK chosen. No route reads it yet.
2. `feat/piverify-webhook`: cherry-pick `ed98f9f` (files only), retarget to the registry, hardening per decision 8, events table, RPC. Tests: replay, out-of-order, duplicate id, mismatch, re-fetch failure.
3. `feat/courier-signin`: the chosen decision 2 option, `resolveCourier`, Supabase user creation, rate-limit buckets. Test: a legacy session refused by every listings and payments route.
4. `feat/declared-value`: column migration, schema, `/send` field, create route.
5. `feat/buffer-enforcement`: accept route per decision 4, plus `mine` and the courier branch of `confirm-delivery` for legacy identity (if question 2 is answered yes). Tests as listed in the brief.

**Phase 2:** `anchor_leaves` / `anchor_batches` migration, leaf writer hooked to the four attestation returns (accept UPDATE, confirm-pickup UPDATE, `guest_stamp_delivery` on `delivered`, `listing_confirm_completion` on `completed`), plus the KYC approval RPC. Gate 2 exclusions in code: no leaf for uncoded jobs or for any status not returned by the attesting write.

**Phase 3:** the decision 6 Testnet experiment (founder), then `/api/cron/anchor`, the trigger, the verify page and proof links. Two weeks on Testnet. Mainnet mirror on go-ahead, by the blob-hash gate.

---

## 5. Disagreements between the spec or brief and the code (reported, not resolved)

1. `2026-08-13_delivery_code.sql:208-217` says no app code writes `in_transit` and suggests a trigger might. `confirm-pickup/route.ts:89` writes it. The comment is stale; no trigger is evidenced.
2. `expire-stale-listings/route.ts:3` says hourly; `vercel.json` says daily.
3. CLAUDE.md invariant 1 names `user_metadata`; the code uses `app_metadata` (wording proposed above).
4. CLAUDE.md says off-list areas are stored untrimmed with a fix queued; the schema now trims (`lib/schemas.ts:94`).
5. `ed98f9f` writes to `legacy_couriers` and says Pioneers are KYC-verified by sign-in (`lib/piverify.ts:14-16`), against spec decision "retire the orphans" and Gate 4.
6. The gyema-accuracy courier line says couriers "keep 95 percent of every delivery fee". The code takes 7.5% (`lib/guest-commission.ts:24`), so a guest-rail courier keeps 92.5%. None of the draft copy above uses either figure.
7. Shipped copy (`components/profile-tab.tsx:241`, `README.md:97`) relies on the KYC-at-sign-in assumption that Gate 4 treats as unverified.
8. The brief lists Phase 1 buffer enforcement in accept only. A legacy courier also needs `guest/mine` and the `confirm-delivery` courier branch to finish a job they accepted.

---

## 6. Questions for the founder

1. **Front door for legacy couriers.** In a normal browser the pinet host iframes the raw Vercel URL and strips query strings. Do legacy couriers use the pinet host anyway (accepting iframe storage limits and typed codes only), or is there an exception to invariant 4 for the courier sign-in surface, or a third host?
2. **Phase 1 scope.** Should `guest/mine` and the `confirm-delivery` courier branch move to `resolveCourier` in Phase 1, so a legacy courier can finish a job they accept?
3. **Sign-in option** (decision 2): A, B, C, or a mix (for example C to onboard, A to sign back in). Is `233500005780` on the WhatsApp Cloud API or the Business app?
4. **Orphan tables:** read then drop, or revoke and rename? Has anything ever been written to them?
5. **Pioneer link:** add `UNIQUE(pi_username)` to `pioneers` and use a foreign key, or a standalone `pi_username` on the registry?
6. **Declared value:** required or optional? Upper bound: a sanity cap, or the GHS 500 pilot liability cap?
7. **30-day pause:** computed on read, swept by a scheduler, or both (decision 4 options A to C)?
8. **Leaf and tree:** L1 or L2; M1 or M2. Also: confirm the attestor and event codes, and whether the timestamp is the row's write time or the request's.
9. **Wording:** confirm that "on chain" in the brief means the Merkle root only, with leaf fields off chain.
10. **Scheduler:** pg_cron with the secret in Vault, QStash, GitHub Actions, or Vercel Pro?
11. **Testnet anchoring wallet:** which funded Testnet account creates it, given there is no faucet?
12. **Retention window** for rejected or failed buffer records before shredding (spec open question).
13. **Shredding:** by hand per request with a report, or automated after the window?
14. **The 95 percent courier line** in the gyema-accuracy skill versus 7.5% in code: which is current?

---

## 7. Pending CLAUDE.md edits

The founder applies these by hand, once, at the end of Phase 1. Agents do not edit `CLAUDE.md`. Because `CLAUDE.md` mirrors as bytes, the same edit lands in `gyema-app-mainnet` in the same pass.

1. **Invariant 1** (line 37). Replace with:

   > 1. **Identity for sensitive operations is derived server-side** from `admin.auth.getUser` reading `app_metadata.pi_uid` and `app_metadata.pi_username`, which only the service_role key can write (stamped by `/api/auth/verify`). Never `user_metadata`, which the user can write, and no fallback to it. No route, RPC, or client function takes a role, party, or side argument. Re-introducing one is the F17 defect.

   Phase 1 item 5 adds a second identity type (`resolveCourier`). Its sentence will be drafted with that item and added here.

2. **Database facts that bite, untrimmed areas** (line 102). Replace "Off-list area inputs are stored untrimmed (`app/api/guest/create/route.ts`, fix queued)." with:

   > Off-list area inputs were stored untrimmed before `areaName` began trimming (`lib/schemas.ts:94`); rows written before that fix may still carry whitespace.

   The bracketed pre-flight rule around it stays as written.

3. **Invariant 4** (one front door). Amendment for the courier host per `docs/anchoring-decisions.md` answer 1, drafted with Phase 1 item 4 (`docs/anchoring-phase1-notes.md`). Replace with:

   > 4. **Two front doors, never crossed.** The registered pinet production host is the front door for Pioneers and guests. Couriers without a Pi account use the courier host on the company domain, one per network: `couriers.pillgh.com` for Mainnet, `couriers-testnet.pillgh.com` for Testnet. Public copy and share surfaces carry only these hosts, never the raw Vercel URL. The Mainnet and Testnet hosts never swap. The courier host never loads the Pi SDK, and neither surface links to the other's host. A deployment knows its courier host only from `COURIER_HOST`; no code names it.
