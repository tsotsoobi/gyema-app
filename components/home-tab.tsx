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
  createPackage,
  getOpenListings,
  type Listing,
  type PackageSize,
} from "@/lib/listings"
import type { PiUser, UserRole } from "@/lib/pi-network"
import { ListingDetailSheet } from "./listing-detail-sheet"

interface HomeTabProps {
  role: UserRole
  user: PiUser
  refreshKey: number
  onListingCreated: () => void
}

export function HomeTab({ role, user, refreshKey, onListingCreated }: HomeTabProps) {
  if (role === "traveller") {
    return (
      <TravellerHome
        currentUserId={user.uid}
        refreshKey={refreshKey}
      />
    )
  }
  return (
    <SenderHome
      user={user}
      refreshKey={refreshKey}
      onCreated={onListingCreated}
    />
  )
}

function TravellerHome({
  currentUserId,
  refreshKey,
}: {
  currentUserId: string
  refreshKey: number
}) {
  const [selected, setSelected] = useState<Listing | null>(null)

  const listings = getOpenListings().filter(
    (l) => l.kind === "package" && l.postedById !== currentUserId
  )

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Available Jobs</h2>
        <Badge variant="secondary" className="text-xs">
          {listings.length} open
        </Badge>
      </div>

      {listings.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <div className="text-4xl">📭</div>
          <p className="text-sm font-medium">No open jobs right now</p>
          <p className="text-xs text-muted-foreground">
            Check back soon. Senders post deliveries throughout the day.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {listings.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l)}
              className="w-full text-left"
            >
              <Card className="p-4 space-y-2 hover:border-primary transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">
                      {l.fromCity} → {l.toCity}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {l.kind === "package" ? l.description : ""}
                    </p>
                  </div>
                  <div className="gyema-gold-gradient rounded-md px-2.5 py-1 text-xs font-bold text-amber-950 whitespace-nowrap">
                    {l.kind === "package" ? l.offerPi : 0} π
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>📅 {formatDate(l.kind === "package" ? l.deliverBy : "")}</span>
                  <span>·</span>
                  <span>📦 {l.kind === "package" ? l.size : ""}</span>
                  <span>·</span>
                  <span className="font-mono text-[10px]">{l.trackingId}</span>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <ListingDetailSheet
          listing={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function SenderHome({
  user,
  refreshKey,
  onCreated,
}: {
  user: PiUser
  refreshKey: number
  onCreated: () => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<Listing | null>(null)
  const [description, setDescription] = useState("")
  const [size, setSize] = useState<PackageSize | "">("")
  const [fromCity, setFromCity] = useState("")
  const [toCity, setToCity] = useState("")
  const [deliverBy, setDeliverBy] = useState("")
  const [offer, setOffer] = useState("")
  const [whatsapp, setWhatsapp] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)

  const trips = getOpenListings().filter(
    (l) => l.kind === "trip" && l.postedById !== user.uid
  )

  const valid =
    description.trim() &&
    size &&
    fromCity.trim() &&
    toCity.trim() &&
    deliverBy &&
    offer &&
    whatsapp

  const handleSubmit = () => {
    if (!valid) return
    const listing = createPackage({
      description: description.trim(),
      size: size as PackageSize,
      fromCity: fromCity.trim(),
      toCity: toCity.trim(),
      deliverBy,
      offerPi: parseFloat(offer),
      whatsapp: whatsapp.trim(),
      postedById: user.uid,
      postedByUsername: user.username,
    })
    setSubmitted(listing.trackingId)
    setDescription("")
    setSize("")
    setFromCity("")
    setToCity("")
    setDeliverBy("")
    setOffer("")
    setWhatsapp("")
    setShowForm(false)
    onCreated()
  }

  if (submitted) {
    return (
      <div className="px-4 py-4 space-y-3">
        <Card className="p-6 space-y-3 text-center bg-green-50 border-green-200">
          <div className="text-4xl">✅</div>
          <h2 className="text-lg font-semibold text-green-900">Delivery posted!</h2>
          <p className="text-sm text-green-800">
            Travellers heading your way can now see this job.
          </p>
          <div className="bg-white rounded-lg p-3 mt-3">
            <p className="text-xs text-muted-foreground">Your tracking ID</p>
            <p className="text-lg font-bold font-mono text-primary">{submitted}</p>
          </div>
          <Button variant="outline" onClick={() => setSubmitted(null)} className="w-full mt-2">
            Done
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Available Trips</h2>
        <Badge variant="secondary" className="text-xs">
          {trips.length} open
        </Badge>
      </div>

      {trips.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <div className="text-4xl">✈️</div>
          <p className="text-sm font-medium">No travellers right now</p>
          <p className="text-xs text-muted-foreground">
            Travellers register routes throughout the day. Post your delivery and a match will find you.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {trips.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l)}
              className="w-full text-left"
            >
