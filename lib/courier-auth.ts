import { NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { hostnameOf, SURFACE_HEADER } from "@/lib/courier-host"
import { retryAfterHeaders } from "@/lib/rate-limit"

// Courier identity for the courier routes, in one place (Phase 1 item 5,
// docs/anchoring-phase1-notes.md 5.2 and 5.3).
//
// A legacy courier has no Pi account and no Supabase Auth user. They sign in
// on the courier host with a one-time code the founder issues, and get an
// opaque session: a random token in a host-only HttpOnly cookie, stored in
// the database only as sha256 of the token. resolveCourier turns that cookie
// back into a courier on every request.
//
// A SECOND IDENTITY TYPE, KEPT APART FROM THE FIRST. This file is separate
// from lib/route-auth.ts so the Pioneer routes' import graph never contains
// it, and tests/routes/identity-separation.test.ts checks that it does not.
// Neither resolver accepts the other's credential:
//
//   resolveCaller   reads accessToken from the JSON body and asks GoTrue.
//                   A gcs_ token is not a JWT, so GoTrue refuses it: 401.
//   resolveCourier  reads the cookie only. Never the body, never
//                   Authorization, and it never calls auth.getUser.
//
// CLAUDE.md invariant 1: the courier id comes from the session row, found by
// the hash of the cookie, never from the request.

/** The session cookie. __Host- makes the browser enforce host-only, Secure and Path=/. */
export const COURIER_COOKIE = "__Host-gyema_courier"

/** gcs_ plus base64url of 32 bytes. The prefix means it can never parse as a JWT. */
const SESSION_TOKEN_SHAPE = /^gcs_[A-Za-z0-9_-]{43}$/

/** A new session token: gcs_ plus base64url of 32 random bytes, 47 characters. */
export function newSessionToken(): string {
  return `gcs_${randomBytes(32).toString("base64url")}`
}

export function isSessionTokenShape(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN_SHAPE.test(value)
}

/**
 * sha256 of a string's UTF-8 bytes, as PostgREST's text form of a bytea.
 *
 * supabase-js sends RPC arguments as JSON, and PostgREST reads a bytea
 * parameter through its text input, so "\x" plus 64 hex characters arrives
 * as the 32 bytes the functions check for.
 */
export function sha256Bytea(text: string): string {
  return `\\x${createHash("sha256").update(text, "utf8").digest("hex")}`
}

/**
 * The session token from the Cookie header, or null.
 *
 * Only the Cookie header is read. A token in the body or in Authorization is
 * not a courier credential and is never looked at.
 */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== COURIER_COOKIE) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

/** Set-Cookie for a new session. No Domain, so the cookie stays on this host. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COURIER_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
}

/**
 * Set-Cookie that clears the session. Same name, Secure and Path=/: a browser
 * ignores a __Host- clear without them.
 */
