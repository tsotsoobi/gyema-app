// POST /api/a2u/payout
//
// Admin-initiated App-to-User Pi payment. Sends Test-pi (or live pi, on
// Mainnet) from the app wallet to a known Pioneer, identified by their
// pi_username. Used to clear the 10-transaction Process-Transaction gate
// on Testnet, and (eventually) for delivery payouts in production once
// the Soroban escrow contract takes over.
//
// Flow:
//   1. Admin caller POSTs with Authorization: Bearer <A2U_ADMIN_SECRET>
//   2. Server resolves pi_username -> canonical pi_uid via pioneers table
//   3. Server claims the reward_ref by inserting an a2u_payments row
//      (ON CONFLICT DO NOTHING -- atomic idempotency at the database)
//   4. Server calls pi.createPayment(...) -> stores returned payment_id
//   5. Server calls pi.submitPayment(payment_id) -> stores returned txid
//   6. Server calls pi.completePayment(payment_id, txid) -> marks done
//
// Each lifecycle step persists its result to a2u_payments BEFORE the next
// step runs. If the function crashes (timeout, exception), the row's
// status column tells us exactly where we stopped. The SDK's built-in
// double-submit guard prevents re-submitting a payment that already has
// a txid on chain.
//
// IMPORTANT: this route MUST run on the Node.js runtime. The pi-backend
// SDK imports stellar-sdk, which uses Node-native crypto and TextDecoder.
// Edge runtime would fail at module load.
//
// IMPORTANT: A2U payments must run STRICTLY SEQUENTIALLY across the whole
// app -- the Pi Blockchain sequence-number requirement makes concurrent
// signed transactions from the same wallet fail. The route serialises a
// single payment per invocation; the caller is responsible for not firing
// parallel requests. For the 10-transaction gate clearance, this means
// one payout, wait for response, then next payout.
//
// Idempotency: keyed on reward_ref. Two invocations with the same
// reward_ref will result in only the first being processed; the second
// returns the existing row's state.

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import PiNetwork from "pi-backend"
import { createAdminClient } from "@/lib/supabase-admin"

// Force Node.js runtime -- required for pi-backend's stellar-sdk dependency.
export const runtime = "nodejs"

// No caching -- every payout is a fresh side-effecting operation.
export const dynamic = "force-dynamic"

// Reasonable serverless budget. Pi blockchain submit can take a few
// seconds; we allow 30s to be generous without inviting silent hangs.
export const maxDuration = 30

type A2UFailureReason =
  | "MISSING_AUTH"
  | "INVALID_AUTH"
  | "MALFORMED_BODY"
  | "INVALID_BODY"
  | "PIONEER_NOT_FOUND"
  | "DUPLICATE_REWARD_REF"
  | "CONFIG_ERROR"
  | "CREATE_FAILED"
  | "SUBMIT_FAILED"
  | "COMPLETE_FAILED"
  | "DATABASE_ERROR"

type A2UPhase = "auth" | "validate" | "claim" | "create" | "submit" | "complete"

type A2UFailure = {
  ok: false
  reason: A2UFailureReason
  message: string
  phase: A2UPhase
  reward_ref?: string
}

type A2USuccess = {
  ok: true
  reward_ref: string
  payment_id: string
  txid: string
  recipient_uid: string
  amount: number
  elapsed_ms: number
  phase_elapsed: {
    auth: number
    claim: number
    create: number
    submit: number
    complete: number
  }
}

type A2UBody = {
  reward_ref: string
  pi_username: string
  amount: number
  memo?: string
}

// Truncate an ID for safe logging.
function shortId(id: string): string {
  return id.slice(0, 8)
}

// Verify Authorization: Bearer <secret> against A2U_ADMIN_SECRET using
// constant-time comparison. Returns true on match, false on missing or
// mismatched header.
function verifyAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false
  }
  const provided = authHeader.slice("Bearer ".length).trim()
  const expected = process.env.A2U_ADMIN_SECRET
  if (!expected) {
    // Missing config is treated as deny -- never accept a request when
    // the comparison target is undefined.
    console.error("[a2u/payout] A2U_ADMIN_SECRET is not configured")
    return false
  }
  // timingSafeEqual requires equal-length buffers. Length difference is
  // itself information, so we check it via constant-time fallback by
  // comparing against an equal-length buffer of zeros.
  const providedBuf = Buffer.from(provided, "utf8")
  const expectedBuf = Buffer.from(expected, "utf8")
  if (providedBuf.length !== expectedBuf.length) {
    // Burn an equivalent comparison so timing doesn't leak length info.
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(providedBuf, expectedBuf)
}

