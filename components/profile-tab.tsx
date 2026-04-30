"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { getListingsByUser } from "@/lib/listings"
import {
  type PiUser,
  createTestPayment,
  isPiSdkAvailable,
} from "@/lib/pi-network"

interface ProfileTabProps {
  user: PiUser
  onSignOut: () => void
  refreshKey: number
}

export function ProfileTab({ user, onSignOut, refreshKey }: ProfileTabProps) {
  const listings = getListingsByUser(user.uid)
  const completedCount = listings.filter((l) => l.status === "completed").length

  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "success" | "error">("idle")
  const [txMessage, setTxMessage] = useState<string>("")

  // Only show test payment card to non-guest users inside Pi Browser
  const isGuest = user.uid.startsWith("guest-")
  const showTestPayment = !isGuest && isPiSdkAvailable()

  const handleTestPayment = async () => {
    setTxStatus("pending")
    setTxMessage("Opening Pi payment dialog...")
    try {
      const paymentId = await createTestPayment()
      setTxStatus("success")
      setTxMessage(`✅ Test payment sent. ID: ${paymentId.slice(0, 12)}…`)
    } catch (err) {
      setTxStatus("error")
      const msg = err instanceof Error ? err.message : "Payment failed."
      setTxMessage(`❌ ${msg}`)
    }
  }

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <h2 className="text-lg font-semibold">Account</h2>

      <Card className="p-4 flex items-center gap-3">
        <div className="w-14 h-14 rounded-full gyema-gradient flex items-center justify-center text-white font-bold text-xl">
          {user.username.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold truncate">{user.username}</p>
          <p className="text-xs text-muted-foreground">
            @{user.username} · Pi Network
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold">{completedCount}</p>
          <p className="text-[11px] text-muted-foreground">Deliveries</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold">0π</p>
          <p className="text-[11px] text-muted-foreground">Earned</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold">—</p>
          <p className="text-[11px] text-muted-foreground">Rating</p>
        </Card>
      </div>

      <div className="space-y-2">
        <ProfileLink
          icon="✈️"
          title="My Trips"
          subtitle={`${listings.filter((l) => l.kind === "trip").length} registered`}
        />
        <ProfileLink
          icon="⚖️"
          title="Dispute Center"
          subtitle="Coming in v2"
          disabled
        />
        <ProfileLink
          icon="🪪"
          title="Verify Identity (KYC)"
          subtitle="Complete KYC in Pi App"
          href="https://minepi.com/kyc"
        />
      </div>

      {showTestPayment && (
        <Card className="p-4 space-y-2">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🧪</div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Send Test Transaction</p>
              <p className="text-xs text-muted-foreground">
                Sends 0.001 testnet π to satisfy Pi Develop's checklist.
              </p>
            </div>
          </div>
          <Button
            onClick={handleTestPayment}
            disabled={txStatus === "pending"}
            className="w-full h-10"
          >
            {txStatus === "pending" ? "Processing..." : "Send 0.001 π"}
          </Button>
          {txMessage && (
            <p
              className={`text-xs ${
                txStatus === "success"
                  ? "text-green-600"
                  : txStatus === "error"
                    ? "text-destructive"
                    : "text-muted-foreground"
              }`}
            >
              {txMessage}
            </p>
          )}
        </Card>
      )}

      <Button
        variant="destructive"
        className="w-full h-11 font-semibold"
        onClick={onSignOut}
      >
        🔴 Disconnect Pi
      </Button>

      <p className="text-[10px] text-center text-muted-foreground pt-4">
        Gyema v1 · Powered by Pi Network
      </p>
    </div>
  )
}

function ProfileLink({
  icon,
  title,
  subtitle,
  disabled,
  href,
}: {
  icon: string
  title: string
  subtitle: string
  disabled?: boolean
  href?: string
}) {
  const content = (
    <Card
      className={`p-4 flex items-center gap-3 ${
        disabled ? "opacity-60" : "hover:border-primary cursor-pointer"
      } transition-colors`}
    >
      <div className="text-2xl">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <span className="text-muted-foreground">›</span>
    </Card>
  )

  if (href && !disabled) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {content}
      </a>
    )
  }
  return content
}
