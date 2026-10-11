# Gyema Delivery Anchoring and Courier Trust Bureau Spec

As of 8 Oct 2026. Living version: the living spec (private, founder-held), "Gyema Delivery Anchoring and Courier Trust Bureau Spec". This file is a copy for Claude Code sessions.

## Decisions locked on 8 Oct 2026

- Couriers: Pioneer couriers and legacy couriers (Bolt, Yango, Uber) both accepted. Legacy couriers carry guest jobs; the Pioneer rail pays in Pi, so it also needs a Pi account.
- Full courier status = Pi KYC verified. Legacy couriers reach it through PiVerify. Sign-ups wait in a buffer zone while review is pending.
- Buffer limits: guest jobs only, both areas on the guest area list (Greater Accra), declared value capped at GHS 200. Review pending past 30 days pauses the courier. Buffer deliveries count toward reputation after approval.
- Anchoring: hourly Merkle batching. Proof within the hour; no txid at handoff.
- Fees: dedicated low-balance anchoring wallet, separate from the Mainnet revenue wallet.
- Identity on chain: salted commitments only, revealed at the courier's choice.
- Records at launch: completions only. Failures added once an appeal process exists.
- Readers: courier-controlled disclosure only. Third-party queries wait for counsel.

## Scope

The chain records proof of work done, never value moved or personal details. Guest jobs can be anchored without blending rails because the only Pi spent is Gyema's own fee.

- On chain: salted job hash, event type and timestamp (inside the leaf hash), salted courier commitment, KYC approval event.
- Never on chain, hashed or not: phones, names, Ghana Card numbers, anything about the guest sender.
- Only server-side attestations are anchored: accept, pickup stamp, delivery stamp. SQL-set statuses are never anchored. Only Gyema-dispatched deliveries are covered.

## Courier status ladder (PiVerify statuses)

- Registered (created, started): no jobs.
- Buffer (pending_review): guest jobs, listed Accra areas, declared value up to GHS 200.
- Full courier (approved): all guest jobs; Pioneer rail with a Pi account.
- Paused (rejected, failed, or pending 30+ days): no jobs, history held. New KYC session returns to Registered; late approval goes to Full.

## Anchoring architecture

1. Attestation event closes server side; leaf = SHA-256 of canonical record (salted job hash, event type, timestamp, courier commitment, network, attestor).
2. Leaf appended to `anchor_leaves` (append-only, service_role only).
3. Hourly job builds the Merkle tree; root and inclusion paths stored in `anchor_batches`.
4. One transaction from the anchoring wallet carries the root as a 32-byte hash memo on a bump sequence operation. No Pi moves.
5. txid and ledger written back; each leaf has a proof (leaf, path, root, txid).
6. Anyone verifies by recomputing the leaf, walking the path, and matching the memo on a Pi explorer.

Empty hours send nothing. Cost at 1,000 deliveries a day, assuming 0.01 Pi per transaction (secondary reporting; confirm via Horizon fee stats): per event about 900 Pi/month; hourly root about 7.2 Pi/month; daily root about 0.3 Pi/month.

Anchoring wallet: about one month of fees plus minimum balance; key in server env only; never receives revenue; manual top-up; alert below seven days of fees.

## Identity, carry-over and erasure

- Courier commitment = SHA-256(courier salt, courier UUID). 32-byte random salt per courier, off chain. Never a phone or ID number.
- Job reference = SHA-256(job salt, tracking ID). Tracking IDs are GYM- plus 3 random bytes (about 16.7 million values), so salting is required.
- KYC approval is one more anchored event on the same commitment, so buffer history carries over with no re-binding.
- Disclosure: courier gets a proof link (salt, leaf data, paths); merchants or insurers verify without Gyema.
- Crypto-shredding: deleting a courier's salt and off-chain rows makes their on-chain hashes unlinkable. Serves erasure requests and rejected buffer records after the retention window.

## Trust bureau

- Launch record: attested completions, KYC approval event, tenure.
- Waits for an appeal process: attested failures (no-handoff watchdog, resolved disputes).
- Regulatory (not legal advice; counsel to confirm): register with the Data Protection Commission under the Data Protection Act 2012 (Act 843); PiVerify keeps Pi as controller of KYC documents and biometrics; supplying records to lenders moves toward Credit Reporting Act 2007 (Act 726) and Bank of Ghana licensing, so third-party queries stay off.

## Gates and build sequence (Testnet first; Mainnet only on go-ahead via blob-hash gate)

