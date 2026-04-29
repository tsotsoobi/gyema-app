"use client"

import { useState } from "react"
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
  createTrip,
  getListingsByUser,
  type PackageSize,
} from "@/lib/listings"
import type { PiUser, UserRole } from "@/lib/pi-network"

interface TripsTabProps {
  user: PiUser
  role: UserRole
  refreshKey: number
  onCreated: () => void
}

export function TripsTab({ user, role, refreshKey, onCreated }: TripsTabProps) {
  const [showForm, setShowForm] = useState(false)

  const myListings = getListingsByUser(user.uid)
  const myTrips = myListings.filter((l) => l.kind === "trip")
  const myPackages = myListings.filter((l) => l.kind === "package")

  const visibleListings = role === "traveller" ? myTrips : myPackages

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">My Activity</h2>
        <Badge variant="secondary" className="text-xs">
          {visibleListings.length}{" "}
          {role === "traveller" ? "trips" : "deliveries"}
        </Badge>
      </div>

      {role === "traveller" && (
        <Button
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

      <div className="space-y-2 pt-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Active {role === "traveller" ? "Trips" : "Deliveries"}
        </h3>

        {visibleListings.length === 0 ? (
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
          visibleListings.map((l) => (
            <Card key={l.id} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-sm">
                  {l.fromCity} → {l.toCity}
                </p>
                <Badge variant="outline" className="text-[10px]">
                  {l.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  📅{" "}
                  {formatDate(
                    l.kind === "trip" ? l.travelDate : l.deliverBy
                  )}
                </span>
                <span className="font-bold text-primary">
                  {l.kind === "trip" ? l.pricePi : l.offerPi} π
                </span>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground">
                {l.trackingId}
              </p>
            </Card>
          ))
        )}
      </div>
    </div>
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

  const valid = fromCity && toCity && travelDate && capacity && pricePi

  const handleSubmit = () => {
    if (!valid) return
    createTrip({
      fromCity: fromCity.trim(),
      toCity: toCity.trim(),
      travelDate,
      capacity: capacity as PackageSize,
      pricePi: parseFloat(pricePi),
      notes: notes.trim(),
      postedById: user.uid,
      postedByUsername: user.username,
    })
    onDone()
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
        <Label htmlFor="t-notes">Notes (optional)</Label>
        <Textarea
          id="t-notes"
          rows={2}
          placeholder="e.g. departing morning, no fragile items"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <Button className="w-full h-11 font-semibold" onClick={handleSubmit} disabled={!valid}>
        Post Trip
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
