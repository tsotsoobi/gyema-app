// Server-side PiVerify (Pi KYC) client for identity verification of
// non-Pioneer (legacy) couriers.
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
// Two rails, never blended: this verifies LEGACY couriers (no Pi account),
// written to public.legacy_couriers. Pioneer couriers are KYC-verified via
// Pi Browser sign-in and live in the separate couriers/pioneers rail.
//
// Env (server-side only, NEVER NEXT_PUBLIC_):
//   PIVERIFY_API_BASE_URL   base URL (staging piappengine.com domain; the
//                           docs warn this will change, so it is config,
//                           not a hardcoded constant)
//   PIVERIFY_API_KEY        secret key. sbx_ in sandbox, live_ in production.
//   PIVERIFY_WEBHOOK_SECRET HMAC key for verifying inbound webhook signatures.

import { createHmac, timingSafeEqual } from "crypto"

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

// ---------------------------------------------------------------------------
// Types (mirrors the PiVerify session object)
// ---------------------------------------------------------------------------

export type PiVerifyStatus =
  | "created"
  | "started"
  | "pending_review"
  | "approved"
  | "rejected"
  | "failed"

export interface PiVerifySession {
  id: string
  external_user_id: string
  status: PiVerifyStatus
  hosted_flow_url: string
  rejection_reason: string | null
  allowed_action?: string | null
  created_at: string
  updated_at: string
}

export interface PiVerifyWebhookEvent {
  id: string
  type:
    | "kyc.session.started"
    | "kyc.session.pending_review"
    | "kyc.session.approved"
    | "kyc.session.rejected"
    | "kyc.session.failed"
  created_at: string
  data: {
    session_id: string
    external_user_id: string
    status: PiVerifyStatus
    rejection_reason: string | null
    allowed_action?: string | null
  }
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
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(
      `[piverify] createSession failed: ${res.status} ${detail}`.trim()
    )
  }

  return (await res.json()) as PiVerifySession
}

// ---------------------------------------------------------------------------
// Session polling
// ---------------------------------------------------------------------------

export async function getPiVerifySession(
  sessionId: string
): Promise<PiVerifySession> {
  const res = await fetch(
    `${getBaseUrl()}/api/v1/kyc_sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${getApiKey()}` },
    }
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(
      `[piverify] getSession failed: ${res.status} ${detail}`.trim()
    )
  }

  return (await res.json()) as PiVerifySession
}

// ---------------------------------------------------------------------------
// Webhook signature verification
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