// Validate the JSON body shape and types. Returns the typed body on
// success or an error message on failure.
function validateBody(raw: unknown): { body: A2UBody } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Body must be a JSON object" }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.reward_ref !== "string" || obj.reward_ref.length === 0) {
    return { error: "reward_ref is required and must be a non-empty string" }
  }
  if (obj.reward_ref.length > 200) {
    return { error: "reward_ref must be 200 characters or fewer" }
  }
  if (typeof obj.pi_username !== "string" || obj.pi_username.length === 0) {
    return { error: "pi_username is required and must be a non-empty string" }
  }
  if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount) || obj.amount <= 0) {
    return { error: "amount is required and must be a positive number" }
  }
  if (obj.memo !== undefined && (typeof obj.memo !== "string" || obj.memo.length > 200)) {
    return { error: "memo, if provided, must be a string of 200 characters or fewer" }
  }
  return {
    body: {
      reward_ref: obj.reward_ref,
      pi_username: obj.pi_username,
      amount: obj.amount,
      memo: typeof obj.memo === "string" ? obj.memo : undefined,
    },
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const phaseElapsed = {
    auth: 0,
    claim: 0,
    create: 0,
    submit: 0,
    complete: 0,
  }
  console.log("[a2u/payout] Request received", { ts: new Date().toISOString() })

  // -------- Phase: auth --------
  if (!verifyAdminAuth(req)) {
    const elapsed = Date.now() - startedAt
    console.warn("[a2u/payout] Rejected: auth failed", { ms: elapsed })
    return jsonError("INVALID_AUTH", "Invalid or missing admin credentials", "auth", 401)
  }
  phaseElapsed.auth = Date.now() - startedAt

  // -------- Phase: validate --------
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonError("MALFORMED_BODY", "Request body is not valid JSON", "validate", 400)
  }
  const validated = validateBody(raw)
  if ("error" in validated) {
    return jsonError("INVALID_BODY", validated.error, "validate", 400)
  }
  const { reward_ref, pi_username, amount, memo } = validated.body
  const finalMemo = memo ?? `Gyema reward ${reward_ref}`

  // -------- Phase: claim --------
  // Resolve the pi_username to canonical pi_uid, then claim the
  // reward_ref atomically. The ON CONFLICT clause is the idempotency
  // gate -- if a row already exists for this reward_ref, we don't
  // insert a new one, and we return the existing state.
  let admin
  try {
    admin = createAdminClient()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[a2u/payout] Admin client init failed", { error: msg })
    return jsonError("CONFIG_ERROR", "Server is misconfigured", "claim", 500, reward_ref)
  }

  // Pioneer lookup -- by canonical username, the same way auth-bridge
  // resolves identity. The pi_uid stored on the pioneer row is the
  // canonical one; Pi resolves it to a wallet address server-side.
  const { data: pioneer, error: pioneerError } = await admin
    .from("pioneers")
    .select("pi_uid, pi_username")
    .eq("pi_username", pi_username)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (pioneerError) {
    console.error("[a2u/payout] Pioneer lookup failed", {
      pi_username,
      error: pioneerError.message,
    })
    return jsonError(
      "DATABASE_ERROR",
      "Could not look up the recipient Pioneer",
      "claim",
      500,
      reward_ref
    )
  }
  if (!pioneer?.pi_uid) {
    console.warn("[a2u/payout] Pioneer not found", { pi_username })
    return jsonError(
      "PIONEER_NOT_FOUND",
      `No Pioneer found with username '${pi_username}'`,
      "claim",
      404,
      reward_ref
    )
  }
  const recipientUid = pioneer.pi_uid

  // Claim the reward_ref. ON CONFLICT DO NOTHING means: if another
  // invocation already inserted this reward_ref, we get no rows back.
  const { data: claimed, error: claimError } = await admin
    .from("a2u_payments")
    .insert({
      reward_ref,
      recipient_uid: recipientUid,
      amount,
      memo: finalMemo,
      status: "created",
      metadata: { pi_username, started_at: new Date().toISOString() },
    })
    .select()
    .maybeSingle()

  if (claimError) {
    // Postgres unique-violation error code is 23505. Supabase surfaces
    // this in error.code (some versions) or just in the message.
    const isDuplicate =
      claimError.code === "23505" ||
      /duplicate key|already exists/i.test(claimError.message)
    if (isDuplicate) {
      // Look up the existing row and return its state.
      const { data: existing } = await admin
        .from("a2u_payments")
        .select("*")
        .eq("reward_ref", reward_ref)
        .maybeSingle()
      console.warn("[a2u/payout] Duplicate reward_ref", {
        reward_ref,
        existing_status: existing?.status,
        existing_payment_id: existing?.payment_id
          ? shortId(existing.payment_id)
          : null,
      })
      return NextResponse.json(
        {
          ok: false,
          reason: "DUPLICATE_REWARD_REF" as const,
          message: "This reward_ref has already been processed",
          phase: "claim" as const,
          reward_ref,
          existing_state: existing,
        },
        { status: 409 }
      )
    }
    console.error("[a2u/payout] Claim insert failed", {
      reward_ref,
      error: claimError.message,
    })
    return jsonError(
      "DATABASE_ERROR",
      `Could not claim reward_ref: ${claimError.message}`,
      "claim",
      500,
      reward_ref
    )
  }
  if (!claimed) {
    // Shouldn't happen -- insert returned no row and no error -- but defensive.
    return jsonError(
      "DATABASE_ERROR",
      "Reward claim returned no row",
      "claim",
      500,
      reward_ref
    )
  }
  phaseElapsed.claim = Date.now() - startedAt - phaseElapsed.auth
  console.log("[a2u/payout] Claimed reward_ref", {
    reward_ref,
    recipient_uid: shortId(recipientUid),
    pi_username,
    amount,
    ms: phaseElapsed.claim,
  })

  // -------- Phase: create --------
  // Initialise the Pi SDK. Constructor validates the seed format
  // (starts with 'S', 56 chars) and throws if either env var is missing
  // or malformed. We catch and mark the row failed so the audit trail
  // shows where things died.
  const piApiKey = process.env.PI_API_KEY
  const walletSeed = process.env.APP_WALLET_PRIVATE_SEED
  if (!piApiKey || !walletSeed) {
    await markFailed(
      admin,
      reward_ref,
      "create",
      "PI_API_KEY or APP_WALLET_PRIVATE_SEED is not configured"
    )
    return jsonError("CONFIG_ERROR", "Pi SDK is not configured", "create", 500, reward_ref)
  }

  let pi: PiNetwork
  try {
    pi = new PiNetwork(piApiKey, walletSeed, { baseUrl: "https://api.testnet.minepi.com" })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(admin, reward_ref, "create", `SDK init failed: ${msg}`)
    return jsonError("CONFIG_ERROR", `Pi SDK init failed: ${msg}`, "create", 500, reward_ref)
  }

  let paymentId: string
  try {
    paymentId = await pi.createPayment({
      amount,
      memo: finalMemo,
      metadata: { reward_ref, pi_username },
      uid: recipientUid,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[a2u/payout] createPayment failed", { reward_ref, error: msg })
    await markFailed(admin, reward_ref, "create", `createPayment: ${msg}`)
    return jsonError("CREATE_FAILED", `Pi createPayment failed: ${msg}`, "create", 502, reward_ref)
  }

  const { error: updateAfterCreateError } = await admin
    .from("a2u_payments")
    .update({ payment_id: paymentId, status: "create_completed" })
    .eq("reward_ref", reward_ref)
  if (updateAfterCreateError) {
    // Pi has issued a payment id but we couldn't persist it. This is
    // recoverable -- getIncompleteServerPayments() will find it later --
    // but log loudly and abort the current invocation.
    console.error("[a2u/payout] Could not store payment_id after createPayment", {
      reward_ref,
      payment_id: shortId(paymentId),
      error: updateAfterCreateError.message,
    })
    return jsonError(
      "DATABASE_ERROR",
      "Pi createPayment succeeded but database update failed -- payment is in flight, do not retry",
      "create",
      500,
      reward_ref
    )
  }
  phaseElapsed.create =
    Date.now() - startedAt - phaseElapsed.auth - phaseElapsed.claim
  console.log("[a2u/payout] createPayment OK", {
    reward_ref,
    payment_id: shortId(paymentId),
    ms: phaseElapsed.create,
  })

  // -------- Phase: submit --------
  let txid: string
  try {
    txid = await pi.submitPayment(paymentId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[a2u/payout] submitPayment failed", {
      reward_ref,
      payment_id: shortId(paymentId),
      error: msg,
    })
    await markFailed(admin, reward_ref, "submit", `submitPayment: ${msg}`)
    return jsonError("SUBMIT_FAILED", `Pi submitPayment failed: ${msg}`, "submit", 502, reward_ref)
  }

  const { error: updateAfterSubmitError } = await admin
    .from("a2u_payments")
    .update({ txid, status: "submitted", submitted_at: new Date().toISOString() })
    .eq("reward_ref", reward_ref)
  if (updateAfterSubmitError) {
    console.error("[a2u/payout] Could not store txid after submitPayment", {
      reward_ref,
      payment_id: shortId(paymentId),
      txid: shortId(txid),
      error: updateAfterSubmitError.message,
    })
    return jsonError(
      "DATABASE_ERROR",
      "Pi submitPayment succeeded but database update failed -- the chain has the txid",
      "submit",
      500,
      reward_ref
    )
  }
  phaseElapsed.submit =
    Date.now() -
    startedAt -
    phaseElapsed.auth -
    phaseElapsed.claim -
    phaseElapsed.create
  console.log("[a2u/payout] submitPayment OK", {
    reward_ref,
    payment_id: shortId(paymentId),
    txid: shortId(txid),
    ms: phaseElapsed.submit,
  })

  // -------- Phase: complete --------
  try {
    await pi.completePayment(paymentId, txid)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[a2u/payout] completePayment failed", {
      reward_ref,
      payment_id: shortId(paymentId),
      txid: shortId(txid),
      error: msg,
    })
    // Don't mark failed here -- the on-chain payment is real. Mark a
    // distinct status so we know to manually complete via Pi's API.
    await admin
      .from("a2u_payments")
      .update({
        status: "complete_failed",
        error_message: `completePayment: ${msg}`,
      })
      .eq("reward_ref", reward_ref)
    return jsonError(
      "COMPLETE_FAILED",
      `Pi completePayment failed (payment is on chain, manual completion required): ${msg}`,
      "complete",
      502,
      reward_ref
    )
  }

  const { error: updateAfterCompleteError } = await admin
    .from("a2u_payments")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("reward_ref", reward_ref)
  if (updateAfterCompleteError) {
    console.error("[a2u/payout] Could not store completion state", {
      reward_ref,
      error: updateAfterCompleteError.message,
    })
    // Still success from the user's perspective -- the payment completed.
  }
  phaseElapsed.complete =
    Date.now() -
    startedAt -
    phaseElapsed.auth -
    phaseElapsed.claim -
    phaseElapsed.create -
    phaseElapsed.submit

  const totalElapsed = Date.now() - startedAt
  console.log("[a2u/payout] Payment completed", {
    reward_ref,
    payment_id: shortId(paymentId),
    txid: shortId(txid),
    recipient_uid: shortId(recipientUid),
    amount,
    total_ms: totalElapsed,
  })

  const response: A2USuccess = {
    ok: true,
    reward_ref,
    payment_id: paymentId,
    txid,
    recipient_uid: recipientUid,
    amount,
    elapsed_ms: totalElapsed,
    phase_elapsed: phaseElapsed,
  }
  return NextResponse.json(response, { status: 200 })
}

