# Gyema security scorecard

Twenty items, scored twice, because the two networks no longer disagree about
anything except the branch this file was written on.

Read on branch `phase-5-limits`, cut from Testnet `main` at `4ff4aa1`.
Testnet is `tsotsoobi/gyema-app`, confirmed by `git remote get-url origin`.
Mainnet `main` is `d74a174`, read only, through the local clone at
`C:\Users\HP\Documents\gyema-app-mainnet`.

**The two networks carry different application code, and the difference is
deliberate.** Testnet `main` is `534fc71`: the listings route plus the rate
limiter and Turnstile. Mainnet `main` is `cd9397b`: the listings route only,
mirrored through the blob-hash gate as PR #31 on 12 September. The limits work
is prepared for Mainnet and not merged, because it is gated on a Pi Browser
pass that has now happened on Testnet and not there.

Two branches exist and are counted in neither column: `fix/turnstile-error-loop`
closes a spin found in Pi Browser on 12 September, and `operator-console` would
move item 9 off N/A by introducing the app's first cookie.

No agent read a live database. Agents never mutate one and have no read path to
either, so every claim about code below is read from files and from route
behaviour.

The catalog half is not guesswork any more. **All four 2026-09-07 migrations are
applied and catalog verified on both networks**, Testnet on 7 September and
Mainnet on 8 September, with `docs/catalog-checks.sql` run after each file
rather than a Success banner being read. That is the founder's report of work
done by hand, and items 5 and 7 are scored on it. Items that still rest on an
unread catalog say so where they sit.

---

## Score

The two networks no longer carry the same code. Testnet `main` is `534fc71`,
carrying the listings route and the limits work. Mainnet `main` is `cd9397b`,
carrying the listings route only. So they are scored apart.

| | Testnet `534fc71` | Mainnet `cd9397b` |
|---|---|---|
| Done | 16 | 13 |
| Partial | 2 | 5 |
| N/A | 2 | 2 |
| **Score** | **8.9 / 10** | **7.2 / 10** |

Score is Done divided by (20 minus N/A) times 10, so the denominator is 18.

**Testnet is at the target.** 8.9 rounds against a goal of 9 and is one item
short of it, which is what the brief allows: at most two items not Done.

Two Partials remain on Testnet and both are named below with what closes them.
Item 18 needs a report-only CSP pass read in the Pi Browser console. Item 20
needs one commit: dependabot, a Node pin, a GitHub Actions workflow and
`npm audit fix`, with the three existing type errors fixed in the same commit or
the first CI run fails on them.

| Action | Closes | Testnet |
|---|---|---|
| Report-only CSP pass in Pi Browser, then `CSP_ENFORCE=true` | 18 | 9.4 |
| One commit: dependabot, Actions, Node pin, audit fix | 20 | 10 |

**Mainnet trails by three items and none of them is a code gap in that
repository.** Items 11 and 12 are absent because the limits work has not been
mirrored there. Item 8 is Partial for a different and sharper reason: the code
is mirrored, but `db/migrations/2026-09-11_listings_create_server_side.sql` is
not applied, so `authenticated` still holds a table-wide INSERT grant on
`listings`. The app no longer sends the five fields, and a hand-built PostgREST
request still can.

| Action | Closes | Mainnet |
|---|---|---|
| Apply the 2026-09-11 revoke migration | 8 | 7.8 |
| Mirror and merge the limits work | 11, 12 | 8.9 |

---

## The twenty items

Legend: **Done** closed from this repository. **Partial** carries a written
reason naming what closes it and where. **N/A** carries a one-line reason.

### 1. Hide API keys: Done

Every secret is read from `process.env` in server-only code and never reaches a
bundle. `PI_API_KEY` in `lib/pi-platform.ts` and the two payment routes.
`SUPABASE_SERVICE_ROLE_KEY` at one construction site in `lib/supabase-admin.ts`,
imported only under `app/api/`. `PIONEER_PASSWORD_SALT` guarded by
`lib/env-guard.ts`, which refuses a placeholder, a short value, or one built
from fewer than eight distinct characters, and never puts the value in the
refusal. `tests/logging.test.ts` asserts no route logs a secret.

