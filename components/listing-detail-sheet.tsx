"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import type { Listing } from "@/lib/listings"

interface ListingDetailSheetProps {
  listing: Listing
  onClose: () => void
}

export function ListingDetailSheet({ listing, onClose }: ListingDetailSheetProps) {
  const [showEscrow, setShowEscrow] = useState(false)

  const price = listing.kind === "trip" ? listing.pricePi : listing.offerPi
  const date =
    listing.kind === "trip" ? listing.travelDate : listing.deliverBy

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-6 pt-4">
        <SheetHeader className="text-left space-y-1 pb-3">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="text-xs">
              {listing.status === "open" ? "Open" : listing.status}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground">
              {listing.trackingId}
            </span>
          </div>
          <SheetTitle className="text-xl">
            {listing.fromCity} → {listing.toCity}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 pt-2">
          {listing.kind === "package" && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Package
              </p>
              <p className="text-sm">{listing.description}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Size: {listing.size}
              </p>
            </div>
          )}

          {listing.kind === "trip" && listing.notes && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Notes
              </p>
              <p className="text-sm">{listing.notes}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Capacity: {listing.capacity}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Date
              </p>
              <p className="text-sm font-medium">{formatDate(date)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Posted by
              </p>
              <p className="text-sm font-medium">@{listing.postedByUsername}</p>
            </div>
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              <p className="text-xs text-muted-foreground">Price</p>
              <p className="text-2xl font-bold text-primary">{price} π</p>
            </div>
            <p className="text-[11px] text-muted-foreground text-right max-w-[55%]">
              Paid via Pi Escrow on Acceptance
            </p>
          </div>

          <Button
            className="w-full h-12 text-base font-semibold"
            onClick={() => setShowEscrow(true)}
          >
            Accept & Escrow π
          </Button>

          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>

        {showEscrow && <EscrowModal onClose={() => setShowEscrow(false)} />}
      </SheetContent>
    </Sheet>
  )
}

// Honest "Coming Soon" escrow modal — visible from the listing detail.
// Real escrow requires a backend server holding the Pi API key, not just
// frontend code. This modal is shown to set expectations clearly.
function EscrowModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center space-y-1">
          <div className="text-3xl">🔐</div>
          <h3 className="text-lg font-bold">Pi Escrow Payment</h3>
          <p className="text-xs text-muted-foreground">
            Held in Smart Escrow · Released on Delivery
          </p>
        </div>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 leading-relaxed">
          <strong>Coming soon (v2).</strong> Real Pi escrow requires a backend server
          for payment approval. In v1, this is shown as the planned flow. When
          live, your Pi will be locked until the recipient confirms delivery.
          Gyema will charge a 5% platform fee on completion.
        </div>

        <div className="space-y-2">
          <Button className="w-full h-11" disabled>
            Authorize Pi Payment (coming soon)
          </Button>
          <Button variant="outline" className="w-full h-11" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return iso
  }
}
