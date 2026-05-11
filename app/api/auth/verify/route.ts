// POST /api/auth/verify
//
// The Pi-KYC gate. This is the only path by which a Pioneer obtains
// a Supabase session. Every authenticated Supabase request from the
// frontend uses the access_token returned here.
//
// Flow:
//   1. Frontend calls Pi.authenticate() in Pi Browser, gets accessToken
//   2. Frontend POSTs accessToken to this endpoint
//   3. Server verifies the Pi accessToken with Pi Platform /v2/me
//   4. Server finds-or-creates a Supabase Auth user mapped to Pi UID
//   5. Server generates a real Supabase session for that user
//   6. Frontend stores access_token + refresh_token, uses them for all
//      Supabase requests (RLS sees auth.uid() = supabase user id)
//
// IMPORTANT: this route MUST run on the Node.js runtime. The Supabase
// admin SDK uses Node's crypto module, which Edge runtime doesn't expose.
//
// Logging: every phase logs to console with [auth/verify] prefix.
// Pi UIDs and Supabase IDs are truncated to first 8 chars in logs to
// preserve correlation without exposing full KYC-linked identifiers.

import { NextRequest, NextResponse } from "next/server"
import { verifyPiAccessToken } from "@/lib/pi-platform"
import {
  findOrCreatePioneerUser,
  generatePioneerSession,
} from "@/lib/supabase-admin"

// Force Node.js runtime — required for crypto.
export const runtime = "nodejs"

// No caching — every verification is a fresh check.
export const dynamic = "force-dynamic"

type GateFailureReason =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "PROVISIONING_ERROR"
  | "SESSION_ERROR"
  | "MALFORMED_REQUEST"

type GateSuccess = {
  ok: true
  pioneer: {
    pi_uid: string
    pi_username: string
    supabase_user_id: string
  }
  session: {
    access_token: string
    refresh_token: string
  }
}

type GateFailure = {
  ok: false
  reason: GateFailureReason
  message: string
}

// Truncate an ID for safe logging — preserves enough for correlation
// without exposing the full identifier.
function shortId(id: string): string {
  return id.slice(0, 8)
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  console.log("[auth/verify] Request received", {
    ts: new Date().toISOString(),
  })

  // 1. Parse the request body.
  let body: { accessToken?: unknown }
  try {
    body = await req.json()
  } catch {
    console.warn("[auth/verify] Rejected: MALFORMED_REQUEST", {
      ms: Date.now() - startedAt,
    })
    return jsonError("MALFORMED_REQUEST", "Request body is not valid JSON", 400)
  }

  // 2. Validate the access token shape.
  const accessToken = body.accessToken
  if (!accessToken || typeof accessToken !== "string") {
    console.warn("[auth/verify] Rejected: MISSING_TOKEN", {
      ms: Date.now() - startedAt,
    })
    return jsonError(
      "MISSING_TOKEN",
      "accessToken is required and must be a string",
      400
    )
  }

  // 3. Verify the access token with Pi Platform.
  const piUser = await verifyPiAccessToken(accessToken)
  if (!piUser) {
    console.warn("[auth/verify] Rejected: INVALID_TOKEN", {
      ms: Date.now() - startedAt,
    })
    return jsonError(
      "INVALID_TOKEN",
      "Pi Platform could not verify this access token",
      401
    )
  }
  console.log("[auth/verify] Pi token verified", {
    pi_uid: shortId(piUser.uid),
    pi_username: piUser.username,
    ms: Date.now() - startedAt,
  })

  // 4. Find or create the Supabase Auth user mapped to this Pi UID.
  let supabaseUserId: string
  let userCreated: boolean
  try {
    const result = await findOrCreatePioneerUser({
      pi_uid: piUser.uid,
      pi_username: piUser.username,
    })
    supabaseUserId = result.supabase_user_id
    userCreated = result.created
  } catch (error) {
    console.error("[auth/verify] User provisioning failed", {
      pi_uid: shortId(piUser.uid),
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
    })
    return jsonError(
      "PROVISIONING_ERROR",
      "Could not set up your Gyema account — please try again or contact support",
      500
    )
  }
  console.log("[auth/verify] User provisioned", {
    pi_uid: shortId(piUser.uid),
    supabase_user_id: shortId(supabaseUserId),
    created: userCreated,
    ms: Date.now() - startedAt,
  })

  // 5. Generate a Supabase session for the Pioneer.
  let session: { access_token: string; refresh_token: string }
  try {
    session = await generatePioneerSession({ pi_uid: piUser.uid })
  } catch (error) {
    console.error("[auth/verify] Session generation failed", {
      pi_uid: shortId(piUser.uid),
      supabase_user_id: shortId(supabaseUserId),
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
    })
    return jsonError(
      "SESSION_ERROR",
      "Could not create your Gyema session — please try again",
      500
    )
  }

  // 6. Success.
  console.log("[auth/verify] Sign-in complete", {
    pi_uid: shortId(piUser.uid),
    pi_username: piUser.username,
    supabase_user_id: shortId(supabaseUserId),
    new_user: userCreated,
    ms: Date.now() - startedAt,
  })

  const response: GateSuccess = {
    ok: true,
    pioneer: {
      pi_uid: piUser.uid,
      pi_username: piUser.username,
      supabase_user_id: supabaseUserId,
    },
    session,
  }

  return NextResponse.json(response, { status: 200 })
}

// Helper: structured error response.
function jsonError(
  reason: GateFailureReason,
  message: string,
  status: number
) {
  const body: GateFailure = { ok: false, reason, message }
  return NextResponse.json(body, { status })
}

// All other methods rejected.
export async function GET() {
  return NextResponse.json(
    { ok: false, reason: "METHOD_NOT_ALLOWED", message: "Use POST" },
    { status: 405 }
  )
}
