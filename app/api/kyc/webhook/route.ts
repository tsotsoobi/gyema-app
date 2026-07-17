import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import {
  verifyPiVerifyWebhook,
  getPiVerifyWebhookSecret,
  type PiVerifyWebhookEvent,
} from "@/lib/piverify"

// PiVerify KYC webhook: receives session status transitions for LEGACY
// couriers and writes them to public.legacy_couriers.
//
// data.external_user_id is the legacy_couriers.id (a UUID we supplied at
// session creation). We match on it and update kyc_status, stamping
// kyc_verified_at when status reaches "approved".
//
// SIGNATURE: X-PiVerify-Signature is HMAC-SHA256 over the RAW body. Read the
// raw text BEFORE JSON.parse; reserializing changes bytes and breaks the
// check. Node crypto is required, so this route runs on the Node runtime.
//
// service_role must hold UPDATE on legacy_couriers or the write fails as a
// silent Postgres 42501. Verified via role_table_grants at migration time.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get("x-piverify-signature")

  let secret: string
  try {
    secret = getPiVerifyWebhookSecret()
  } catch (err) {
    console.error("[gyema] piverify webhook: secret not configured", err)
    return NextResponse.json({ ok: false, reason: "misconfigured" }, { status: 500 })
  }

  if (!verifyPiVerifyWebhook(rawBody, signature, secret)) {
    return NextResponse.json({ ok: false, reason: "bad_signature" }, { status: 401 })
  }

  let event: PiVerifyWebhookEvent
  try {
    event = JSON.parse(rawBody) as PiVerifyWebhookEvent
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 })
  }

  const externalUserId = event?.data?.external_user_id
  const status = event?.data?.status
  const sessionId = event?.data?.session_id

  if (!externalUserId || !status) {
    return NextResponse.json({ ok: false, reason: "bad_payload" }, { status: 400 })
  }

  try {
    const admin = createAdminClient()

    const patch: {
      kyc_status: string
      kyc_session_id: string | null
      updated_at: string
      kyc_verified_at?: string
    } = {
      kyc_status: status,
      kyc_session_id: sessionId ?? null,
      updated_at: new Date().toISOString(),
    }
    if (status === "approved") {
      patch.kyc_verified_at = new Date().toISOString()
    }

    const { data, error } = await admin
      .from("legacy_couriers")
      .update(patch)
      .eq("id", externalUserId)
      .select("id")

    if (error) {
      console.error("[gyema] piverify webhook update error:", error)
      return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
    }

    if (!data || data.length === 0) {
      console.warn(
        "[gyema] piverify webhook: no legacy_courier for external_user_id",
        externalUserId
      )
      return NextResponse.json({ ok: true, matched: false })
    }

    return NextResponse.json({ ok: true, matched: true, status })
  } catch (err) {
    console.error("[gyema] piverify webhook route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}