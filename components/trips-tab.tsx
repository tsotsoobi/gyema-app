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
              </p
