// Server-side PiVerify (Pi KYC) client for courier identity verification.
//
// Runs ONLY in Next.js API routes (route.ts files under app/api/).
// Never imported into client components or browser-running code: it holds
// the PiVerify secret API key, which must never reach the browser.
//
// PiVerify is Pi Network's KYC infrastructure offered as a third-party
// service. A session is created server-side; the applicant completes ID +
// liveness at a hosted URL; the result arrives by signed webhook or polling.
// Gyema never receives documents or biometrics, only session status. Pi
// remains the data controller.
//
// Every courier goes through PiVerify, Pioneer and legacy alike. Status lands
// on public.courier_registry, through public.courier_apply_kyc_status
// (db/migrations/2026-10-08_piverify_webhook.sql), never by a direct write.
//
// Env (server-side only, NEVER NEXT_PUBLIC_):
//   PIVERIFY_API_BASE_URL   base URL (staging piappengine.com domain; the
//                           docs warn this will change, so it is config,
//                           not a hardcoded constant)
//   PIVERIFY_API_KEY        secret key. sbx_ in sandbox, live_ in production.
//   PIVERIFY_WEBHOOK_SECRET HMAC key for verifying inbound webhook signatures.
//   PIVERIFY_ENABLED        the switch (item 10, decision 10). On only when it
//                           reads exactly "true". Production only, per
//                           network, unset until PiVerify authenticates for
//                           Gyema's account. Read through piverifyEnabled()
//                           and nothing else.

import { createHmac, timingSafeEqual } from "crypto"

// A hung PiVerify must not hold a function open. The webhook answers 503 on
// a timeout, and PiVerify retries.
const PIVERIFY_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const base = process.env.PIVERIFY_API_BASE_URL
  if (!base) {
    throw new Error("[piverify] PIVERIFY_API_BASE_URL is not configured")
  }
  return base.replace(/\/+$/, "")
}

function getApiKey(): string {
  const key = process.env.PIVERIFY_API_KEY
  if (!key) {
    throw new Error("[piverify] PIVERIFY_API_KEY is not configured")
  }
  return key
}

/**
 * Whether PiVerify is open to couriers (item 10, decision 10,
 * docs/anchoring-phase1-notes.md 10.7). True only when PIVERIFY_ENABLED is
 * exactly "true": unset, empty, "false", "TRUE", " true" and anything else
 * are off, so a typo fails closed. Server side, read per request; never
 * NEXT_PUBLIC_. While it is off, POST /api/courier/kyc/start and
 * /api/courier/kyc/refresh refuse before any PiVerify call, and
 * GET /api/courier/me tells the page to hide the verification button.
 * The webhook keeps its own gate, PIVERIFY_WEBHOOK_SECRET.
 */
export function piverifyEnabled(): boolean {
  return process.env.PIVERIFY_ENABLED === "true"
}

// ---------------------------------------------------------------------------
// Types (mirrors the PiVerify session object)
// ---------------------------------------------------------------------------

export const PIVERIFY_STATUSES = [
  "created",
  "started",
  "pending_review",
  "approved",
  "rejected",
  "failed",
] as const

export type PiVerifyStatus = (typeof PIVERIFY_STATUSES)[number]

export function isPiVerifyStatus(value: unknown): value is PiVerifyStatus {
  return typeof value === "string" && (PIVERIFY_STATUSES as readonly string[]).includes(value)
}

// On a rejected session, what PiVerify still allows on that same session:
// the courier resubmits, or appeals, through the hosted flow. Absent when the
// rejection is final.
export const PIVERIFY_ALLOWED_ACTIONS = ["RESUBMIT", "APPEAL"] as const

export type PiVerifyAllowedAction = (typeof PIVERIFY_ALLOWED_ACTIONS)[number]

export function isPiVerifyAllowedAction(value: unknown): value is PiVerifyAllowedAction {
  return typeof value === "string" && (PIVERIFY_ALLOWED_ACTIONS as readonly string[]).includes(value)
}

