import { NextRequest, NextResponse } from "next/server"
import { createPiVerifySession } from "@/lib/piverify"

// TEMPORARY DRILL ROUTE, sandbox only. Creates a PiVerify session for a
// given external_user_id (a legacy_couriers.id) by calling the real
// lib/piverify client, so the drill exercises shipped code and env config.
//
// Guarded: refuses unless PIVERIFY_API_KEY is a sandbox key (sbx_ prefix),
// so this can never create a live/billed session. Remove this route before
// Branch 1 merges to main.
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const key = process.env.PIVERIFY_API_KEY ?? ""
  if (!key.startsWith("sbx_")) {
    return NextResponse.json({ ok: false, reason: "sandbox_only" }, { status: 403 })
  }

  const externalUserId = request.nextUrl.searchParams.get("uid")
  if (!externalUserId) {
    return NextResponse.json({ ok: false, reason: "missing_uid" }, { status: 400 })
  }

  try {
    const session = await createPiVerifySession({
      external_user_id: externalUserId,
      idempotency_key: `drill_${externalUserId}_${Date.now()}`,
    })
    return NextResponse.json({
      ok: true,
      session_id: session.id,
      status: session.status,
      hosted_flow_url: session.hosted_flow_url,
    })
  } catch (err) {
    console.error("[gyema] piverify drill create error:", err)
    return NextResponse.json(
      { ok: false, reason: "create_failed", detail: String(err) },
      { status: 500 }
    )
  }
}