// Helper: structured error response.
function jsonError(
  reason: A2UFailureReason,
  message: string,
  phase: A2UPhase,
  status: number,
  reward_ref?: string
) {
  const body: A2UFailure = { ok: false, reason, message, phase, reward_ref }
  return NextResponse.json(body, { status })
}

// Helper: mark a row failed with an error message. Used for lifecycle
// failures where we want the audit trail to show what went wrong.
// Swallows its own errors -- if we can't update the row, the route's
// real failure response is what matters; the audit gap is a secondary
// concern.
async function markFailed(
  admin: ReturnType<typeof createAdminClient>,
  reward_ref: string,
  phase: A2UPhase,
  errorMessage: string
): Promise<void> {
  try {
    await admin
      .from("a2u_payments")
      .update({
        status: "failed",
        error_message: `${phase}: ${errorMessage}`,
      })
      .eq("reward_ref", reward_ref)
  } catch (e) {
    console.error("[a2u/payout] markFailed itself failed (non-fatal)", {
      reward_ref,
      phase,
      original_error: errorMessage,
      mark_failed_error: e instanceof Error ? e.message : String(e),
    })
  }
}

// All non-POST methods rejected.
export async function GET() {
  return NextResponse.json(
    { ok: false, reason: "METHOD_NOT_ALLOWED", message: "Use POST" },
    { status: 405 }
  )
}
