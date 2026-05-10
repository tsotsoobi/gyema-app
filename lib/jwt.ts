// Server-side Supabase JWT issuance for Pi-authenticated Pioneers.
//
// Runs ONLY in Next.js API routes (route.ts files under app/api/).
// Never imported into client components or browser-running code.
//
// The SUPABASE_JWT_SECRET environment variable is the symmetric secret
// shared with Supabase that signs and verifies JWTs. It must be set in
// Vercel's environment variables and NEVER committed to the repo.
//
// To find your Supabase JWT secret:
//   Supabase Dashboard → Project Settings → API → JWT Settings → JWT Secret
//
// IMPORTANT: this is a different value from the anon key or service_role
// key. The JWT secret is used to sign tokens, not to authenticate
// requests. Don't confuse them.

import jwt from "jsonwebtoken"

// Shape of a Pioneer who has passed the Pi auth gate.
// This is the input to JWT issuance — what we know to be true after
// /v2/me verification succeeded.
export type VerifiedPioneer = {
  pi_uid: string
  pi_username: string
}

// Token lifetime. 24 hours is the practical maximum for a session;
// shorter would frustrate users (re-auth every few hours), longer
// would weaken the security model (a Pioneer banned by Pi retains
// access too long).
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 // 24 hours

/**
 * Issue a Supabase JWT for a verified Pioneer.
 *
 * The returned token is a signed JWT that the frontend includes in
 * the Authorization header on every Supabase request. Supabase
 * validates the signature using the same JWT_SECRET, then exposes
 * the claims to RLS policies via auth.jwt().
 *
 * The Pi UID becomes auth.jwt() ->> 'sub' in RLS — this is what
 * future strict RLS policies will compare against posted_by_id and
 * matched_with_user_id columns.
 *
 * Throws if SUPABASE_JWT_SECRET is missing — this is a configuration
 * error that should crash loudly, not return null silently.
 */
export function issueSupabaseJWT(pioneer: VerifiedPioneer): string {
  const secret = process.env.SUPABASE_JWT_SECRET

  if (!secret) {
    // Configuration error — crash loudly. The auth route should
    // catch this and return a 500 to the client.
    throw new Error(
      "[jwt] SUPABASE_JWT_SECRET is not configured in environment"
    )
  }

  if (!pioneer.pi_uid || !pioneer.pi_username) {
    throw new Error("[jwt] Cannot issue JWT for incomplete Pioneer object")
  }

  const now = Math.floor(Date.now() / 1000)

  const payload = {
    // Standard JWT claims
    sub: pioneer.pi_uid, // The "subject" — accessed in RLS via auth.jwt() ->> 'sub'
    iat: now, // Issued at
    exp: now + TOKEN_LIFETIME_SECONDS, // Expires
    // Supabase-required claim — tells RLS this is an authenticated user
    role: "authenticated",
    // Custom claims for our app — readable in RLS via auth.jwt() ->> 'pi_username'
    pi_username: pioneer.pi_username,
    // We don't store kyc_verified as a claim because passing the Pi
    // auth gate IS the KYC verification — there's no separate state.
    // Keeping the JWT minimal reduces what an attacker gets if a
    // token leaks.
  }

  return jwt.sign(payload, secret, { algorithm: "HS256" })
}

/**
 * Verify a Supabase JWT and return its claims, or null if invalid.
 *
 * Used by API routes that need to authenticate the calling Pioneer
 * before executing privileged actions. Pure verification — does not
 * issue new tokens, does not refresh.
 *
 * Returns null for any failure (expired, bad signature, malformed,
 * missing secret). Caller decides whether to surface specific errors.
 */
export function verifySupabaseJWT(
  token: string
): { sub: string; pi_username: string } | null {
  const secret = process.env.SUPABASE_JWT_SECRET

  if (!secret) {
    console.error("[jwt] SUPABASE_JWT_SECRET is not configured")
    return null
  }

  if (!token || typeof token !== "string") {
    return null
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as {
      sub?: string
      pi_username?: string
      role?: string
    }

    if (!decoded.sub || !decoded.pi_username) {
      console.warn("[jwt] Token verified but missing required claims")
      return null
    }

    return {
      sub: decoded.sub,
      pi_username: decoded.pi_username,
    }
  } catch (error) {
    // jsonwebtoken throws for: expired tokens, invalid signature,
    // malformed tokens, etc. We treat all as "not authenticated."
    return null
  }
}
