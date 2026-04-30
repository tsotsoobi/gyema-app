import { NextRequest, NextResponse } from "next/server"

// Pi Platform's payment approval endpoint.
// Pi servers call OUR /api/payments/approve when a Pioneer approves a payment
// in their wallet. We then call Pi's /v2/payments/{id}/approve to confirm
// the payment from the app side. Without this, payments time out.
//
// Pi Platform API docs: https://github.com/pi-apps/pi-platform-docs/blob/main/payments.md

export async function POST(request: NextRequest) {
  try {
    const { paymentId } = await request.json()

    if (!paymentId) {
      return NextResponse.json(
        { error: "Missing paymentId" },
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

    // Tell Pi servers we approve this payment.
    const piResponse = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    )

    if (!piResponse.ok) {
      const errorText = await piResponse.text()
      console.error(
        "[gyema] Pi approve failed:",
        piResponse.status,
        errorText
      )
      return NextResponse.json(
        { error: "Pi approval failed", details: errorText },
        { status: piResponse.status }
      )
    }

    const data = await piResponse.json()
    console.log("[gyema] Payment approved:", paymentId)
    return NextResponse.json({ success: true, payment: data })
  } catch (error) {
    console.error("[gyema] Approve route error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
