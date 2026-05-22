"use client"

import { useEffect, useState } from "react"
import { SignIn } from "@/components/sign-in"
import { AppHeader } from "@/components/app-header"
import { BottomNav, type Tab } from "@/components/bottom-nav"
import { HomeTab } from "@/components/home-tab"
import { TripsTab } from "@/components/trips-tab"
import { TrackTab } from "@/components/track-tab"
import { ProfileTab } from "@/components/profile-tab"
import { WelcomeSheet } from "@/components/welcome-sheet"
import {
  clearStoredAuth,
  getStoredRole,
  getStoredUser,
  setStoredRole,
  setStoredUser,
  type PiUser,
  type UserRole,
} from "@/lib/pi-network"

export default function Gyema() {
  const [user, setUser] = useState<PiUser | null>(null)
  const [role, setRole] = useState<UserRole>("traveller")
  const [activeTab, setActiveTab] = useState<Tab>("home")
  const [refreshKey, setRefreshKey] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    const storedUser = getStoredUser()
    const storedRole = getStoredRole()
    if (storedUser) setUser(storedUser)
    if (storedRole) setRole(storedRole)
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const seen = localStorage.getItem("gyema-welcome-seen")
      if (seen !== "true") {
        setShowWelcome(true)
      }
    } catch {
      // localStorage may throw in private browsing or restricted contexts.
    }
  }, [])

  const dismissWelcome = () => {
    setShowWelcome(false)
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("gyema-welcome-seen", "true")
      } catch {
        // Same reasoning as the read above.
      }
    }
  }

  const handleSignedIn = (signedInUser: PiUser) => {
    setUser(signedInUser)
  }

  const handleContinueAsGuest = () => {
    const guestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const guest: PiUser = {
      uid: `guest-${guestId}`,
      username: "guest",
      accessToken: "",
    }
    setStoredUser(guest)
    setUser(guest)
  }

  const handleRoleChange = (newRole: UserRole) => {
    setRole(newRole)
    setStoredRole(newRole)
  }

  const handleSignOut = () => {
    clearStoredAuth()
    setUser(null)
    setActiveTab("home")
  }

  const triggerRefresh = () => setRefreshKey((k) => k + 1)

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-10 w-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <>
        <SignIn
          onSignedIn={handleSignedIn}
          onContinueAsGuest={handleContinueAsGuest}
        />
        {showWelcome && <WelcomeSheet onDismiss={dismissWelcome} />}
      </>
    )
  }

  return (
    <div className="min-h-screen bg-background pb-20 max-w-md mx-auto">
      <AppHeader role={role} onRoleChange={handleRoleChange} piBalance={0} />

      {activeTab === "home" && (
        <HomeTab
          role={role}
          user={user}
          refreshKey={refreshKey}
          onListingCreated={triggerRefresh}
          onSignedIn={handleSignedIn}
        />
      )}
      {activeTab === "trips" && (
        <TripsTab
          user={user}
          role={role}
          refreshKey={refreshKey}
          onCreated={triggerRefresh}
          onSignedIn={handleSignedIn}
        />
      )}
      {activeTab === "track" && <TrackTab />}
      {activeTab === "profile" && (
        <ProfileTab
          user={user}
          onSignOut={handleSignOut}
          refreshKey={refreshKey}
          onNavigate={setActiveTab}
          onSignedIn={handleSignedIn}
        />
      )}

      <BottomNav active={activeTab} onChange={setActiveTab} />

      {showWelcome && <WelcomeSheet onDismiss={dismissWelcome} />}
    </div>
  )
}
