"use client"

import { useEffect, useState } from "react"
import { SignIn } from "@/components/sign-in"
import { AppHeader } from "@/components/app-header"
import { BottomNav, type Tab } from "@/components/bottom-nav"
import { HomeTab } from "@/components/home-tab"
import { TripsTab } from "@/components/trips-tab"
import { TrackTab } from "@/components/track-tab"
import { ProfileTab } from "@/components/profile-tab"
import {
  clearStoredAuth,
  getStoredRole,
  getStoredUser,
  setStoredRole,
  setStoredUser,
  type PiUser,
  type UserRole,
} from "@/lib/pi-network"
import { expireStaleListingsAsync } from "@/lib/listings-async"

export default function Gyema() {
  const [user, setUser] = useState<PiUser | null>(null)
  const [role, setRole] = useState<UserRole>("traveller")
  const [activeTab, setActiveTab] = useState<Tab>("home")
  const [refreshKey, setRefreshKey] = useState(0)
  const [hydrated, setHydrated] = useState(false)

  // Restore auth state on mount
  useEffect(() => {
    const storedUser = getStoredUser()
    const storedRole = getStoredRole()
    if (storedUser) setUser(storedUser)
    if (storedRole) setRole(storedRole)
    setHydrated(true)
  }, [])

  // Sweep stale 'open' listings on app load.
  // Runs once per session, fire-and-forget, errors logged to console.
  useEffect(() => {
    expireStaleListingsAsync().catch((err) => {
      console.error("[gyema] expireStaleListingsAsync threw:", err)
    })
  }, [])

  const handleSignedIn = (signedInUser: PiUser) => {
    setUser(signedInUser)
  }

  const handleContinueAsGuest = () => {
    // Honest "guest" mode — clearly marked username so it's never confused
    // with a real Pi user. Useful for trying the UI without being in Pi Browser.
    const guest: PiUser = {
      uid: "guest",
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

  // Avoid flicker before localStorage check completes
  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-10 w-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <SignIn
        onSignedIn={handleSignedIn}
        onContinueAsGuest={handleContinueAsGuest}
      />
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
        />
      )}
      {activeTab === "trips" && (
        <TripsTab
          user={user}
          role={role}
          refreshKey={refreshKey}
          onCreated={triggerRefresh}
        />
      )}
      {activeTab === "track" && <TrackTab />}
      {activeTab === "profile" && (
        <ProfileTab
          user={user}
          onSignOut={handleSignOut}
          refreshKey={refreshKey}
        />
      )}

      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  )
}
