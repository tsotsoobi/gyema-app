# Deploy order

Four migrations, one backfill script and a branch of code changes. They
interlock, and the order is not interchangeable: several combinations break
something a person can see.

Testnet first, verified in the Pi Browser, then Mainnet on an explicit go ahead
per change. Every SQL statement is applied by hand through the Supabase
dashboard with the project breadcrumb confirmed, per CLAUDE.md. Nothing here is
applied by an agent, and Mainnet is read only to agents throughout.

## Status: applied, both networks

**All four migrations are applied and catalog verified on both networks.**
Testnet on 7 September 2026, Mainnet on 8 September 2026, with a catalog check
after each file rather than a reading of the Success banner, per invariant 8.
The ceiling was additionally confirmed live on Testnet on 7 September by a
sender card counting down to "9 tries left before it locks".

What follows is kept as the record of the order and the reasoning, not as work
outstanding. Anything below written in the future tense describes a step that
has already run.

---

## Pending: anchoring Phase 1

Drafted on `feat/anchoring-phase1`. Same rules as everything else in this
file: by hand, breadcrumb confirmed, Testnet first, Mainnet only on a go-ahead
per file.

**Status, 8 Oct 2026.** Testnet: P1, P1b, P2, P3, P5, P7 and P8 applied and
verified. P6 in part: `PIVERIFY_API_KEY` and `PIVERIFY_API_BASE_URL` are set
on Testnet Production; `PIVERIFY_WEBHOOK_SECRET` and the webhook registration
wait until the Phase 1 code is deployed to Testnet. P9 applied; the founder
confirms its verification result. No Phase 1 code is deployed on either network. Mainnet: nothing applied (P4 and the rest
wait for a go-ahead).

**Status, 11 Oct 2026.** Testnet: P17 applied at 09:30 and verified
(`all_present` true, fifteen constraints, catalog clean). P16: not applied on
either network; `guest_jobs_status_check` was found already present on both
by catalog read the same day, so P16 is a no-op there that records it.

