# Gyema security scorecard

Twenty items, scored twice, because the two networks no longer disagree about
anything except the branch this file was written on.

Read on branch `phase-5-limits`, cut from Testnet `main` at `4ff4aa1`.
Testnet is `tsotsoobi/gyema-app`, confirmed by `git remote get-url origin`.
Mainnet `main` is `d74a174`, read only, through the local clone at
`C:\Users\HP\Documents\gyema-app-mainnet`.

**The two networks carry identical application code today.** The 7 September
hardening run reached Mainnet as PR #30 on 8 September, and Testnet `4ff4aa1`
is mirrored there as `a5c06a8`. The drift the Phase 0 inventory recorded, 29
unmirrored commits, is closed. So one column covers both networks as they
stand, and the second column is what merging this branch would add to Testnet
alone.

Nothing here was verified against a live database. Agents never mutate one and
have no read path to either, so every claim below is read from files and from
route behaviour. The catalog half is `docs/catalog-checks.sql`, run by hand.
Where an item depends on it, the item says so rather than assuming.

---

## Score

| | Mainnet and Testnet `main`, today | Testnet with `phase-5-limits` merged |
|---|---|---|
| Done | 11 | 12 |
| Partial | 7 | 6 |
| N/A | 2 | 2 |
| **Score** | **6.1 / 10** | **6.7 / 10** |

Score is Done divided by (20 minus N/A) times 10, so the denominator is 18.

The target is 9. This branch moves one item. **Six of the seven Partials are
closed by actions outside this repository, not by more code**, and the ladder is
short:

| Action | Closes | Score |
|---|---|---|
| Merge this branch, redeploy Testnet | 11 | 6.7 |
| Apply the four queued migrations, both networks | 5, 7 | 7.8 |
| Report-only CSP pass in Pi Browser, then `CSP_ENFORCE=true` | 18 | 8.3 |
| Verify Turnstile renders and solves in Pi Browser | 12 | 8.9 |
| One commit: dependabot, Actions, Node pin, audit fix | 20 | 9.4 |
| One commit: an INSERT policy on `listings` | 8 | 10 |

Two commits and four hosted actions stand between today and ten. Neither commit
is large, and neither is on the critical path of anything a user does.

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

### 5. Encrypt sensitive data: Partial

Done: delivery codes are stored as a hash and compared with `timingSafeEqual`
(`lib/delivery-code.ts`), minted with `crypto.randomInt` rather than
`Math.random`. Supabase Auth stores its own password hashes. Everything crosses
the network over TLS, now forced (item 19).

Not done: `sender_phone` and `recipient_phone` sit in plaintext columns. That
matters more than it usually would, because **the last four digits of
`sender_phone` are a credential on this rail**, not an identifier: they are the
whole guard on three public routes, one of which returns the delivery code.

**What closes it:** `db/migrations/2026-09-07_dispatch_reader_masked_view.sql`,
applied to both networks. It takes the direct column grants away from
`gyema_reader` and gives it masked views instead, so the operator report stops
printing the guard for every job. Written, reviewed, not applied. Step 9 in
`docs/deploy-order.md`.

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

Depends on `scripts/backfill-app-metadata.mjs` having run per network, step 2 of
`docs/deploy-order.md`. Until it does, a pre-existing Pioneer has no
`app_metadata` claim and is refused, which is a functional failure rather than a
security one: the code fails in the safe direction.

### 7. Lock record access: Partial

The policies and grants are written and are the best-documented artefacts in the
repository. They are not confirmed applied, and by invariant 8 a file is not
catalog state.

Two files carry it. `2026-09-07_grant_baseline.sql` drops the Supabase default
table-wide grants to anon and authenticated and re-grants per column, with the
note that a column-level revoke cannot subtract from a table-wide grant.
`2026-09-07_identity_from_app_metadata.sql` moves the policies onto the claim
only the service-role key can write.

**What closes it:** applying both, per network, Testnet first, then running
`docs/catalog-checks.sql` and reading the result rather than the Success banner.
Steps 4 through 7 in `docs/deploy-order.md`.

### 8. Block field tampering: Partial

The guest rail is done and is the pattern to copy. `status`, `quote_cedis` and
`tracking_id` are all derived server side in `app/api/guest/create/route.ts`, and
`phone_verified` is written false on every insert with nothing in the codebase
able to flip it.

The Pioneer rail is not. `lib/listings-async.ts` still sends `posted_by_id`,
`status`, `tracking_id` and `created_at` from the client through the authed
Supabase client. Whether one Pioneer can post as another therefore depends
entirely on the `listings` INSERT policy, which is the one policy body nobody
in this repository has read.

**What closes it:** an INSERT policy on `listings` with a `WITH CHECK` binding
`posted_by_id` to the session claim, plus column defaults for `status`,
`tracking_id` and `created_at`, or moving creation to a server route the way
`cancel-open`, `cancel-matched` and `mark-in-transit` already moved. This is
finding S-15 and it is the only Partial on this list that is a code change in
this repository.

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

### 11. Rate limit login: Done on this branch, Partial on both mains

**Mainnet and Testnet `main` today: nothing rate limits anything.** That is
finding S-5 and it is still open on both.

On `phase-5-limits`: `lib/rate-limit.ts` puts a shared Upstash counter in front
of `/api/auth/verify` and every other route a stranger can reach, checked before
the Pi Platform round trip so a flood is refused before it is paid for. Forty
per five minutes per address, which is one sign-in every seven seconds
sustained. Keys are namespaced per network on the Supabase project ref, so the
single shared Upstash database cannot let a Testnet flood eat a Mainnet window.