`NEXT_PUBLIC_TURNSTILE_SITE_KEY` is public by design, the same way
`public/validation-key.txt` and the Supabase anon key are. Its secret half,
`TURNSTILE_SECRET_KEY`, is read only in `lib/turnstile.ts` and only server side.

### 2. Purge secrets from git: Done

`gitleaks 8.30.1`, `git . --redact --log-opts=--all`: **234 commits scanned, 0
findings**, re-run on this branch. Both repositories are public, so a clean
history is the result that closes the rotation question. A pre-commit hook
(`.githooks/pre-commit`) and `npm run security` keep it closed.

This says nothing about whether a live key has been exposed somewhere other
than git.

### 3. Expose only the public DB key: Done

The anon key is the only key that reaches a browser. Confirmed by grep: no
client component imports `lib/supabase-admin.ts`, and the service-role client is
constructed in one place.

### 4. Enable row-level security: Done

RLS is on, and the evidence is behavioural as well as documentary. `guest_jobs`
cannot be read with the anon key at all, which is why all eight guest routes run
through the service-role client and say so in their headers. The 14 August
migration turns RLS on for `listings` and creates the completion RPC as security
definer with `search_path` pinned and EXECUTE revoked from public, anon and
authenticated.

Whether each policy says what the file says it says is item 7, and it is the
half that needs the catalog.

### 5. Encrypt sensitive data: Done

Delivery codes are stored as a hash and compared with `timingSafeEqual`
(`lib/delivery-code.ts`), minted with `crypto.randomInt` rather than
`Math.random`. Supabase Auth stores its own password hashes. Everything crosses
the network over TLS, now forced (item 19).

The part that was open was specific and it is closed.
**The last four digits of `sender_phone` are a credential on this rail**, not an
identifier: they are the whole guard on three public routes, one of which
returns the delivery code. `gyema_reader` held a direct column grant on both
phone columns, and the operator report printed exactly those four digits for
every job, so the guard travelled with the report anywhere it was pasted.
`db/migrations/2026-09-07_dispatch_reader_masked_view.sql` replaces that grant
with masked views. Applied to Testnet 7 September and Mainnet 8 September,
catalog verified after each.

One residual, named so it is not rediscovered as new: the phone columns
themselves are still plaintext at rest, protected by column grants and by
masking rather than by encryption. That is a defensible position for this data
and it is a position rather than an oversight. If you want it scored as Partial
on that basis, say so and it costs half a point.

### 6. Enforce server-side auth: Done

Identity for every sensitive operation is derived from
`admin.auth.getUser` reading `app_metadata`, never from a request body, and
never from `user_metadata`, which a user can write themselves with
`updateUser`. `lib/route-auth.ts` is the one path. `tests/routes/identity.test.ts`
signs a request as a user carrying a forged `user_metadata` identity and asserts
every route refuses it.

The two payment routes are no longer unauthenticated. They resolve a caller and
answer 401 without one, and `lib/payments-policy.ts` re-reads the payment from
Pi Platform rather than trusting anything the caller said about it. That was the
sharpest finding in the Phase 0 inventory and it is closed.

Depended on `scripts/backfill-app-metadata.mjs` having run per network, which it
has: it is step 2 of `docs/deploy-order.md` and the identity migration that
follows it is applied on both networks. Had it not run, a pre-existing Pioneer
would have had no `app_metadata` claim and been refused, which is a functional
failure rather than a security one. The code fails in the safe direction.

### 7. Lock record access: Done

Two files carry it and both are applied and catalog verified on both networks,
Testnet 7 September and Mainnet 8 September.

`2026-09-07_grant_baseline.sql` drops the Supabase default table-wide grants to
anon and authenticated and re-grants per column, with the note that a
column-level revoke cannot subtract from a table-wide grant. It also closes the
drift the Phase 0 inventory found, where Mainnet had been hand-tightened and
Testnet still carried the defaults, so the two now hold one privilege set.
`2026-09-07_identity_from_app_metadata.sql` moves every policy off
`user_metadata`, which a user can write themselves with `updateUser`, onto
`app_metadata`, which only the service-role key can write.

Scored on the founder's catalog verification after each file rather than on the
files themselves, which is the distinction invariant 8 exists to make.

### 8. Block field tampering: Done on Testnet, Partial on Mainnet

The guest rail always derived `status`, `quote_cedis` and `tracking_id` server
side. The Pioneer rail does now too.

