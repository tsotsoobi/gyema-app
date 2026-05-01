"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  authenticateWithPi,
  isPiSdkAvailable,
  setStoredUser,
  type PiUser,
} from "@/lib/pi-network"

interface SignInProps {
  onSignedIn: (user: PiUser) => void
  onContinueAsGuest: () => void
}

export function SignIn({ onSignedIn, onContinueAsGuest }: SignInProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handlePiSignIn = async () => {
    setError("")
    setLoading(true)
    try {
      const user = await authenticateWithPi()
      setStoredUser(user)
      onSignedIn(user)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again."
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 gyema-gradient">
      <Card className="w-full max-w-sm overflow-hidden shadow-xl">
        <div className="p-8 pb-0 space-y-6">
          <div className="flex flex-col items-center space-y-3">
            <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center shadow-lg">
              <svg
                viewBox="0 0 100 100"
                className="w-12 h-12 text-white"
                fill="currentColor"
                aria-hidden="true"
              >
                {/* Open hand cradle */}
                <path d="M12 58 L52 32 Q56 29 60 32 L60 44 L88 44 Q92 44 92 48 Q92 52 88 52 L60 52 L60 58 Q60 62 56 62 L18 62 Z" />
                {/* Motion lines above palm */}
                <path d="M66 30 L82 30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                <path d="M70 22 L84 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                <path d="M74 14 L86 14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Gyema</h1>
            <p className="text-sm text-muted-foreground text-center">
              Connecting People · Delivering Value
            </p>
          </div>
        </div>

        <div className="kente-band my-6" aria-hidden="true" />

        <div className="px-8 pb-8 space-y-6">
          {!isPiSdkAvailable() && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              Pi SDK not detected. Open this app inside <strong>Pi Browser</strong>{" "}
              to sign in with your Pi account.
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-900">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <Button
              className="w-full h-12 text-base font-semibold"
              size="lg"
              onClick={handlePiSignIn}
              disabled={loading || !isPiSdkAvailable()}
            >
              {loading ? "Signing in…" : "Sign in with Pi"}
            </Button>

            <Button
              variant="outline"
              className="w-full h-12 text-base"
              size="lg"
              onClick={onContinueAsGuest}
            >
              Continue as Guest
            </Button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Powered by Pi Network · Decentralized P2P Delivery
          </p>
        </div>
      </Card>
    </div>
  )
}
