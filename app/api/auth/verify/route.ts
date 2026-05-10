// POST /api/auth/verify
//
// The Pi-KYC gate. This is the only path by which a Pioneer can
// obtain a Gyema session JWT. Every other authenticated endpoint
// expects a JWT issued by this route.
//
// Flow:
//   1. Frontend calls Pi.authenticate() in Pi Browser, gets accessToken
//   2. Frontend POSTs accessToken to this endpoint
//   3. Server calls Pi Platform /v2/me with the accessToken
//   4. If valid: server upserts the Pioneer into Supabase users (if
//      we had a users table), then issues a Supabase JWT
//   5. Frontend stores the JWT and uses it for all Supabase requests
//
// The structured error responses (KYC_NOT_VERIFIED, etc.) let the
// frontend render specific guidance per failure mode rather than
// a single generic "sign-in failed" message.
//
// IMPORTANT: this route MUST run on the Node.js runtime (not Edge)
// because the `jsonwebtoken` library uses Node's crypto module,
// which Edge runtime doesn't expose.

import { NextRequest, NextResponse } from "next/server"
import { verifyPiAccessToken } from "@/lib/pi-platform"
import { issueSupabaseJWT } from "@/lib/jwt"

// Force Node.js runtime — required for jsonwebtoken's crypto.
export const runtime = "nodejs"

// No caching — every verification is a fresh check.
export const dynamic = "force-dynamic"

type GateFailureReason =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "PI_PLATFORM_ERROR"
  | "JWT_ISSUANCE_ERROR"
  | "MALFORMED_REQUEST"

type GateSuccess = {
  ok: true
  sessionToken: string
  pioneer: {
    pi_uid: string
    pi_username: string
  }
}

type GateFailure = {
  ok: false
  reason: GateFailureReason
  message: string
}

export async function POST(req: NextRequest) {
  // 1. Parse the request body.
  let body: { accessToken?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonError("MALFORMED_REQUEST", "Request body is not valid JSON", 400)
  }

  // 2. Validate the access token shape.
  const accessToken = body.accessToken
  if (!accessToken || typeof accessToken !== "string") {
    return jsonError(
      "MISSING_TOKEN",
      "accessToken is required and must be a string",
      400
    )
  }

  // 3. Verify the access token with Pi Platform.
  const piUser = await verifyPiAccessToken(accessToken)
  if (!piUser) {
    return jsonError(
      "INVALID_TOKEN",
      "Pi Platform could not verify this access token",
      401
    )
  }

  // 4. Issue a Supabase JWT for this Pioneer.
  let sessionToken: string
  try {
    sessionToken = issueSupabaseJWT({
      pi_uid: piUser.uid,
      pi_username: piUser.username,
    })
  } catch (error) {
    console.error("[auth/verify] JWT issuance failed:", error)
    return jsonError(
      "JWT_ISSUANCE_ERROR",
      "Server is misconfigured — please try again or contact support",
      500
    )
  }

  // 5. Success.
  const response: GateSuccess = {
    ok: true,
    sessionToken,
    pioneer: {
      pi_uid: piUser.uid,
      pi_username: piUser.username,
    },
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
