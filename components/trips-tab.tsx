"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { type Listing } from "@/lib/listings"
import { getListingsByUserAsync } from "@/lib/listings-async"
import { isGuest, type PiUser, type UserRole } from "@/lib/pi-network"

interface TripsTabProps {
  user: PiUser
  role: UserRole
  refreshKey: number
  onCreated: () => void
  onSignedIn: (user: PiUser) => void
  onNavigate: (tab: "home" | "trips" | "track" | "profile") => void
}

// Statuses considered "past" — listings the user has finished with.
// 'expired' is set automatically by expireStaleListingsAsync.
// 'completed' is reserved for the v2 confirmation flow.
const PAST_STATUSES = new Set(["expired", "completed"])

export function TripsTab({ user, role, refreshKey, onNavigate }: TripsTabProps) {
  const [myListings, setMyListings] = useState<Listing[]>([])

  useEffect(() => {
    let cancelled = false
    // Guests have no DB-side listings (and their guest- uid isn't queryable
    // as a real Pi identity); skip the fetch and render an empty My Activity.
    if (isGuest(user)) {
      setMyListings([])
      return
    }
    getListingsByUserAsync(user.uid).then((all) => {
      if (cancelled) return
      setMyListings(all)
    })
    return () => {
      cancelled = true
    }
  }, [user.uid, refreshKey])

  // Split by kind first (role-appropriate listings only),
  // then by active/past based on status.
  const myTrips = myListings.filter((l) => l.kind === "trip")
  const myPackages = myListings.filter((l) => l.kind === "package")
  const visibleListings = role === "traveller" ? myTrips : myPackages

  const activeListings = visibleListings.filter(
    (l) => !PAST_STATUSES.has(l.status)
  )
  const pastListings = visibleListings.filter((l) =>
    PAST_STATUSES.has(l.status)
  )

  const viewerIsGuest = isGuest(user)

  // My Activity is a review surface. Posting affordances on this tab are
  // discovery entry-points that navigate the user to Home, which is the
  // canonical posting surface. This keeps the post-form code in a single
  // place (home-tab.tsx) without duplicating across tabs.
  const handlePostNav = () => onNavigate("home")

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">My Activity</h2>
        <Badge variant="secondary" className="text-xs">
          {activeListings.length}{" "}
          {role === "traveller" ? "trips" : "deliveries"}
        </Badge>
      </div>

      {/* Post entry-point — renders ABOVE the Active section as the primary
          tab action. Both roles see this regardless of guest/signed-in status;
          the button navigates to Home where the canonical post form lives. */}
      <Button
        variant="default"
        className="w-full h-12 text-base font-semibold"
        onClick={handlePostNav}
      >
        {role === "traveller" ? "✈️ Register a Trip" : "📦 Post a Delivery"}
      </Button>

      {/* Active section */}
      <div className="space-y-2 pt-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Active {role === "traveller" ? "Trips" : "Deliveries"}
        </h3>

        {activeListings.length === 0 ? (
          <Card className="p-8 text-center space-y-2">
            <div className="text-4xl">📭</div>
            <p className="text-sm font-medium">Nothing here yet</p>
            <p className="text-xs text-muted-foreground">
              {viewerIsGuest
                ? role === "traveller"
                  ? "Sign in with Pi to register your first trip."
                  : "Sign in with Pi to post your first delivery."
                : role === "traveller"
                  ? "Register your first trip to start earning Pi."
                  : "Post a delivery to find a Traveller."}
            </p>
          </Card>
        ) : (
          activeListings.map((l) => (
            <ListingCard key={l.id} listing={l} muted={false} />
          ))
        )}
      </div>

      {/* Past section — only renders if user has any past listings */}
      {pastListings.length > 0 && (
        <div className="space-y-2 pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">
              Past {role === "traveller" ? "Trips" : "Deliveries"}
            </h3>
            <span className="text-[11px] text-muted-foreground">
              {pastListings.length}
            </span>
          </div>

          {pastListings.map((l) => (
            <ListingCard key={l.id} listing={l} muted={true} />
          ))}
        </div>
      )}
    </div>
  )
}

// Single card component — same layout for active and past, but
// muted=true visually de-emphasises the card so the user can tell
// at a glance that it's history.
function ListingCard({
  listing,
  muted,
}: {
  listing: Listing
  muted: boolean
}) {
  return (
    <Card
      className={`p-4 space-y-2 ${
        muted ? "bg-muted/40 border-muted opacity-70" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={`font-semibold text-sm ${
            muted ? "text-muted-foreground" : ""
          }`}
        >
          {listing.fromCity} → {listing.toCity}
        </p>
        <Badge
          variant="outline"
          className={`text-[10px] ${
            muted ? "text-muted-foreground" : ""
          }`}
        >
          {listing.status}
        </Badge>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          📅{" "}
          {formatDate(
            listing.kind === "trip" ? listing.travelDate : listing.deliverBy
          )}
        </span>
        <span
          className={`font-bold ${
            muted ? "text-muted-foreground" : "text-primary"
          }`}
        >
          {listing.kind === "trip" ? listing.pricePi : listing.offerPi} π
        </span>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        {listing.trackingId}
      </p>
    </Card>
  )
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
  } catch {
    return iso
  }
}