Creation moved from a client INSERT to `app/api/listings/create`. The server
owns `posted_by_id`, `posted_by_username`, `status`, `tracking_id` and
`created_at`, mints the tracking ID against BOTH tables, and refuses the
`matched_with_*` columns outright. `ListingCreateBody` is strict, so a body
carrying any server-owned field is a 400 with reason `forbidden_field` rather
than a value silently dropped, which also closes a column added to this table
in future on the day it is added.

The catalog policy `listings_insert_own` pinned `posted_by_id` and one column
only, because the grant behind it was table wide. The revoke closes the rest.

**Testnet: Done.** Verified end to end on 11 September. `GYM-B42CA4` and
`GYM-9CCB9F` posted in Pi Browser before the migration, the migration applied,
the column privileges query reading anon and authenticated SELECT on 25
columns, authenticated UPDATE on 2, INSERT only `postgres` and `service_role`,
and `GYM-A74042` posted after the revoke.

**Mainnet: Partial, and the reason is the grant rather than the code.** The
code is mirrored at `cd9397b`. `db/migrations/2026-09-11_listings_create_server_side.sql`
is NOT applied, so `authenticated` still holds table-wide INSERT on `listings`.
The app no longer sends those five fields; a hand-built PostgREST request with
the anon key and a session still can.

**What closes it on Mainnet:** apply that migration, after posting a trip and a
package in Pi Browser on `gyema8841.pinet.com` to confirm the route carries
creation while the old path is still there to fall back on. The sequence is in
the migration.

### 9. Secure session cookies: N/A

The app sets no session cookie. `lib/jwt.ts` is a one-line deprecated stub, there
is no app-signed JWT and no JWT secret, and Supabase session tokens are held in
memory rather than persisted.

### 10. Hash passwords: Done

Supabase Auth stores the hash. The derivation input is
`PIONEER_PASSWORD_SALT`, which `lib/env-guard.ts` refuses when it is absent,
blank, a known placeholder, under 32 characters, or built from too few distinct
characters, at first use rather than at module load so the failure lands on the
first sign-in of a misconfigured deployment rather than during a build.

The two networks must not share a salt. That is a hosted fact this repository
cannot check.

### 11. Rate limit login: Done on Testnet, Partial on Mainnet

`lib/rate-limit.ts` puts a shared Upstash counter in front of `/api/auth/verify`
and every other route a stranger can reach. Forty per five minutes per address
on sign-in, checked before the Pi Platform round trip so a flood is refused
before it is paid for.

Keys are namespaced on the Supabase project ref rather than on the network
flag, so the single shared Upstash database cannot let a Testnet flood exhaust a
Mainnet window even if `NEXT_PUBLIC_IS_TESTNET` were ever unset on both. A test
asserts that.

Only the guest write path fails closed on a Redis error. Sign-in, the tracker,
the board and the three last-4 routes fail open and log, because on those the
control lives in Postgres and a refusal costs a person more than it protects. A
refused last-4 attempt spends none of the ten a job allows, because the check
runs before the job is read.

**Testnet: Done**, live at `534fc71` with Upstash configured on Production.

**Mainnet: Partial.** Nothing rate limits anything there. Closed by mirroring
the limits work, which is prepared and not merged.

Two caveats that hold on both networks. Upstash credentials are Production only,
so preview deployments run with no limiter at all, which is correct for a
preview and worth knowing before one is shared. And a per-address limit under
Ghanaian carrier NAT is really a per-carrier-egress limit, which is why every
per-address number is set well above any plausible cluster of real users and the
one tight limit is keyed on the sender's own phone number instead.

### 12. Add bot protection: Done on Testnet, Partial on Mainnet

Cloudflare Turnstile on the guest post flow, verified server side in
`lib/turnstile.ts`. Configuration fails open, so either key missing means the
check does not run and a half-configured deployment keeps working rather than
taking the only unauthenticated write in the app down. Verification fails
closed, so once both keys are set a token Cloudflare rejects and a siteverify
call that errors are both refusals. Every failure answers with one reason, so a
caller cannot tell a rejected challenge from an outage and wait for the outage.

**VERIFIED IN PI BROWSER on 12 September**, which is what closes this item. The
widget renders and solves in Pi Browser and in desktop Chrome on Testnet. An
earlier Pi Browser attempt failed with a wrong site key, which is what surfaced
the spin bug below; with the corrected key it solves.

