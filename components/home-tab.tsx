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
      onCreated={onListingCreated}
    />
  )
}

// Traveller view: Available Jobs (packages senders need delivered)
function TravellerHome({
  currentUserId,
  refreshKey,
}: {
  currentUserId: string
  refreshKey: number
}) {
  const [selected, setSelected] = useState<Listing | null>(null)

  // refreshKey is intentionally consumed in JSX below to keep React happy;
  // re-renders are triggered by parent state changes.
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

// Sender view: Post a Delivery form
function SenderHome({
  user,
  onCreated,
}: {
  user: PiUser
  onCreated: () => void
}) {
  const [description, setDescription] = useState("")
  const [size, setSize] = useState<PackageSize | "">("")
  const [fromCity, setFromCity] = useState("")
  const [toCity, setToCity] = useState("")
  const [deliverBy, setDeliverBy] = useState("")
  const [offer, setOffer] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)

  const valid =
    description.trim() &&
    size &&
    fromCity.trim() &&
    toCity.trim() &&
    deliverBy &&
    offer

  const handleSubmit = () => {
    if (!valid) return
    const listing = createPackage({
      description: description.trim(),
      size: size as PackageSize,
      fromCity: fromCity.trim(),
      toCity: toCity.trim(),
      deliverBy,
      offerPi: parseFloat(offer),
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
            Post another
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <h2 className="text-lg font-semibold">Post a Delivery</h2>

      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="desc">Package Description</Label>
          <Textarea
            id="desc"
            placeholder="e.g. sealed box of phone accessories"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="size">Package Size</Label>
          <Select value={size} onValueChange={(v) => setSize(v as PackageSize)}>
            <SelectTrigger id="size">
              <SelectValue placeholder="Select size" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="envelope">Envelope / documents</SelectItem>
              <SelectItem value="small">Small (under 2 kg)</SelectItem>
              <SelectItem value="medium">Medium (2–10 kg)</SelectItem>
              <SelectItem value="large">Large (10 kg+)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="from">From City</Label>
            <Input
              id="from"
              placeholder="Accra"
              value={fromCity}
              onChange={(e) => setFromCity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">To City</Label>
            <Input
              id="to"
              placeholder="Tamale"
              value={toCity}
              onChange={(e) => setToCity(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="deadline">Deadline</Label>
          <Input
            id="deadline"
            type="date"
            value={deliverBy}
            onChange={(e) => setDeliverBy(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="offer">Your Offer (π Pi)</Label>
          <Input
            id="offer"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.1"
            placeholder="5"
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
          />
        </div>

        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={handleSubmit}
          disabled={!valid}
        >
          Post Delivery Request
        </Button>
      </Card>

      <Card className="p-4 bg-amber-50 border-amber-200">
        <p className="text-xs text-amber-900 leading-relaxed">
          ⚠️ Never send illegal items, cash, or anything you wouldn't trust a stranger
          with. Gyema is not responsible for the contents of packages.
        </p>
      </Card>
    </div>
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
