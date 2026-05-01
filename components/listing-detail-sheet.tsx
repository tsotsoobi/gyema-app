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
import { type Listing, updateListingStatus } from "@/lib/listings"

interface ListingDetailSheetProps {
  listing: Listing
  onClose: () => void
}

export function ListingDetailSheet({ listing, onClose }: ListingDetailSheetProps) {
  const [showCoordinate, setShowCoordinate] = useState(false)

  const price = listing.kind === "trip" ? listing.pricePi : listing.offerPi
  const date =
    listing.kind === "trip" ? listing.travelDate : listing.deliverBy

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-6 pt-4">
        <SheetHeader className="text-left space-y-1 pb-3">