export function clearedSessionCookie(): string {
  return `${COURIER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

/** Whether middleware put this request on the courier surface. It always overwrites the header. */
export function onCourierSurface(request: Request): boolean {
  return request.headers.get(SURFACE_HEADER) === "courier"
}

/**
 * The CSRF check for every state-changing courier route (5.2): a JSON body,
 * and an Origin whose hostname is COURIER_HOST. SameSite=Strict is the first
 * control and this is the second. COURIER_HOST unset refuses everything, as
 * it does in middleware.
 *
 * Returns the refusal, or null when the request may proceed. Checked before
 * the rate limiter, so a cross-site request costs no Redis call.
 */
export function courierWriteRefusal(request: Request): NextResponse | null {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  if (contentType !== "application/json") {
    return courierJson({ ok: false, reason: "unsupported_media_type" }, 415)
  }

  const want = hostnameOf(process.env.COURIER_HOST)
  const origin = request.headers.get("origin")
  let originHost = ""
  if (origin) {
    try {
      originHost = hostnameOf(new URL(origin).host)
    } catch {
      originHost = ""
    }
  }
  if (want === "" || originHost !== want) {
    return courierJson({ ok: false, reason: "bad_origin" }, 403)
  }
  return null
}

/**
 * Every courier API answer carries identity or sets a cookie, so none is
 * cached. A rate-limit refusal passes retryAfterSeconds for Retry-After.
 */
export function courierJson(body: unknown, status = 200, retryAfterSeconds?: number): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" }
  if (retryAfterSeconds !== undefined) Object.assign(headers, retryAfterHeaders(retryAfterSeconds))
  return NextResponse.json(body, { status, headers })
}

export type CourierIdentity = {
  kind: "legacy"
  courier_id: string
  status: string
  piverify_status: string | null
  piverify_allowed_action: string | null
  kyc_approved_at: string | null
}

/**
 * Why a courier could not be resolved. The same split as CallerRefusal in
 * lib/route-auth.ts: a 401 means sign in again, a 503 means the database
 * could not be asked, so a blip is not reported as "signed out".
 */
export type CourierRefusal =
  | { ok: false; reason: "no_session"; status: 401 }
  | { ok: false; reason: "auth_unavailable"; status: 503 }

export type CourierVerdict = { ok: true; courier: CourierIdentity } | CourierRefusal

type ResolveRow = {
  courier_id: string | null
  status: string | null
  piverify_status: string | null
  piverify_allowed_action: string | null
  kyc_approved_at: string | null
}

/**
 * Resolve the courier behind the session cookie, or say why not.
 *
 * 1. Off the courier surface: no_session, without touching the database.
 * 2. The token comes from the Cookie header only, and must have the gcs_
 *    shape before anything is hashed or sent.
 * 3. courier_session_resolve(sha256 of the token) answers the courier, or no
 *    row for an unknown, revoked, expired or idle session, or a shredded or
 *    non-legacy courier. The function tells those apart; this file does not
 *    need to, and a caller learns only that they are not signed in.
 * 4. A database error is auth_unavailable, 503.
 *
 * The log records the error code alone. The token and its hash never appear.
 */
export async function resolveCourier(admin: SupabaseClient, request: Request): Promise<CourierVerdict> {
  if (!onCourierSurface(request)) {
    return { ok: false, reason: "no_session", status: 401 }
  }

  const token = readSessionToken(request)
  if (!isSessionTokenShape(token)) {
    return { ok: false, reason: "no_session", status: 401 }
  }

  let data: unknown
  try {
    const result = await admin.rpc("courier_session_resolve", { p_token_hash: sha256Bytea(token) })
    if (result.error) {
      const code = (result.error as { code?: string }).code ?? "none"
      console.warn(`[courier-auth] courier_session_resolve failed: code=${code}`)
      return { ok: false, reason: "auth_unavailable", status: 503 }
    }
    data = result.data
  } catch (err) {
    console.warn(`[courier-auth] courier_session_resolve threw: ${err instanceof Error ? err.name : "unknown"}`)
    return { ok: false, reason: "auth_unavailable", status: 503 }
  }

  const row = (Array.isArray(data) ? data[0] : data) as ResolveRow | null | undefined
  if (!row || typeof row.courier_id !== "string" || typeof row.status !== "string") {
    return { ok: false, reason: "no_session", status: 401 }
  }

  return {
    ok: true,
    courier: {
      kind: "legacy",
      courier_id: row.courier_id,
      status: row.status,
      piverify_status: row.piverify_status ?? null,
      piverify_allowed_action: row.piverify_allowed_action ?? null,
      kyc_approved_at: row.kyc_approved_at ?? null,
    },
  }
}

/** The refusal a courier route returns. */
export function courierRefusalResponse(refusal: CourierRefusal): NextResponse {
  return courierJson({ ok: false, reason: refusal.reason }, refusal.status)
}

/**
 * The courier reference: the first 8 characters of the courier id (5.1,
 * decision 9). A lookup aid the courier reads back to the founder on
 * WhatsApp, never a credential: no route accepts it as input.
 */
export function courierReference(courierId: string): string {
  return courierId.slice(0, 8)
}