| # | Step | File | Notes |
|---|---|---|---|
| P1 | Orphan read | `docs/orphan-courier-tables.sql` | Read only, any time, both networks. Counts rows and non-null values per column in `couriers` and `legacy_couriers`; returns no values. Record the counts. |
| P1b | Username case read | `docs/pioneer-username-case.sql` | Read only, any time, both networks. Counts `pioneers.pi_username` values in more than one case; returns no usernames. Read it before P2. |
| P2 | Courier registry | `db/migrations/2026-10-08_courier_registry.sql` | Additive: a new table, nothing existing touched, nothing in the app reads it yet. The file's last statement is its verification: `all_present` must be true. |
| P3 | Catalog check | `docs/catalog-checks.sql` | The seven `2026-10-08` rows in check 9 true, and check 14 as its expectation says. |
| P4 | Then Mainnet | the same P2 and P3 | On a go-ahead. |
| P5 | PiVerify webhook | `db/migrations/2026-10-08_piverify_webhook.sql` | Needs P2 first. Adds `piverify_events` and `courier_apply_kyc_status`. Apply before the webhook code deploys: until it exists, every signed webhook answers 500 and PiVerify retries. Last statement is its verification: `all_present` true. Then the catalog check: the six `2026-10-08 piverify webhook` rows in check 9 true, and check 7 showing `courier_apply_kyc_status` for service_role only. After P9, this file's own verification reads false, because it looks for the five-argument function P9 drops: use check 9 and P9's verification cell instead, and never re-run this file. Mainnet on a go-ahead. |
| P6 | PiVerify env | Vercel, per network | `PIVERIFY_API_BASE_URL`, `PIVERIFY_API_KEY`, `PIVERIFY_WEBHOOK_SECRET`. Server only, never `NEXT_PUBLIC_`. Without the secret the webhook answers 500 to everything. Register the webhook in PiVerify on the raw Vercel URL of that network's deployment, `https://<deployment>.vercel.app/api/kyc/webhook` (founder decision, 8 Oct 2026: a server-to-server registration, not public copy, and the pinet host serves a wrapper page to non-Pi clients). Testnet: the API key and base URL are set (8 Oct 2026); the secret and the registration come after the Phase 1 code is deployed. |
| P7 | Function defaults | `db/migrations/2026-10-08_default_function_privileges.sql` | Independent of P1 to P6; any time. Removes anon and authenticated from role postgres's default EXECUTE on new functions in public. Last statement is its verification: `all_present` true. Then the catalog check: the `2026-10-08 function defaults` row in check 9 true, check 12b's postgres functions row naming neither role, and check 12 with exactly one row (`listing_counterpart_contact`, authenticated). New functions remain executable through PUBLIC; the per-function revoke is still required. |
| P8 | Orphan drop | `db/migrations/2026-10-08_drop_orphan_courier_tables.sql` | Irreversible. Only after P1's output is recorded for that network. Run the file's section 1 pre-flight on its own first: zero rows, or stop. The drop does not cascade, so a dependent object makes it fail rather than vanish. Last statement is its verification: `all_present` true. Then the catalog check: the two `2026-10-08 orphan drop` rows in check 9 true, and check 13 listing only `a2u_payments`. Mainnet on a go-ahead. |
| P9 | PiVerify resubmission | `db/migrations/2026-10-08_piverify_resubmission.sql` | Needs P5. Apply BEFORE the Phase 1 code deploys: the route calls the six-argument `courier_apply_kyc_status`, and until it exists every signed webhook answers 500 and PiVerify stops after five retries. Adds `courier_registry.piverify_allowed_action` and `piverify_events.allowed_action`, drops the five-argument function and creates the six-argument one, so a rejection carrying RESUBMIT or APPEAL reopens the session. Last statement is its verification: `all_present` true. Then the catalog check: the three `2026-10-08 piverify resubmission` rows in check 9 true, check 7 showing only the six-argument function, check 14 at sixteen columns and twelve constraints. Never re-run P5 after P9: it re-creates the five-argument function beside the new one (check 9's signature row reads false; re-running P9 fixes it). Mainnet on a go-ahead. |
| P10 | Courier host | Vercel and Netlify DNS, per network | After the Phase 1 code deploys. Testnet project: `couriers-testnet.pillgh.com`. Mainnet project, on a go-ahead: `couriers.pillgh.com`. Never the other network's host. Steps and exact records in `docs/anchoring-phase1-notes.md`, item 4. In order: add the domain in the project's Vercel Domains, add the CNAME Vercel shows in Netlify DNS, wait for Vercel to show the domain valid with a certificate, set `COURIER_HOST` (hostname only) for Production, redeploy, then the five checks in the notes. Zoho's MX and TXT records are not touched. Once P11, P12 and the item 5 code are in, the courier host checks extend, in the SQL editor and on the courier host: (1) register a test legacy courier with `select * from public.courier_register_legacy();` and note the first 8 characters of the id; (2) issue a code with `select * from public.courier_issue_signin_code('<id>');`; (3) sign in on the courier host with that code; (4) the page shows "Your courier reference:" with those 8 characters; (5) sign out; (6) the same code is refused a second time. |
| P11 | Courier sign-in | `db/migrations/2026-10-08_courier_signin.sql` | Needs P2. Apply BEFORE the item 5 code deploys: until it exists, sign-in answers 500. Adds `courier_signin_codes` and `courier_sessions` (RLS on, no policy, service_role SELECT only; hashes, ids and times only, no IP, user agent, phone or name) and six functions. Owner only, run from the SQL editor and executable by no role, service_role included: `courier_register_legacy`, `courier_issue_signin_code`, `courier_revoke_sessions`. service_role only, for the courier routes: `courier_redeem_signin_code`, `courier_session_resolve`, `courier_end_session`. Last statement is its verification: `all_present` true. Then the catalog check: the ten `2026-10-08 courier signin` rows in check 9 true, including the three `service_role cannot execute` rows; check 7 showing the three founder functions with the owner alone and the three app functions with service_role; check 12 still exactly one row; check 15 with both tables. Mainnet on a go-ahead. |
| P12 | PiVerify bind | `db/migrations/2026-10-08_courier_piverify_bind.sql` | Needs P2 and P9 (it writes `piverify_allowed_action`; without P9 its verification reads false on that row). Apply BEFORE the item 5 code deploys. Adds `courier_bind_piverify_session`, service_role only. The route creates the PiVerify session with the idempotency key `gyema_` + the first 32 hex characters of sha256(courier_id + ":" + (bound session id or "none") + ":" + floor(unix seconds / 600)), then binds it; the key has no SQL footprint and is recorded in the file header. Last statement is its verification: `all_present` true. Then the catalog check: the two `2026-10-08 courier piverify bind` rows in check 9 true, check 7 showing it for service_role only, check 12 still exactly one row. **Never re-run P12 after P18:** P18 replaces this function so a courier in buffer through the operator check keeps buffer on the first bind, and re-running P12 restores the bind that resets them to registered (check 9's 2026-10-12 bind row reads false); running P18 again fixes it. Mainnet on a go-ahead. |
| P12b | Declared value | `db/migrations/2026-10-10_guest_jobs_declared_value.sql` | Phase 1 item 7. Independent of P1 to P12. Apply BEFORE the item 7 code deploys: the create route names the column on every insert, so until it exists every guest post answers 500 and guest sending is down on that network. Adds `guest_jobs.declared_value_cedis integer null` and the named check `guest_jobs_declared_value_cedis_check` (null, or 0 to 500). No grant: service_role's table-wide grant covers it, and anon, authenticated and gyema_reader get nothing. Nullable by design: every earlier row stays null. Last statement is its verification: `all_present` true over 11 rows. Then the catalog check: the three `2026-10-10 declared value` rows in check 9 true, and check 16 `exists: true` with `null_rows_posted_after_first_valued_row` 0. The dispatch view gains the column later, in P14 (item 6), after `assigned_courier_id`; until then the operator reads it in the Supabase table editor. Mainnet on a go-ahead. |

| P13 | Courier assignment | `db/migrations/2026-10-09_guest_jobs_courier_assignment.sql` | Phase 1 item 6. Needs P2. Apply BEFORE the item 6 code deploys: every accept names `assigned_courier_id`, and so does `/api/guest/open`, so until it exists the public job board on the pinet host answers 500 for every Pioneer. Adds `guest_jobs.assigned_courier_id uuid null` (FK `guest_jobs_assigned_courier_id_fkey` to `courier_registry(id)`, no cascade; partial index `guest_jobs_assigned_courier_id_idx`), `courier_registry.vouched_at timestamptz null` with the named check `courier_registry_vouched_pioneer_only_check` (vouched_at null, or a Pioneer row: a legacy courier reaches full only through PiVerify), `courier_register_pioneer(text)` (owner only, executable by no role, service_role included) and `courier_find_pioneer(text)` (service_role only, read only). Writes no row. Last statement is its verification: `all_present` true. Then the catalog check: the ten `2026-10-09 courier assignment` rows in check 9 true, check 7 showing `courier_register_pioneer` with the owner alone and `courier_find_pioneer` with service_role, check 12 still exactly one row, check 14 at seventeen columns and thirteen constraints, check 17 `exists: true`. P2's own cell now reads false on "no columns beyond the expected fifteen", as it already does after P9; check 9 and P13's cell are the live truth. **Then, before the code deploys, the decision A backfill** (6.7 A): run this read-only pre-flight, choose the usernames, and register each one by hand, each followed by a read-back. Pass each username exactly as the bracketed column shows it; an untrimmed one is refused, and so is a second case of one already registered. `select concat('[', assigned_courier, ']') as bracketed, length(assigned_courier), lower(assigned_courier), count(*), max(created_at) from public.guest_jobs where assigned_courier is not null group by assigned_courier order by max(created_at) desc;` then `select * from public.courier_register_pioneer('<username>');` then `select * from public.courier_find_pioneer('<username>');` (one row, `status` full, `vouched_at` set, `kyc_approved_at` null). A vouched courier is full for dispatch only and is never presented as KYC-verified. Mainnet on a go-ahead. |
| P14 | Dispatch view courier id | `db/migrations/2026-10-09_dispatch_view_courier_id.sql` | Needs P12b and P13. Replaces `guest_jobs_dispatch` with the 2026-09-15 list unchanged and two columns appended: `assigned_courier_id` (24) then `declared_value_cedis` (25). Run the file's section 0 pre-flight first: the live definition must be the 2026-09-15 one (23 columns ending `remit_cedis`), or stop. Section 1 also stops the file, before the replace, if either column is missing or the live column list is not the 2026-09-15 one. The replace keeps owner, options and grants. Last statement is its verification: `all_present` true, with the grants unchanged from the pre-flight. Then the catalog check: the two `2026-10-09 dispatch view courier id` rows in check 9 true. The dispatch reader from `22baef4` on lists both columns as required and refuses to run, at its preflight, until this file is applied; it needs P15 as well. Mainnet on a go-ahead. |
| P15 | Courier registry dispatch | `db/migrations/2026-10-10_courier_registry_dispatch_view.sql` | Needs P2, P9 and the `gyema_reader` role. Adds `courier_registry_dispatch` for the reader's overdue-buffer and stale-session lists: the first 8 characters of the id, the ladder columns and `piverify_allowed_action` only (no `pi_username`, salt, session id or auth link). gyema_reader SELECT and nobody else, service_role included: the view is automatically updatable, so a DELETE grant on it would delete registry rows with the owner's rights. Last statement is its verification: `all_present` true. Then the catalog check: the four `2026-10-10 courier registry dispatch` rows in check 9 true, and check 3 showing the view for gyema_reader SELECT alone. The dispatch reader from `22baef4` on requires the view, and from `dd8607d` all nine of its columns, and refuses to run, at its preflight, until this file is applied. Amended 11 Oct 2026, before any network applied P15 (notes 6.14): `piverify_allowed_action` appended as column 9, so section 11 can tell a reopenable rejection from a final one; without P9 the file fails with 42703. Mainnet on a go-ahead. |
| P16 | Guest status check | `db/migrations/2026-10-11_guest_jobs_status_check.sql` | **A no-op on both networks that records the constraint in the repository.** `guest_jobs_status_check` already exists on Testnet and Mainnet with the identical seven-value definition, found 11 Oct 2026 by the founder's catalog read before P16 was applied anywhere; it was added by hand before `db/migrations` existed, and the repo had no record of it because there is no schema baseline. Section 1 checks the live constraint first: exactly the seven values in any order passes and the file adds nothing; any other definition, NOT VALID included, stops the file and prints it; the file never drops or replaces a constraint. Independent of every other file, and no code goes with it. Where absent, it adds the named check `guest_jobs_status_check`: status in `posted`, `pending_quote`, `accepted`, `in_transit`, `delivered`, `cancelled`, `expired` (founder decision, 11 Oct 2026: seven, because the create route writes `pending_quote` for every off-list post). Run the file's section 0 pre-flight on its own first, read only: `select concat('[', status, ']') as bracketed, length(status), count(*) from public.guest_jobs group by status order by count(*) desc;` and `select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'guest_jobs' and column_name = 'status';` Then `select conname, convalidated, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.guest_jobs'::regclass and contype = 'c' order by conname;` (expected on both networks: `guest_jobs_status_check`, validated, the seven values). Every bracketed value must be one of the seven exactly, or stop. Section 1 also stops the file, before anything is written, on any other value, naming it bracketed with its count. A null passes the check. Last statement is its verification: `all_present` true. Then the catalog check: the `2026-10-11 guest status check` row in check 9 true. Testnet first; Mainnet on a go-ahead. |
| P17 | Registry timing checks | `db/migrations/2026-10-11_courier_registry_timing_checks.sql` | **Applied on Testnet 11 Oct 2026, 09:30**, founder approved: `all_present` true, fifteen constraints, catalog clean. Mainnet: not applied. Needs P2 and P13 (`vouched_at`); no code goes with it. Adds `courier_registry_full_needs_approval_check` (status not full, or `kyc_approved_at` or `vouched_at` set) and `courier_registry_buffer_needs_since_check` (status not buffer, or `buffer_since` set). Founder decision, 11 Oct 2026, reversing P2's choice to leave these as counted rules; a hand pause is unconstrained by both. Run the file's section 0 pre-flight on its own first, read only, counts only: `select count(*) filter (where status = 'full' and kyc_approved_at is null and vouched_at is null) as breaks_full, count(*) filter (where status = 'buffer' and buffer_since is null) as breaks_buffer, count(*) filter (where status = 'buffer' and paused_reason = 'operator') as buffer_under_operator_pause, count(*) as total_rows from public.courier_registry;` `breaks_full` and `breaks_buffer` must be 0, or stop. `buffer_under_operator_pause` is information: such a row would now make `courier_bind_piverify_session` fail with 23514, so read it before applying. Section 1 stops the file if the table or `vouched_at` is missing, or on any breaking row. Last statement is its verification: `all_present` true, fifteen constraints. Then the catalog check: the two `2026-10-11 registry timing checks` rows in check 9 true, check 14 at fifteen constraints and `timing_rule_breaks` zero on the first two counts. Testnet first; Mainnet only once `courier_registry` exists there with P2 and P13 applied, and on a go-ahead. |
| P18 | Operator-checked buffer | `db/migrations/2026-10-12_courier_operator_check.sql` | Phase 1 item 10 (founder decisions 12 Oct 2026, notes 10.0 and 10.12). Needs P2, P9, P11, P12, P13, P15 and P17; section 1 stops the file, before anything is written, if any is missing or the dispatch view is not in its P15 shape. Adds `courier_registry.operator_checked_at`, `operator_checked_by` and `operator_check_deadline` with four named checks (`courier_registry_operator_checked_legacy_only_check`, `courier_registry_operator_check_pair_check`, `courier_registry_operator_checked_by_check`, `courier_registry_operator_check_deadline_check`), `courier_record_operator_check(uuid, text)` and `courier_start_operator_check_sunset()` (owner only, executable by no role, service_role included; the sunset sets a 30-day deadline and takes no argument), replaces `courier_bind_piverify_session` so a checked courier keeps buffer on the first bind, and appends columns 10 and 11 to `courier_registry_dispatch`. Writes no row. Apply BEFORE the item 10 code deploys: the accept route and `/api/courier/me` name the new columns, so until they exist every courier accept and every courier page load answers 503. Run the file's section 0 pre-flight on its own first, read only, counts only. Last statement is its verification: `all_present` true over 33 rows. Then the catalog check: the fifteen `2026-10-12 operator check` rows in check 9 true, check 7 showing both functions with the owner alone, check 12 still exactly one row, check 14 at twenty columns and nineteen constraints with `operator_checked_not_legacy` 0. P15's own cell now reads false on its column count. **Never re-run P12 after P18:** it restores the bind that resets a checked courier to registered (re-running P18 fixes it). Then the item 10 code, then the reader. `PIVERIFY_ENABLED` stays unset when the code deploys, so Start verification stays hidden and the two KYC routes refuse; it is set to `true` only on the day PiVerify authenticates, with a redeploy, and `courier_start_operator_check_sunset()` is run the same day (notes 10.6). Each check: issue a sign-in code, the courier signs in once, the founder sees the Ghana Card in person (sight only, never photographed, copied or forwarded), then `select * from public.courier_record_operator_check('<id>', 'founder');` and a read-back by id. Testnet first; Mainnet only once P2 to P17 are in there, and on a go-ahead. |

**Order for item 5.** P11 and P12 go in on a network before the item 5 code deploys there. P10's extended checks run after that deploy, since they need the sign-in route. The row numbers do not carry this order.

**Order for items 7 and 6, per network** (6.9). (1) P12b, then the item 7 code. (2) P13. (3) The decision A backfill in the P13 row. (4) The item 6 code deploy. (5) P14. (6) P15, then the dispatch reader that reads both (amended 11 Oct 2026, notes 6.14: the reader needs P15 too). The P13 and P14 file names carry 2026-10-09, the approved names, and so sort before P12b's 2026-10-10 in the directory: the order is this list, not the file names.

---

## The sequence, per network

| # | Step | What it is |
|---|---|---|
| 1 | Code deploy | merge `hardening`, wait for a Production deployment |
| 2 | Backfill | `npm run backfill:app-metadata` |
| 3 | Catalog check | `docs/catalog-checks.sql` |
| 4 | Grant baseline | `db/migrations/2026-09-07_grant_baseline.sql` |
| 5 | Catalog check | again |
| 6 | Identity migration | `db/migrations/2026-09-07_identity_from_app_metadata.sql` |
| 7 | Catalog check | again |
| 8 | Last-4 ceiling | `db/migrations/2026-09-07_last4_attempt_ceiling.sql` |
| 9 | Reader migration | `db/migrations/2026-09-07_dispatch_reader_masked_view.sql` |
| 10 | Catalog check | last one |
| 11 | Pi Browser | the checks no query can answer |

The blocker from the previous version of this document is gone: the three status
transitions are server routes now (`cancel-open`, `cancel-matched`,
`mark-in-transit`), so the grant baseline applies unmodified with `status` out of
the UPDATE grant.

---

### 1. Deploy the code

Merge the `hardening` branch and wait for a new Production deployment to appear.
Per CLAUDE.md the merge gate is both facts: `main` fast forwards on `git pull`
**and** a Production deployment shows up. A green branch build is not a merge.

Code first, because the code tolerates the old database state and the new one:

- reads name their columns, which the current wide grant permits;
- the counterpart RPC is called only for a matched listing by a party to it, and
  `getCounterpartContactAsync` returns null if the function does not exist yet,
  so the contact button simply does not render;
- the status routes use the service_role key, which is unaffected by grants;
- the last-4 ceiling reads `last4_attempts` off the row.

  **This bullet was wrong and is corrected rather than deleted, because it was
  relied on.** It claimed that until the column existed the read was undefined
  and the guard treated it as zero, so the code tolerated the old database
  state. That would hold for a `select("*")`. All three sender-side routes name
  `last4_attempts` in an explicit column list, and PostgREST answers an unknown
  column with 42703 rather than with a null, so the select fails and the route
  returns `lookup_failed`. Deploying that code ahead of this migration would
  have taken revealing a delivery code, confirming pickup and confirming
  delivery out of service, rather than degrading them.

  It did not happen: the migration was applied on 7 September and the code
  reached production behind it. The ordering constraint was real in the
  opposite direction from the one written here, and it is recorded so a future
  reader does not lean on the same false tolerance.

The reverse order is what breaks. Apply the grant baseline first and every
listing read in the deployed app is a `select("*")` against a column level
grant, so the feed, My Activity and the public tracker empty out at once.

**One deliberate regression to know about:** the Pi access token is no longer
persisted, so a cold app start re-authenticates with the Pi SDK rather than
replaying a stored credential. In Pi Browser that is the same one tap the
Pioneer already makes; outside Pi Browser there is no restore at all, which was
already true of everything else there.

### 2. Backfill app_metadata

```
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/backfill-app-metadata.mjs           # dry run first
  node scripts/backfill-app-metadata.mjs --apply
```

Take both values from **the network you are working on** and confirm which that
is: the script prints the project ref back before it does anything. Dry run
first, always. It prints counts only, never a uid, username or email.

This must land **after** the code deploy and **before** the identity migration.
After, because `/api/auth/verify` writes `app_metadata` on every sign in and the
backfill is only for accounts that have not signed in since. Before, because the
identity migration's policies read `app_metadata`, and an account without it
matches nothing: their listings vanish from My Activity until they sign in
again.

Read the two counts that matter. **"no identity to copy"** is fine and expected
for any account that never completed a sign in. **"app_metadata already differs"**
is worth looking at by hand: most likely an old rotated `pi_uid`, possibly
somebody who edited their own metadata. The script keeps `app_metadata` and
writes nothing in that case, and it will not name them, by design.

### 3. Catalog check

Run `docs/catalog-checks.sql` and keep the output. This is the "before" for the
next three steps.

### 4. Grant baseline

`db/migrations/2026-09-07_grant_baseline.sql`, one statement at a time, reading
each result. Expect five notices: the revoke count, the anon grant, the
authenticated grant, the service_role count, and either the `rls_auto_enable`
revoke (Mainnet) or "not present on this project" (Testnet).

Then its own section 7 checks (a) through (g). Note (a) expects **exactly one**
row (`authenticated / listings / INSERT`) and (b) expects **exactly two**, both
`INSERT`. Zero rows in (b) would mean a poster cannot write their own number
when they create a listing.

### 5. Catalog check

What must have changed:

- `check_03b_table_grants_catalog`: for anon and authenticated, one row only.
- `check_04b_column_grants_catalog`: `whatsapp` and `matched_with_whatsapp` with
  `INSERT` only, never SELECT or UPDATE. `authenticated` UPDATE on listings is
  exactly `archived_at` and `archived_by_matched_at`.
- `check_07_function_acls`: `listing_counterpart_contact` present, security
  definer, `search_path` pinned, EXECUTE to `authenticated` and `service_role`.
- `check_12_public_execute`: zero rows. On Mainnet this is where
  `rls_auto_enable` disappears.
- `check_13_unreferenced_tables`: no anon or authenticated grant on `couriers`,
  `a2u_payments` or `legacy_couriers`.

### 6. Identity migration

`db/migrations/2026-09-07_identity_from_app_metadata.sql`.

It **drops every existing policy on `public.listings`** and creates four, by
discovery rather than by name, and prints what it dropped. Read those notices:
an unexpected policy name going away is something to know about, and the whole
point is that afterwards nothing on that table reads a claim the user can write.

Do not run this before step 2. An account with no `app_metadata.pi_uid` matches
no policy: they can browse, and their own listings look like somebody else's.

### 7. Catalog check

The one that matters is the migration's own section 4(a): **no policy anywhere in
`public` may reference `user_metadata`. Zero rows.** Then 4(b), the same for
functions, then 4(c), exactly four policies on listings, then 4(d), the INSERT
policy pinning `posted_by_id`, which is S-15 closed.

### 8. Last-4 attempt ceiling

`db/migrations/2026-09-07_last4_attempt_ceiling.sql`. Independent of the other
three: one column and one RPC. Its section 3 has the verification, including the
statement for releasing a genuine sender who has locked themselves out.

Applied 7 September on Testnet, 8 September on Mainnet.

An earlier version of this section said the deployed code tolerated the column
being absent, reading it as undefined and treating it as zero. It does not.
The three sender-side routes name `last4_attempts` in an explicit select list,
so an absent column is a 42703 and the route answers `lookup_failed`. This file
is a hard prerequisite for that code, not an enhancement to it. See the
corrected bullet in step 1.

### 9. Reader migration

`db/migrations/2026-09-07_dispatch_reader_masked_view.sql`. Independent of
everything above: the `gyema_reader` role, two views and the masking function.

Ordering inside the pair: this file drops the `gyema_reader_select` policies and
revokes the role's base table grants, and the deployed `scripts/dispatch-reader.mjs`
already reads the views. So on Testnet, where the 2026-08-18 file was applied,
the dispatch report is broken between step 1 and here. It is a hand run operator
tool, so that is scheduling rather than an outage, but do not run a report in
between and read the preflight failure as a mystery.

On Mainnet the 2026-08-18 file was never applied, so this is the first time the
role exists there. It is created WITHOUT LOGIN and cannot connect until you set
a password by hand. Do that only if you want the dispatch report against
Mainnet, and set `GYEMA_READER_CA_CERT` to the **Mainnet** CA first: the script
refuses to connect without a verified certificate and the two networks do not
share one.

### 10. Catalog check

- `check_09_migration_objects`: every `2026-09-07` row present, both
  `gyema_reader_select` rows false, both "gyema_reader holds nothing on base
  table" rows true.
- `check_10_reader_role`: the four session settings.
- `check_04b`: `gyema_reader` holds nothing on `sender_phone` or
  `recipient_phone`.
- Section 8(d) of the reader migration:
  `select public.mask_phone_head_only('0244123456');` answers
  `024******* (10 digits)`, with `3456` nowhere in it.

### 11. Check it in the Pi Browser

The catalog cannot tell you the app works. Fully close and reopen Pi Browser
first, since it caches the bundle hard, and confirm the resolved domain is this
network's production host.

1. Signed out: the listings feed loads.
2. Track a known tracking ID: status shows.
3. Sign in. **This is the app_metadata path**: it stamps the claim before
   minting the session.
4. My Activity loads your listings. If it is empty for an account that has
   listings, that account has no `app_metadata.pi_uid`: re-run the backfill, or
   sign out and in again.
5. Open a matched listing: **the counterparty's WhatsApp button is there and
   opens the right number**. This exercises the RPC end to end.
6. Post a listing with a WhatsApp number. It saves. (Exercises the INSERT
   policy pinning `posted_by_id`.)
7. Cancel an open listing. (Exercises `/api/listings/cancel-open`, one of the
   three transitions that moved server side.)
8. On a matched listing as the **traveller**, Mark as picked up. As the sender
   on the same listing, confirm the button is not offered: the party is derived
   from the listing's kind now, not from the UI.
9. Archive a past listing from My Activity. (The only UPDATE authenticated may
   still write.)
10. Accept a listing and pay the connection fee. (Exercises the bound payment
    routes: approve and complete now require a session and check the payment
    against the listing you just claimed.)
11. On the public tracker for a guest job, enter a wrong last 4 a few times and
    watch the attempts count down, then the right one and confirm it works.

Steps 4, 5, 6 and 10 are the ones these changes can break.

### 12. Then Mainnet

Not before Testnet's step 11 passes and you have said go, per change. A go ahead
for the grant baseline is not a go ahead for the identity migration.

---

## If something goes wrong

**The feed or My Activity is empty after step 4.** The deployed code is older
than the grants: it is still asking for `*`. Confirm which commit is deployed.
Fix forward by redeploying rather than restoring the wide grant.

**My Activity is empty for one account after step 6.** That account has no
`app_metadata.pi_uid`. Re-run the backfill, or have them sign out and in. Do not
roll the policies back: that returns to trusting a field the caller controls.

**Sign in fails with a configuration error after step 1.** The salt guard is
refusing `PIONEER_PASSWORD_SALT`: absent, a placeholder, under 32 characters, or
too few distinct characters. The message says which. Generate one with
`openssl rand -hex 32`, per network, and redeploy. **The two networks must not
share a salt.**

**The WhatsApp button is missing on a matched listing.** In order: does
`listing_counterpart_contact` exist (catalog check 6), does `authenticated` hold
EXECUTE (check 7), does the signed in Pioneer have a row in `public.pioneers`
matching their `auth.uid()`, and does that row's `pi_uid` equal their
`app_metadata.pi_uid`. The RPC requires both to agree and returns nothing when
they do not, which on Testnet can happen after a `pi_uid` rotation: signing in
again restamps it.

**Cancel or Mark as picked up fails.** These are routes now. Check the Vercel
function logs rather than the database: a 401 means no session, a 403 on
mark-in-transit means the caller is not the traveller for that listing's kind.

**A payment is refused after step 1.** The approve and complete routes now
require a session and check the payment against a listing claimed by that
caller. A refusal is logged server side with a specific reason
(`amount_mismatch`, `listing_not_claimed_by_caller`, `unknown_payment_type`);
the client gets a generic one on purpose.

**The dispatch report fails preflight.** The reader migration and the script
disagree about which network is which. The failure names the missing columns.

Rollbacks are in each migration's own verification section. Every one of them
restores something these files exist to close, so treat a rollback as incident
response, not routine.
