"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { type Listing } from "@/lib/listings"
import { getListingsByUserAsync } from "@/lib/listings-async"
import { co2SavedForListing } from "@/lib/carbon"
import {
  type PiUser,
  createTestPayment,
  isPiSdkAvailable,
  signInAndPersist,
} from "@/lib/pi-network"

interface ProfileTabProps {
  user: PiUser
  onSignOut: () => void
  refreshKey: number
  onNavigate: (tab: "home" | "trips" | "track" | "profile") => void
  onSignedIn?: (user: PiUser) => void
}

export function ProfileTab({
  user,
  onSignOut,
  refreshKey,
  onNavigate,
  onSignedIn,
}: ProfileTabProps) {
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getListingsByUserAsync(user.uid)
      .then((all) => {
        if (cancelled) return
        setListings(all)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user.uid, refreshKey])

  const completedCount = listings.filter((l) => l.status === "completed").length
  const tripCount = listings.filter((l) => l.kind === "trip").length

  // V1.1 — aggregate CO2 saved across the user's completed deliveries.
  // co2SavedForListing already returns the per-user (50/50 split) value,
  // so we just sum directly. Unknown cities contribute 0 (no fabrication).
  const co2SavedKgTotal = listings
    .filter((l) => l.status === "completed")
    .reduce((sum, l) => sum + co2SavedForListing(l), 0)

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

  // Only show test payment card to non-guest users inside Pi Browser, AND only when ?debug=1 is in the URL.
  // Hidden by default for V1 — payments require V2 backend (escrow + complete flow).
  const isGuest = user.uid.startsWith("guest-")
  const isDebugMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1"
  const showTestPayment = !isGuest && isPiSdkAvailable() && isDebugMode

  // Impact tile is hidden for guests — they share a uid namespace,
  // so aggregated stats wouldn't be personal.
  const showImpactTile = !isGuest

  const handleTestPayment = async () => {
    setTxStatus("pending")
    setTxMessage("Opening Pi payment dialog...")
    try {
      const paymentId = await createTestPayment()
      setTxStatus("success")
      setTxMessage(`✅ Test payment sent. ID: ${paymentId.slice(0, 12)}…`)
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

      {isGuest ? (
        <GuestProfileGate onSignedIn={onSignedIn} />
      ) : (
        <>
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
              <p className="text-2xl font-bold">{loading ? "—" : completedCount}</p>
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

          {showImpactTile && (
            <Card className="p-4 flex items-center gap-3">
              <div className="text-2xl">🌱</div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">My Impact</p>
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? "Loading…"
                    : co2SavedKgTotal > 0
                      ? `~${co2SavedKgTotal.toFixed(1)} kg CO₂ saved`
                      : "Complete a delivery to start saving CO₂"}
                </p>
              </div>
              <a
                href="/methodology.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline whitespace-nowrap"
              >
                How?
              </a>
            </Card>
          )}

          <div className="space-y-2">
            <ProfileLink
              icon="✈️"
              title="My Activity"
              subtitle={loading ? "Loading…" : `${tripCount} registered`}
              onClick={() => onNavigate("trips")}
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
            🔴 Disconnect
          </Button>
        </>
      )}

      <div className="space-y-2 pt-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
          About Gyema
        </h3>
        <CollapsibleCard
          icon="🛡️"
          title="Trust Protocol"
          body="Verified by Pi Network: Gyema relies on Pi's KYC verification and Security Circles to surface trusted users."
        />
        <CollapsibleCard
          icon="📄"
          title="Liability"
          body="Gyema / Pi Logistics LTD facilitates connections between users but is not responsible for package contents, delivery outcomes, or disputes. Users coordinate and resolve agreements directly."
        />
      </div>

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
  onClick,
}: {
  icon: string
  title: string
  subtitle: string
  disabled?: boolean
  href?: string
  onClick?: () => void
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

  if (onClick && !disabled) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="block w-full text-left"
      >
        {content}
      </button>
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

function CollapsibleCard({
  icon,
  title,
  body,
}: {
  icon: string
  title: string
  body: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full p-4 flex items-center gap-3 hover:border-primary cursor-pointer transition-colors text-left"
      >
        <div className="text-2xl">{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">{title}</p>
        </div>
        <span
          className={`text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ›
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 -mt-1">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {body}
          </p>
        </div>
      )}
    </Card>
  )
}

// Guest-mode gate shown on the Profile tab when the current viewer has no
// Pi identity. Mirrors GuestPostGate (home-tab) and GuestActionGate
// (listing-detail-sheet) for consistent gate language across surfaces.
//
// If onSignedIn isn't wired by the parent, the button is hidden — guests
// still see the headline and explanation, and can keep browsing the rest
// of the app as a guest.
function GuestProfileGate({
  onSignedIn,
}: {
  onSignedIn?: (user: PiUser) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSignIn = async () => {
    if (!onSignedIn) return
    setError("")
    setLoading(true)
    try {
      const user = await signInAndPersist()
      onSignedIn(user)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Sign-in failed. Please try again."
      console.error("[gyema] Guest sign-in upgrade failed:", err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-primary/40 bg-primary/5">
      <div className="space-y-2">
        <h3 className="font-semibold text-base">
          Sign in to build your Pioneer profile
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Sign in with Pi to post trips and accept deliveries, build a
          verified delivery history, earn Pi for completed jobs, and grow
          your Pioneer rating.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-900">
          {error}
        </div>
      )}

      {onSignedIn && (
        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? "Signing in…" : "Sign in with Pi"}
        </Button>
      )}

      <p className="text-[11px] text-muted-foreground text-center">
        You can keep browsing as a guest. Sign-in is only required to act on
        listings.
      </p>
    </Card>
  )
}
