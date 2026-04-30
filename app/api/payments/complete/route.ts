import { NextRequest, NextResponse } from "next/server"

// Pi Platform's payment completion endpoint.
// Pi servers call OUR /api/payments/complete after the blockchain transaction
// is broadcast. We then call Pi's /v2/payments/{id}/complete with the txid
// to mark the payment fully settled.
//
// Pi Platform API docs: https://github.com/pi-apps/pi-platform-docs/blob/main/payments.md

export async function POST(request: NextRequest) {
  try {
    const { paymentId, txid } = await request.json()

    if (!paymentId || !txid) {
      return NextResponse.json(
        { error: "Missing paymentId or txid" },
        { status: 400 }
      )
    }

    const apiKey = process.env.PI_API_KEY
    if (!apiKey) {
      console.error("[gyema] PI_API_KEY not set in environment")
      return NextResponse.json(
        { error: "Server misconfiguration" },
        { status: 500 }
      )
    }

    // Tell Pi servers the payment is complete with the blockchain txid.
    const piResponse = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      }
    )

    if (!piResponse.ok) {
      const errorText = await piResponse.text()
      console.error(
        "[gyema] Pi complete failed:",
        piResponse.status,
        errorText
      )
      return NextResponse.json(
        { error: "Pi completion failed", details: errorText },
        { status: piResponse.status }
      )
    }

    const data = await piResponse.json()
    console.log("[gyema] Payment completed:", paymentId, "txid:", txid)
    return NextResponse.json({ success: true, payment: data })
  } catch (error) {
    console.error("[gyema] Complete route error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