export interface PiVerifySession {
  id: string
  external_user_id: string
  status: PiVerifyStatus
  hosted_flow_url: string
  rejection_reason: string | null
  allowed_action?: PiVerifyAllowedAction | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Responses are checked, not cast
//
// A session is what the webhook acts on, so a response missing its id, its
// external_user_id or a known status is refused here rather than flowing on
// as a typed object that is not what its type says. So is an allowed_action
// that is present but not one of the two known values: it decides whether a
// rejection is final, and a value nobody has read must not decide it either
// way.
// ---------------------------------------------------------------------------

function asSession(value: unknown): PiVerifySession {
  const s = value as Partial<PiVerifySession> | null
  if (
    !s ||
    typeof s.id !== "string" ||
    s.id === "" ||
    typeof s.external_user_id !== "string" ||
    !isPiVerifyStatus(s.status)
  ) {
    throw new Error("[piverify] session response is missing id, external_user_id or a known status")
  }
  // The poll event id is built from updated_at (item 5, 5.4), so a session
  // without one cannot be told apart from the last observation.
  if (typeof s.updated_at !== "string" || s.updated_at === "") {
    throw new Error("[piverify] session response is missing updated_at")
  }
  if (s.allowed_action != null && !isPiVerifyAllowedAction(s.allowed_action)) {
    throw new Error("[piverify] session response carries an unknown allowed_action")
  }
  return s as PiVerifySession
}

/**
 * A PiVerify call answered with a non-2xx status. Typed, so a route can tell
 * a 402 (the account needs credit) from an outage without parsing a message.
 *
 * Upstream response bodies stay out of it. A route logs what it catches, and
 * a body in an error is a body in the log.
 */
export class PiVerifyHttpError extends Error {
  readonly op: string
  readonly status: number

  constructor(op: string, status: number) {
    super(`[piverify] ${op} failed: HTTP ${status}`)
    this.name = "PiVerifyHttpError"
    this.op = op
    this.status = status
  }
}

function upstreamError(op: string, status: number): PiVerifyHttpError {
  return new PiVerifyHttpError(op, status)
}

// ---------------------------------------------------------------------------
// Session ids and poll event ids (item 5, 5.4)
// ---------------------------------------------------------------------------

/**
 * The shape a session id must have before it is bound or polled: at most 64
 * of A-Z, a-z, 0-9, _ and -. No ':', so a poll event id built from it cannot
 * be ambiguous. courier_bind_piverify_session checks the same pattern.
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

export function isPiVerifySessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_SHAPE.test(value)
}

/** piverify_events.event_id is at most 128 characters (piverify_events_lengths_check). */
export const EVENT_ID_MAX = 128

/**
 * The event id a poll result is recorded under:
 *
 *   poll:<session_id>:<status>:<allowed_action or ->:<updated_at>
 *
 * updated_at goes in exactly as PiVerify returned it, never reformatted, so
 * the same observation always builds the same id and reads duplicate. A new
 * status, allowed action or updated_at is a new id, and applies once.
 *
 * Returns null when the id would be over 128 characters. The caller refuses
 * it and writes nothing: an id is never truncated, because a truncated id
 * could equal another observation's.
 */
export function pollEventId(
  session: Pick<PiVerifySession, "id" | "status" | "allowed_action" | "updated_at">
): string | null {
  const id = `poll:${session.id}:${session.status}:${session.allowed_action ?? "-"}:${session.updated_at}`
  return id.length > EVENT_ID_MAX ? null : id
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export async function createPiVerifySession(params: {
  external_user_id: string
  idempotency_key: string
}): Promise<PiVerifySession> {
  const res = await fetch(`${getBaseUrl()}/api/v1/kyc_sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      external_user_id: params.external_user_id,
      idempotency_key: params.idempotency_key,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(PIVERIFY_TIMEOUT_MS),
  })

  if (!res.ok) throw upstreamError("createSession", res.status)

  return asSession(await res.json())
}

// ---------------------------------------------------------------------------
// Session polling
//
// The webhook's source of truth. A webhook says something changed; this says
// what the session is now.
// ---------------------------------------------------------------------------

export async function getPiVerifySession(
  sessionId: string
): Promise<PiVerifySession> {
  const res = await fetch(
    `${getBaseUrl()}/api/v1/kyc_sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${getApiKey()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(PIVERIFY_TIMEOUT_MS),
    }
  )

  if (!res.ok) throw upstreamError("getSession", res.status)

  return asSession(await res.json())
}

// ---------------------------------------------------------------------------
// Webhook signature verification
//
// HMAC-SHA256 over the raw body. The signature carries no timestamp, so a
// captured request can be replayed byte for byte and will verify. The webhook
// route does not rely on this check for freshness: it re-fetches the session
// and acts only on what PiVerify reports now, and it stores every event id it
// has processed.
// ---------------------------------------------------------------------------

export function verifyPiVerifyWebhook(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secret: string
): boolean {
  if (!signature) return false

  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody).digest("hex")

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false

  return timingSafeEqual(a, b)
}

export function getPiVerifyWebhookSecret(): string {
  const secret = process.env.PIVERIFY_WEBHOOK_SECRET
  if (!secret) {
    throw new Error("[piverify] PIVERIFY_WEBHOOK_SECRET is not configured")
  }
  return secret
}