Two caveats worth writing down rather than discovering later. It fails open on a
Redis error, deliberately, because this route is the only way anybody signs in.
And Upstash credentials are set on Production only, so **preview deployments run
with no limiter at all**, which is correct for a preview and worth knowing
before one is shared.

### 12. Add bot protection: Partial

Cloudflare Turnstile ships on this branch, on the guest post flow, verified
server side in `lib/turnstile.ts`. Configuration fails open and verification
fails closed, and both directions are tested.

Three reasons it is not Done.

First, **it has not been seen working in Pi Browser.** The widget renders in an
iframe from `challenges.cloudflare.com` and the app is itself framed by a Pi
Browser proxy. The CSP names that origin in all four directives it needs, so the
policy is not the blocker, but a desktop pass cannot tell you a challenge solves
inside Pi Browser any more than it could tell you the Pi SDK authenticates
there. That lesson is already written into `lib/csp.ts` and it applies again.

Second, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` bakes at build time, so the keys
existing in Vercel is not the same as the check running. It needs a redeploy.

Third, it is on guest creation and **not** on the three last-4 routes, which are
also stranger-submittable. That was a judgement call: those routes are reached
by a sender standing at a door, they already carry permanent per-job attempt
ceilings, and putting an interactive challenge in front of a delivery
confirmation risks the worst false positive in the application. The helper is
one line to apply if that call is wrong.

**What closes it:** a Testnet redeploy, then opening the guest post page in Pi
Browser, fully closed and reopened first because Pi Browser caches the bundle
hard, and confirming the widget renders and the post succeeds.

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
and a CSP with a per-request nonce that names every Pi origin read out of the
SDK bundle's own source rather than guessed, plus the Turnstile origin.
`tests/headers.test.ts` and `tests/csp.test.ts` cover them.

**The CSP is report-only.** `cspHeaderName` sends
`Content-Security-Policy-Report-Only` unless `CSP_ENFORCE` is exactly `"true"`,
and that default is deliberate: enforcing an earlier version of this policy on
Testnet broke sign-in, and the desktop pass that had looked clean could not have
caught it, because `frame-ancestors` is inert when the page is not framed and
`connect-src` is never exercised until a real `Pi.authenticate` runs.

**What closes it:** open Testnet in Pi Browser with the policy in report mode,
read the console, and set `CSP_ENFORCE=true` only if it is silent. A policy that
blocks nothing is not a header set.

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
| S-5 no rate limiting or bot protection | HIGH | Closed on this branch. Open on both mains |
| S-7 no security headers | HIGH | Closed, CSP report-only. Item 18 |
| S-8 `PIONEER_PASSWORD_SALT` single point | HIGH | Mitigated by `lib/env-guard.ts`. Rotation is hosted |
| S-9 Pi token in localStorage | HIGH | Closed. No longer persisted |
| S-11 raw Pi error echoed to the caller | MEDIUM | Closed |
| S-12 no caps on guest free text | MEDIUM | Closed. `lib/schemas.ts` |
| S-14 dispatch reader prints the guard | MEDIUM | Migration written, not applied. Item 5 |
| S-15 client-supplied Pioneer listing fields | MEDIUM | **Open.** Item 8 |
| S-16 type and lint errors cannot fail a build | MEDIUM | **Open.** Item 20 |
| S-17 `Math.random` tracking IDs | MEDIUM | **Open.** Mitigated, not fixed: the tracker's rate limit makes scanning impractical from one address, which is not the same as making the ID unguessable |
| S-18 PostgREST filter interpolation | LOW | **Open**, bounded. Item 13 |
| S-6, S-10, S-13, S-19 through S-23 | MEDIUM/LOW | Unchanged since the inventory |

Two things nothing in this repository can answer, both restated because they
have not moved: **what sets `guest_jobs.phone_verified = true`** is not in this
codebase and the whole guest rail's visibility gate depends on it, and the
catalog state of both databases is unread.

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

### Testnet, first

1. Review this branch. Nothing here is merged and nothing is pushed.
2. Merge `phase-5-limits`. The gate is both facts: `main` fast-forwards on
   `git pull` **and** a new Production deployment appears. A green branch build
   is not a merge.
3. The redeploy is what bakes `NEXT_PUBLIC_TURNSTILE_SITE_KEY` into the client,
   so the bot check does not exist until it happens.
4. In Pi Browser, fully closed and reopened first: post a guest delivery and
   confirm the Turnstile widget renders and the post succeeds. Track a job.
   Sign in. Read the console for CSP violations while the policy is still in
   report mode.
5. Only if that console is silent, set `CSP_ENFORCE=true` and redeploy.
6. Then the migrations, in the order in `docs/deploy-order.md`, one statement at
   a time, each verified from catalog state rather than from a Success banner.

### Mainnet, second, and only on an explicit go-ahead per change

Mirror through the blob-hash gate in CLAUDE.md, checked twice, with the
existence test on the target path. `git diff --no-index` is not the gate.

Before Mainnet is asked for at all, these Testnet checks have to have passed:

| Change | The Testnet check that gates it |
|---|---|
| The limiter | A guest post, a track lookup, a last-4 confirmation and a sign-in all succeed in Pi Browser with Upstash configured |
| Turnstile | The widget renders and solves in Pi Browser, and a post with it succeeds |
| Turnstile keys on Mainnet | Not set until the Testnet check above passes. Setting them is what switches the check on |
| Upstash keys on Mainnet | Already set. The namespace test proves a Testnet flood cannot reach a Mainnet window, but that is a unit test and not a live one |

Scan the file set for `pinet\.com|Testnet|testnet|8841|3681` before mirroring.
Nothing added on this branch hits that scan, so this mirror is bytes rather than
hand-applied changes, with `CLAUDE.md` the usual documented exception.
