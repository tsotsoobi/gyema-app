// Server-side Supabase admin client for privileged operations.
//
// Runs ONLY in Next.js API routes (route.ts files under app/api/).
// Never imported into client components or browser-running code.
//
// Uses the service_role key, which BYPASSES Row-Level Security and
// has full access to the database. This is why it lives in a separate
// file with explicit warnings — to make accidental misuse harder.
//
// Used for:
// - Creating Supabase Auth users mapped to Pi-verified Pioneers
// - Issuing Supabase session tokens via admin.generateLink
// - Future v2 escrow operations that legitimately need to bypass RLS
// - Writing auth observability events (auth_events table)
//
// SUPABASE_SERVICE_ROLE_KEY must be set in Vercel's environment
// variables. NEVER committed to the repo. NEVER exposed to the client.

import { createClient, SupabaseClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

/**
 * Create a Supabase admin client.
 *
 * The client is per-call rather than memoized to make secret-leak
 * incidents easier to recover from (rotating the service_role key
 * doesn't require redeployment if no client is held in module state).
 *
 * @returns A Supabase client with service_role privileges
 */
export function createAdminClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!serviceRoleKey) {
    throw new Error(
      "[supabase-admin] SUPABASE_SERVICE_ROLE_KEY is not configured"
    )
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      // Admin clients don't have user sessions of their own.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

/**
 * Synthetic email format for Pi-verified Pioneers in Supabase Auth.
 *
 * Supabase Auth requires email-based or phone-based identifiers. Since
 * Pi UIDs are neither, we use a synthetic local-only domain that's
 * unmistakable as not being a real email address.
 *
 * Format: pi-{uid}@gyema.local
 *
 * The "@gyema.local" TLD is the IETF-reserved ".local" namespace
 * (RFC 6762), guaranteed to never resolve as a real domain.
 */
export function piUidToSyntheticEmail(piUid: string): string {
  return `pi-${piUid}@gyema.local`
}

/**
 * Find or create a Supabase Auth user for a Pi-verified Pioneer.
 *
 * The Pi UID is the source of truth for identity. This function ensures
 * a Supabase Auth user exists with that Pi UID embedded in their
 * synthetic email and user_metadata, creating one if needed.
 *
 * Returns the Supabase user ID (UUID) — this is what becomes
 * auth.uid() in RLS policies.
 *
 * Throws on any failure — the calling route should catch and return
 * a 500 to the client.
 */
export async function findOrCreatePioneerUser(params: {
  pi_uid: string
  pi_username: string
}): Promise<{ supabase_user_id: string; created: boolean }> {
  const admin = createAdminClient()
  const email = piUidToSyntheticEmail(params.pi_uid)

  // Check if user already exists by listing all users and filtering.
  // At v2.0 scale (small user base), this is acceptable. At higher
  // scale we'd add a pi_uid -> supabase_user_id mapping table.
  const { data: existingList, error: listError } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })

  if (listError) {
    throw new Error(`[supabase-admin] listUsers failed: ${listError.message}`)
  }

  const existing = existingList?.users?.find((u) => u.email === email)
  if (existing) {
    return { supabase_user_id: existing.id, created: false }
  }

  // Create new user.
  const syntheticPassword = derivePioneerPassword(params.pi_uid)
  const { data: newUser, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password: syntheticPassword,
      email_confirm: true, // Skip email verification — Pi already verified identity
      user_metadata: {
        pi_uid: params.pi_uid,
        pi_username: params.pi_username,
        provider: "pi-network",
      },
    })

  if (createError || !newUser?.user) {
    throw new Error(
      `[supabase-admin] createUser failed: ${createError?.message || "no user returned"}`
    )
  }

  return { supabase_user_id: newUser.user.id, created: true }
}

/**
 * Generate a Supabase session for a Pioneer.
 *
 * Returns the access_token and refresh_token that the frontend will
 * use to authenticate Supabase requests. These are signed by Supabase
 * with its own private key (the asymmetric signing keys system) and
 * RLS will see them as legitimate authenticated sessions.
 *
 * The session is generated via signInWithPassword using a deterministic
 * synthetic password. This is acceptable because:
 * - The synthetic email is non-routable (.local TLD)
 * - The "password" is server-derived from the Pi UID + a server secret
 * - The actual auth gate is Pi-KYC; Supabase Auth is just session storage
 */
export async function generatePioneerSession(params: {
  pi_uid: string
}): Promise<{ access_token: string; refresh_token: string }> {
  const admin = createAdminClient()
  const email = piUidToSyntheticEmail(params.pi_uid)
  const syntheticPassword = derivePioneerPassword(params.pi_uid)

  // Sign in with the deterministic password to get a real session.
  const { data: session, error: signInError } =
    await admin.auth.signInWithPassword({ email, password: syntheticPassword })

  if (signInError || !session?.session) {
    throw new Error(
      `[supabase-admin] signInWithPassword failed: ${signInError?.message || "no session"}`
    )
  }

  return {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
  }
}

/**
 * Derive a synthetic password for a Pioneer from their Pi UID.
 *
 * Uses a server-side secret (PIONEER_PASSWORD_SALT) so the derivation
 * is reproducible across requests but not predictable from the Pi UID
 * alone.
 */
function derivePioneerPassword(piUid: string): string {
  const salt = process.env.PIONEER_PASSWORD_SALT
  if (!salt) {
    throw new Error("[supabase-admin] PIONEER_PASSWORD_SALT is not configured")
  }
  // Simple HMAC-style derivation. Not for cryptographic security — the
  // password is for Supabase Auth's internal storage only.
  return `${piUid}.${salt}.gyema-v2`
}

// ============================================================================
// Auth observability
// ============================================================================

/**
 * Auth event types — must match the CHECK constraint on auth_events.event_type
 */
export type AuthEventType =
  | "request_received"
  | "pi_token_verified"
  | "user_provisioned"
  | "sign_in_complete"
  | "rejected_malformed"
  | "rejected_missing_token"
  | "rejected_invalid_token"
  | "failed_provisioning"
  | "failed_session"

/**
 * Record an auth event for observability.
 *
 * Writes to the auth_events table. Failures are deliberately swallowed —
 * observability must never break the auth flow.
 *
 * Pi UIDs and Supabase user IDs should be truncated to first 8 chars
 * before passing in, matching the convention in console logs.
 */
export async function logAuthEvent(event: {
  event_type: AuthEventType
  pi_uid_prefix?: string
  supabase_user_id_prefix?: string
  pi_username?: string
  user_created?: boolean
  error_message?: string
  elapsed_ms?: number
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from("auth_events").insert({
      event_type: event.event_type,
      pi_uid_prefix: event.pi_uid_prefix,
      supabase_user_id_prefix: event.supabase_user_id_prefix,
      pi_username: event.pi_username,
      user_created: event.user_created,
      error_message: event.error_message,
      elapsed_ms: event.elapsed_ms,
      metadata: event.metadata,
    })
    if (error) {
      console.error("[auth-observability] Insert failed:", error.message)
    }
  } catch (error) {
    // Swallow — observability must never break auth
    console.error("[auth-observability] Unexpected error:", error)
  }
}