That first attempt was worth the trouble. It showed the widget reporting
`did not load within the deadline` and the button sitting disabled forever,
because a wrong key makes Cloudflare answer 400, Turnstile retries indefinitely,
and the load deadline had already been cleared by the successful script load.
Fixed on `fix/turnstile-error-loop`: three consecutive challenge errors, or ten
seconds after the first error, now falls through to the red panel and the
prefilled WhatsApp handover.

**Mainnet: Partial.** No Turnstile there. The keys exist on the Vercel project
and are inert until a deploy bakes the site key in.

Scoped to guest creation and deliberately not applied to the three last-4
routes. Those are reached by a sender standing at a door, they already carry
permanent per-job attempt ceilings, and an interactive challenge in front of a
delivery confirmation is the worst false positive this app could ship. The
helper is one line to apply if that call is wrong.

### 13. Parameterize queries: Done

No string-built SQL anywhere in application code. Every read and write goes
through the PostgREST query builder, and every stored function pins
`search_path`.

One residual, finding S-18: `lib/listings-async.ts:165` interpolates a user id
into a PostgREST `.or()` filter expression. It is not SQL injection, and the
value is a session-derived id rather than anything from a request body, so a
caller cannot choose it. Named here so it is not rediscovered as new.

### 14. Validate all input: Done

`lib/schemas.ts` carries a zod schema for every route body and query parameter,
with a bound on every field and a written justification for each bound. The
phone minimum is nine digits and the reason is specific: fewer than four digits
would create a job whose last-4 guard can never be satisfied by anybody,
including its owner. `tests/schemas.test.ts` and the route tests cover it.

The refusal reasons routes returned before validation moved are preserved
exactly, because the UI branches on some of them.

### 15. Escape user content: Done

React escapes every rendered string. No markdown renderer. The only
`dangerouslySetInnerHTML` in the tree is inside `components/ui/chart.tsx`, a
shadcn component that nothing imports, and it interpolates theme colours rather
than user content.

### 16. Restrict file uploads: N/A

The app has no upload of any kind: no file input, no storage bucket, no signed
URL, no avatar, no proof-of-delivery photo.

### 17. Trim API responses: Done

Every guest route names its columns explicitly with a comment saying which must
never be added and why. `delivery_code_hash` is selected but only its nullity is
emitted, on the stated grounds that over a four-digit space the hash is the
code. The Pioneer reads no longer use `select("*")`. `/api/guest/accept` no
longer returns the delivery code to the courier, which was finding S-4.

Asserted rather than asserted-by-comment: `tests/routes/guest.test.ts` and
`tests/mask-phone-contract.test.ts` check that no phone number, name, landmark
or code appears in a public payload.

### 18. Add security headers: Partial

Shipped in `next.config.mjs` and `middleware.ts`: HSTS with preload and a
two-year age, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
and a CSP with a per-request nonce naming every Pi origin read out of the SDK
bundle's own source plus the Turnstile origin in four directives.
`tests/headers.test.ts` and `tests/csp.test.ts` cover them.

**Partial for one recorded reason: the CSP cannot be closed without a
report-only pass read in the Pi Browser console, and that pass has not been
done.** The policy sends `Content-Security-Policy-Report-Only` unless
`CSP_ENFORCE` is exactly `"true"`, so today it blocks nothing and the header set
is not doing the job it was written for.

Turnstile solving in Pi Browser on 12 September does NOT close this, and the
reason is worth stating so it is not mistaken for evidence later. The policy is
report-only, so it blocks nothing regardless. A challenge solving tells you the
browser could reach Cloudflare; it tells you nothing about whether the policy
would have stopped it had it been enforcing. Only a violation report, or the
absence of one, answers that.

A desktop pass cannot substitute. `frame-ancestors` is inert when the page is
not framed, and `connect-src` is never exercised until a real `Pi.authenticate`
runs, so two of the directives most likely to break sign-in are unreachable
outside Pi Browser. That is not theory: enforcing an earlier version of this
policy on Testnet broke sign-in after a desktop pass had looked clean.

**What closes it:** open Testnet in Pi Browser with the policy in report mode,
sign in, post, and read the console. Every violation names its directive and
its blocked URI. If it is silent, set `CSP_ENFORCE=true` and redeploy.

