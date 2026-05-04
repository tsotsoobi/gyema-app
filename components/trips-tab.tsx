"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  type Listing,
  type PackageSize,
} from "@/lib/listings"
import {
  createTripAsync,
  getListingsByUserAsync,
} from "@/lib/listings-async"
import type { PiUser, UserRole } from "@/lib/pi-network"

interface TripsTabProps {
  user: PiUser
  role: UserRole
  refreshKey: number
  onCreated: () => void
}

// Statuses considered "past" — listings the user has finished with.
// 'expired' is set automatically by expireStaleListingsAsync.
// 'completed' is reserved for the v2 confirmation flow.
const PAST_STATUSES = new Set(["expired", "completed"])

export function TripsTab({ user, role, refreshKey, onCreated }: TripsTabProps) {
  const [showForm, setShowForm] = useState(false)
  const [myListings, setMyListings] = useState<Listing[]>([])

  useEffect(() => {
    let cancelled = false
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

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">My Activity</h2>
        <Badge variant="secondary" className="text-xs">
          {activeListings.length}{" "}
          {role === "traveller" ? "trips" : "deliveries"}
        </Badge>
      </div>

      {role === "traveller" && (
        <Button
          variant={showForm ? "outline" : "default"}
          className="w-full h-12 text-base font-semibold"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? "Cancel" : "✈️ Register a Trip"}
        </Button>
      )}

      {role === "traveller" && showForm && (
        <RegisterTripForm
          user={user}
          onDone={() => {
            setShowForm(false)
            onCreated()
          }}
        />
      )}

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
              {role === "traveller"
                ? "Register your first trip to start earning Pi."
                : "Post a delivery from the Home tab."}
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

function RegisterTripForm({
  user,
  onDone,
}: {
  user: PiUser
  onDone: () => void
}) {
  const [fromCity, setFromCity] = useState("")
  const [toCity, setToCity] = useState("")
  const [travelDate, setTravelDate] = useState("")
  const [capacity, setCapacity] = useState<PackageSize | "">("")
  const [pricePi, setPricePi] = useState("")
  const [notes, setNotes] = useState("")
  const [whatsapp, setWhatsapp] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const valid = fromCity && toCity && travelDate && capacity && pricePi && whatsapp

  const handleSubmit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    try {
      await createTripAsync({
        fromCity: fromCity.trim(),
        toCity: toCity.trim(),
        travelDate,
        capacity: capacity as PackageSize,
        pricePi: parseFloat(pricePi),
        notes: notes.trim(),
        whatsapp: whatsapp.trim(),
        postedById: user.uid,
        postedByUsername: user.username,
      })
      onDone()
    } catch (e) {
      console.error("[gyema] Could not register trip:", e)
      alert("Could not register your trip. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-semibold">Register a Trip</h3>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="t-from">From</Label>
          <Input
            id="t-from"
            placeholder="Accra"
            value={fromCity}
            onChange={(e) => setFromCity(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="t-to">To</Label>
          <Input
            id="t-to"
            placeholder="Kumasi"
            value={toCity}
            onChange={(e) => setToCity(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-date">Travel Date</Label>
        <Input
          id="t-date"
          type="date"
          value={travelDate}
          onChange={(e) => setTravelDate(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-cap">Capacity</Label>
        <Select value={capacity} onValueChange={(v) => setCapacity(v as PackageSize)}>
          <SelectTrigger id="t-cap">
            <SelectValue placeholder="Select capacity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="envelope">Envelope only</SelectItem>
            <SelectItem value="small">Small package</SelectItem>
            <SelectItem value="medium">Medium package</SelectItem>
            <SelectItem value="large">Large package</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-price">Asking Price (π)</Label>
        <Input
          id="t-price"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          placeholder="5"
          value={pricePi}
          onChange={(e) => setPricePi(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-whatsapp">WhatsApp Number</Label>
        <Input
          id="t-whatsapp"
          type="tel"
          inputMode="tel"
          placeholder="+233 24 123 4567"
          value={whatsapp}
          onChange={(e) => setWhatsapp(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          Senders will use this to coordinate with you.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-notes">Notes (optional)</Label>
        <Textarea
          id="t-notes"
          rows={2}
          placeholder="e.g. departing morning, no fragile items"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <Button
        className="w-full h-11 font-semibold"
        onClick={handleSubmit}
        disabled={!valid || submitting}
      >
        {submitting ? "Posting..." : "Post Trip"}
      </Button>
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