Gates:
1. Mainnet F17 tail: code is on Mainnet (confirm-completion route and 2026-08-14 migration file at aeb9514). Confirm the migration is applied on the Mainnet database with the catalog check.
2. F14: only attested closures anchor; SQL-closed and uncoded older guest jobs excluded.
3. PiVerify: cherry-pick `ed98f9f` onto current main (applies cleanly, 2 new files); drop the drill-route commits; never merge the branch (cut 18 Jul, would delete about 21,000 lines of hardening).
4. Pioneer KYC: answered. `/v2/me` returns no KYC status; sign-in as proof of KYC is an unverified assumption. Pioneers go through PiVerify too, unless Pi confirms the behaviour in writing.

Added ahead of the build: courier registry (UUID, class, status, salt, PiVerify session; retire orphan `couriers` and `legacy_couriers`), legacy courier sign-in (non-Pi session), `declared_value_cedis` on guest create, PiVerify webhook fixes.

Build:
5. Migration for `anchor_leaves` and `anchor_batches`; service_role only; explicit revokes on new functions.
6. Leaf writer hooked into attestation routes, with tests.
7. Hourly batch: Vercel Hobby allows only daily cron, so Supabase pg_cron calls `/api/cron/anchor` hourly through pg_net, behind the existing CRON_SECRET bearer pattern. Add `@stellar/stellar-sdk` with the Pi network passphrase per network in env.
8. Status ladder and buffer limits enforced in the accept route.
9. Public verify page.
10. Two weeks of Testnet anchoring.
11. Mainnet: fund anchoring wallet, mirror on go-ahead.
12. Demand test: proof links to named Pioneer and legacy couriers with a direct pitch.

## Code alignment review (8 Oct 2026; Testnet main f4d1032, Mainnet main aeb9514)

| Spec point | Code today | Change needed |
| --- | --- | --- |
| Anchor attested events only | Guest delivery closes in `guest_stamp_delivery` after both stamps; all jobs accepted since the delivery-code feature are coded. Pioneer completion closes in `listing_confirm_completion`. | Write leaves where each RPC returns the closed row. Skip uncoded older jobs (one sender stamp, never set to delivered). |
| Pickup event | `confirm-pickup` sender last-4 stamp moves accepted to in_transit. | Anchor as a sender attestation; record attestor in leaf. |
| Courier commitment | No courier registry. Guest jobs store `pi_username`; listings store `pi_uid`. `couriers` and `legacy_couriers` exist in the databases but nothing references them. | New courier table; retire the orphans. |
| Legacy courier sign-in | Every courier route resolves identity from a Pi session via `resolveCaller`. | Net new non-Pi courier session. Largest build item. |
| Pioneer KYC | `lib/pi-platform.ts` notes `/v2/me` returns no KYC status and assumes Pi Browser refuses non-KYC accounts. | PiVerify for Pioneers too, unless Pi confirms in writing. |
| GHS 200 buffer cap | No parcel value field; `quote_cedis` is the delivery fee. | Add `declared_value_cedis` at guest create (also feeds parcel cover). |
| Accra only | Area list is Greater Accra only, but off-list free-text corridors exist (`pending_quote`). | Buffer couriers take only jobs with both areas listed. |
| Salted job hash | Tracking IDs are GYM- plus 3 random bytes. | Matches spec. |
| PiVerify rebase | `ed98f9f` cherry-picks cleanly. | Signature has no timestamp (replayable); status writes unordered (replayed "started" can overwrite "approved"). Re-fetch session before acting, forward moves only, store processed event ids. |
| Hourly scheduler | One daily Vercel cron behind `CRON_SECRET`; no Supabase functions folder. | `/api/cron/anchor` on the same pattern, triggered by pg_cron via pg_net. |
| Transaction building | No Stellar SDK dependency. | Add `@stellar/stellar-sdk`. |
| Mainnet F17 tail | Route and migration file present on Mainnet. | Confirm migration applied via catalog check. |

## Open questions

- Retention window before rejected or failed buffer records are shredded.
- Will Pi confirm in writing that Pi Browser refuses sign-in to accounts without KYC?
- Live fee per transaction from Horizon fee stats.
- Bump sequence with hash memo proven on Pi Testnet.
- PiVerify production terms and final base URL (staging domain due to change).
- Counsel: Act 843 registration, Act 726 line, GHS 200 buffer cap against the GHS 500 Trancova pilot liability cap.

## Risks

- A verified record may not recruit couriers: demand test (step 12) before scaling.
- Buffer courier loses a parcel: guest only, GHS 200 cap, listed areas only.
- Anchoring key compromise: low balance, server-only key.
- Wrong negative record: completions only until appeals exist.
- Unverified figures (IJPE 15 to 30%, "Deloitte 2024" 40%) in the project brief stay out of public copy until sourced.