### 19. Force HTTPS: Done

`middleware.ts` answers 308 to any request whose `x-forwarded-proto` is http,
preserving method and body so a POST is not silently turned into a GET.
Loopback is exempt on hostname rather than on an environment variable, so it
cannot be switched off in production by setting `NODE_ENV` wrongly. HSTS handles
every request after the first.

### 20. Scan dependencies: Partial

`npm run security` runs gitleaks and `npm audit --audit-level=high` and a
pre-commit hook runs gitleaks. That is the whole of it.

Missing: no `.github` directory in either repository, so no Actions, no
dependabot, no CODEOWNERS. No `.nvmrc` and no `engines` field, so Node is
unpinned. `next.config.mjs` still sets `eslint.ignoreDuringBuilds` and
`typescript.ignoreBuildErrors`, which means **neither a type error nor a lint
error can fail a deploy on either network**, and there are three type errors in
the tree today that a build therefore ships past.

`npm audit --omit=dev` reports **5 vulnerabilities: 1 critical, 3 high, 1
moderate**. The critical is `next`, and it was high when the Phase 0 inventory
ran on 8 September. Nothing in this repository changed; the advisory database
did. Adding `@upstash/ratelimit` and `@upstash/redis` on this branch introduced
none of them, confirmed by running the audit with and without the two packages.
Every finding still has a non-major fix available.

**What closes it:** one commit with `dependabot.yml` weekly and grouped, a Node
pin in `.nvmrc` and `engines`, a GitHub Actions workflow on push and pull
request running `npm ci`, typecheck, tests, `npm audit --audit-level=high` and
gitleaks, with read-only workflow permissions and actions pinned by SHA because
the repositories are public, and `npm audit fix` for the five. Removing the two
`ignoreDuringBuilds` flags belongs in the same commit, after the three existing
type errors are fixed, or the first CI run fails on them.

---

## Findings still open, by number

Carried forward from `docs/security-inventory.md` so the numbering does not
restart.

| Finding | Severity | State |
|---|---|---|
| S-1 anon reads expose `whatsapp` | HIGH | Closed. Reads name their columns |
| S-2 last-4 guard has no ceiling | HIGH | Closed. `lib/last4-guard.ts`, ten attempts, no decay |
| S-3 payment routes unauthenticated | HIGH | Closed. `resolveCaller` plus `lib/payments-policy.ts` |
| S-4 accept returns the delivery code | HIGH | Closed, with a test |
| S-5 no rate limiting or bot protection | HIGH | Closed on Testnet, verified in Pi Browser 12 September. Open on Mainnet until the limits mirror merges |
| S-7 no security headers | HIGH | Shipped on both. CSP still report-only, so not yet doing its job. Item 18 |
| S-8 `PIONEER_PASSWORD_SALT` single point | HIGH | Mitigated by `lib/env-guard.ts`. Rotation is hosted |
| S-9 Pi token in localStorage | HIGH | Closed. No longer persisted |
| S-11 raw Pi error echoed to the caller | MEDIUM | Closed |
| S-12 no caps on guest free text | MEDIUM | Closed. `lib/schemas.ts` |
| S-14 dispatch reader prints the guard | MEDIUM | Closed. Masked views applied both networks, 7 and 8 September |
| S-15 client-supplied Pioneer listing fields | MEDIUM | Closed on Testnet, code and revoke both applied. Open on Mainnet until the revoke is applied there. Item 8 |
| S-16 type and lint errors cannot fail a build | MEDIUM | **Open.** Item 20 |
| S-17 `Math.random` tracking IDs | MEDIUM | Closed on the Pioneer rail: `app/api/listings/create` mints from `randomBytes`. **Open on the guest rail**, where `app/api/guest/create` still uses `Math.random`. One line, and it should be taken |
| S-18 PostgREST filter interpolation | LOW | **Open**, bounded. Item 13 |
| S-6, S-10, S-13, S-19 through S-23 | MEDIUM/LOW | Unchanged since the inventory |

One thing nothing in this repository can answer, restated because it has not
moved: **what sets `guest_jobs.phone_verified = true`** is not in this codebase,
and the whole guest rail's visibility gate depends on it.

