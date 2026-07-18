import { NextRequest, NextResponse } from "next/server"
import { createPiVerifySession } from "@/lib/piverify"

// TEMPORARY DRILL ROUTE, sandbox only. Remove before Branch 1 merges.
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const key = process.env.PIVERIFY_API_KEY ?? ""

  const diag = {
    key_present: key.length > 0,
    key_length: key.length,
    key_prefix: key.slice(0, 4),
    key_last4: key.slice(-4),
    key_has_leading_space: key !== key.trimStart(),
    key_has_trailing_space: key !== key.trimEnd(),
    base_url: process.env.PIVERIFY_API_BASE_URL ?? "(unset)",
  }

  if (!key.startsWith("sbx_")) {
    return NextResponse.json({ ok: false, reason: "sandbox_only", diag }, { status: 403 })
  }

  const externalUserId = request.nextUrl.searchParams.get("uid")
  if (!externalUserId) {
    return NextResponse.json({ ok: false, reason: "missing_uid", diag }, { status: 400 })
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
      diag,
    })
  } catch (err) {
    console.error("[gyema] piverify drill create error:", err)
    return NextResponse.json(
      { ok: false, reason: "create_failed", detail: String(err), diag },
      { status: 500 }
    )
  }
}