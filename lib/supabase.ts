// Supabase client configuration.
//
// Three patterns coexist here:
//
// 1. The default `supabase` client uses the anon key. It's the
//    pre-authentication client used for public reads (browsing
//    open listings) and during the auth handshake itself. RLS
//    policies treat its requests as the anonymous role.
//
// 2. The `createAuthedSupabase(jwt)` factory creates a per-request
//    client carrying a Pioneer-issued JWT. This is what gets used
//    after a Pioneer signs in. RLS policies treat its requests as
//    the authenticated role and have access to auth.jwt() claims
//    (sub, pi_username, etc.).
//
// 3. The `getAnonClient()` / `getAuthedClient()` helpers wrap the
//    above two patterns under intent-revealing names. Call sites
//    in lib/listings-async.ts use these instead of importing
//    `supabase` directly, so the security boundary is documented
//    at every query site.
//
// IMPORTANT: never use the anon-key `supabase` client to write
// listings, deliveries, or any user-scoped data once strict RLS is
// in place. Use getAuthedClient() for those operations.

import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseSession } from "./pi-network"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Default client — anon key, no JWT. Used for:
// - Public reads (open listings feed)
// - The auth flow itself (before a Pioneer has a JWT)
// - Anything that should work for unauthenticated visitors
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/**
 * Create a Supabase client carrying a Pioneer's JWT.
 *
 * Used after sign-in: the JWT issued by /api/auth/verify is passed
 * here so subsequent reads/writes are scoped to the authenticated
 * Pioneer (RLS sees auth.jwt() ->> 'sub' = pi_uid).
 *
 * The client is "fresh" per-call rather than memoized because:
 * - JWTs expire (24h); a stale memoized client would silently fail
 * - Different parts of the app may use different JWTs simultaneously
 *   (admin views, impersonation in v3, etc.)
 * - The cost of createClient() is negligible
 *
 * @param jwt - The Supabase JWT from /api/auth/verify
 * @returns A Supabase client that authenticates as the JWT's subject
 */
export function createAuthedSupabase(jwt: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
    auth: {
      // We're not using Supabase's own auth — Pi auth happens via
      // /api/auth/verify and the JWT is supplied externally.
      // Disable Supabase's session persistence to avoid conflicts.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

/**
 * Returns the always-anonymous Supabase client.
 *
 * Use for: public reads (browsing open listings, tracking by ID).
 * Never use for: writes, user-scoped reads.
 *
 * This is just the existing `supabase` export, re-surfaced under a
 * name that documents intent at the call site. When you read
 * `getAnonClient()` in a query you immediately know this is a
 * deliberately public operation.
 */
export function getAnonClient(): SupabaseClient {
  return supabase
}

/**
 * Returns a Supabase client carrying the current Pioneer's JWT.
 *
 * Throws if there is no in-memory Supabase session — callers must
 * either ensure the user is signed in, or use getAnonClient() for
 * public operations.
 *
 * Use for: writes, user-scoped reads (My Activity), accept/cancel/
 * confirm operations.
 *
 * The thrown error is intentional: silently falling back to anon
 * would mean writes hit RLS as anonymous role and silently fail
 * once policies tighten. Fail-loud here exposes the bug at the
 * exact call site instead of producing mysterious empty result sets.
 */
export function getAuthedClient(): SupabaseClient {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    throw new Error(
      "[supabase] getAuthedClient() called without an active session. " +
        "Caller must verify sign-in state or use getAnonClient() for public operations."
    )
  }
  return createAuthedSupabase(session.accessToken)
}