The other standing unknown, the catalog state of both databases, is answered for
the four 2026-09-07 migrations and only for those. It was verified by hand after
each file, on both networks. No agent read it, and nothing here claims a catalog
fact beyond what those checks covered. The `listings` INSERT policy body is read and
recorded at item 8. What remains unread there is whether `tracking_id` carries a
unique index.

---

## What a legitimate user meets, worst case

Written out in full because a rate limit that a real person hits is worse than
no rate limit. Each row is the unluckiest realistic case, not the average one.

| Action | Bucket | Worst case for a real person |
|---|---|---|
| Posting a delivery | 4 per hour per phone, 20 per hour per address | The phone limit is the one a person meets, on their fifth post in an hour. They wait, or the operator posts for them |
| Tracking a job | 120 per 10 minutes per address | Not reachable by hand. Twelve lookups a minute, sustained, with nothing polling |
| Entering last four digits | 120 per hour per address, shared across all three routes | Roughly twenty complete handshakes an hour from one address. Under carrier NAT this is the one that could bite a busy corridor |
| Signing in | 40 per 5 minutes per address | One sign-in every seven seconds sustained. Not reachable by hand |

The shared risk under all four is **carrier-grade NAT**. Ghanaian mobile data
routes many subscribers through one public address, so a per-address limit can
count a neighbourhood as one person. That is why the tight limit on guest
posting is keyed on the sender's phone number instead, and why every per-address
number is set well above any plausible cluster.

Three deliberate softenings, each costing something and each worth it:

- A refused attempt on any last-4 route **spends none of the ten a job allows**.
  The limiter is checked before the job is read, so the permanent counter never
  moves. Every card says so in words.
- The tracker answers 429 and never 404 when its window is full. A rate limit
  reported as a missing delivery is the worst thing this app could say to
  someone waiting on a courier.
- Sign-in, the tracker, the board and the last-4 handshake all **fail open** on a
  Redis error. Only guest posting fails closed, on the founder's instruction,
  and the cost of that is stated plainly: while Upstash is unreachable, guest
  posting is refused rather than being quietly let through unlimited.

---

## Deployment, per network

### Testnet, what is left

Steps 1 through 4 are done. The limits work merged as `534fc71`, the redeploy
baked the site key, and Turnstile was confirmed rendering and solving in Pi
Browser and desktop Chrome on 12 September.

1. Merge `fix/turnstile-error-loop`, which closes the spin that first Pi Browser
   attempt exposed.
2. Read the console for CSP violations in Pi Browser while the policy is still
   in report mode. This is the outstanding half of item 18 and nothing else
   substitutes for it.
3. Only if that console is silent, set `CSP_ENFORCE=true` and redeploy.
4. One commit for item 20: dependabot, a Node pin in `.nvmrc` and `engines`, a
   GitHub Actions workflow, and `npm audit fix`. Fix the three existing type
   errors in the same commit, or the first CI run fails on them, and remove the
   two `ignore` flags in `next.config.mjs` once it passes.

The migrations are not part of this sequence any more. All four are applied and
catalog verified on both networks, and `docs/deploy-order.md` is now a record of
that rather than a plan. Nothing on this branch touches the database or needs a
migration window.

### Mainnet, second, and only on an explicit go-ahead per change

Mirror through the blob-hash gate in CLAUDE.md, checked twice, with the
existence test on the target path. `git diff --no-index` is not the gate.

Before Mainnet is asked for at all, these Testnet checks have to have passed:

| Change | The Testnet check that gates it |
|---|---|
| The limiter | A guest post, a track lookup, a last-4 confirmation and a sign-in all succeed in Pi Browser with Upstash configured |
| Turnstile | The widget renders and solves in Pi Browser, and a post with it succeeds |
| Turnstile keys on Mainnet | Already set in Vercel, Production only, but inert until a Mainnet deploy bakes the site key. Do not deploy the mirror until the Testnet check above passes |
| Upstash keys on Mainnet | Already set. The namespace test proves a Testnet flood cannot reach a Mainnet window, but that is a unit test and not a live one |

Scan the file set for `pinet\.com|Testnet|testnet|8841|3681` before mirroring.
Nothing added on this branch hits that scan, so this mirror is bytes rather than
hand-applied changes, with `CLAUDE.md` the usual documented exception.
