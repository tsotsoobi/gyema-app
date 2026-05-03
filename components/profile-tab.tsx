"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { type Listing } from "@/lib/listings"
import { getListingsByUserAsync } from "@/lib/listings-async"
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
  const [listings, setListings] = useState<Listing[]>([])

  useEffect(() => {
    let cancelled = false
    getListingsByUserAsync(user.uid).then((all) => {
      if (cancelled) return
      setListings(all)
    })
    return () => {
      cancelled = true
    }
  }, [user.uid, refreshKey])

  const completedCount = listings.filter((l) => l.status === "completed").length

  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "success" | "error">("idle")
  const [txMessage, setTxMessage] = useState<string>("")

  // KYC card dismissal state — persists across sessions via localStorage.
  // Auto-hides after first successful test payment (since payment proves
  // the user has migrated Pi, which requires KYC).
  const [kycHidden, setKycHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return localStorage.getItem("gyema-kyc-dismissed") === "true"
  })

  const dismissKyc = () => {
    setKycHidden(true)
    if (typeof window !== "undefined") {
      localStorage.setItem("gyema-kyc-dismissed", "true")
    }
  }

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
      // Successful payment proves KYC — auto-dismiss KYC card.
      if (!kycHidden) {
        dismissKyc()
      }
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
        {!kycHidden && (
          <DismissibleProfileLink
            icon="🪪"
            title="Pi Network KYC"
            subtitle="Verified by Pi Network — tap to complete or check status"
            href="https://kyc.pinet.com/user/status"
            onDismiss={dismissKyc}
          />
        )}
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

function DismissibleProfileLink({
  icon,
  title,
  subtitle,
  href,
  onDismiss,
}: {
  icon: string
  title: string
  subtitle: string
  href: string
  onDismiss: () => void
}) {
  const handleDismissClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onDismiss()
  }

  return (
    <div className="relative">
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        <Card className="p-4 flex items-center gap-3 hover:border-primary cursor-pointer transition-colors">
          <div className="text-2xl">{icon}</div>
          <div className="flex-1 min-w-0 pr-6">
            <p className="font-semibold text-sm">{title}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <span className="text-muted-foreground">›</span>
        </Card>
      </a>
      <button
        onClick={handleDismissClick}
        aria-label="Dismiss KYC card"
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-sm"
      >
        ✕
      </button>
    </div>
  )
}
