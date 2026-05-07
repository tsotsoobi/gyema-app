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
import {
  acceptListingAsync,
  confirmCompletionAsync,
} from "@/lib/listings-async"

// The viewer's role with respect to this listing.
// - "sender" or "traveller": viewer is a party to the delivery (poster or matched)
// - "outsider": viewer is some other Pioneer browsing the marketplace
// - "self_open": viewer is the original poster while the listing is still open
//                (no Accept button shown to themselves)
type ViewerRole = "sender" | "traveller" | "outsider" | "self_open"

function determineViewerRole(
  listing: Listing,
  viewerUid: string,
): ViewerRole {
  const isPoster = listing.postedById === viewerUid
  const isMatched = listing.matchedWithUserId === viewerUid

  // Open listings: poster sees self_open, others see outsider
  if (listing.status === "open") {
    return isPoster ? "self_open" : "outsider"
  }

  // Once matched, only the two parties have any role
  if (!isPoster && !isMatched) return "outsider"

  // Sender = the party providing the package
  // Traveller = the party physically carrying it
  //
  // Logic:
  //   - kind="package" means a Sender posted asking for delivery,
  //     so the poster is the SENDER and the matched user is the TRAVELLER.
  //   - kind="trip" means a Traveller posted offering capacity,
  //     so the poster is the TRAVELLER and the matched user is the SENDER.
  if (listing.kind === "package") {
    return isPoster ? "sender" : "traveller"
  }
  return isPoster ? "traveller" : "sender"
}

interface ListingDetailSheetProps {
  listing: Listing
  currentUser: {
    uid: string
    username: string
    whatsapp?: string
  }
  onClose: () => void
  onListingUpdated?: (updated: Listing) => void
}

export function ListingDetailSheet({
  listing: initialListing,
  currentUser,
  onClose,
  onListingUpdated,
}: ListingDetailSheetProps) {
  // Keep the listing in local state so Accept/Mark-Complete actions
  // re-render the sheet with new buttons immediately, without forcing
  // the parent to refetch and re-mount the component.
  const [listing, setListing] = useState<Listing>(initialListing)

  const [acceptPending, setAcceptPending] = useState(false)
  const [confirmPending, setConfirmPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const role = determineViewerRole(listing, currentUser.uid)
  const price = listing.kind === "trip" ? listing.pricePi : listing.offerPi
  const date =
    listing.kind === "trip" ? listing.travelDate : listing.deliverBy

  // Whose WhatsApp to surface in the Coordinate section.
  // Open listings: always show the poster's number (no one else exists yet).
  // Matched listings: show the OTHER party's number to whoever is viewing.
  const otherPartyWhatsapp =
    role === "sender"
      ? listing.matchedWithWhatsapp ?? listing.whatsapp
      : role === "traveller"
        ? listing.whatsapp
        : listing.whatsapp

  const otherPartyUsername =
    role === "sender"
      ? listing.matchedWithUsername ?? listing.postedByUsername
      : role === "traveller"
        ? listing.postedByUsername
        : listing.postedByUsername

  const whatsappDigits = (otherPartyWhatsapp ?? "").replace(/\D/g, "")
  const whatsappHref = whatsappDigits
    ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(
        `Hi! Re: Gyema delivery ${listing.trackingId}. `,
      )}`
    : null

  const piChatHref = "https://chat.pinet.com/home"

  const handleAccept = async () => {
    if (!currentUser.whatsapp) {
      setActionError(
        "Add a WhatsApp number to your profile before accepting deliveries.",
      )
      return
    }
    setAcceptPending(true)
    setActionError(null)
    try {
      const updated = await acceptListingAsync({
        listingId: listing.id,
        accepterUserId: currentUser.uid,
        accepterUsername: currentUser.username,
        accepterWhatsapp: currentUser.whatsapp,
      })
      if (!updated) {
        setActionError(
          "This listing is no longer available. Someone may have just accepted it.",
        )
        setAcceptPending(false)
        return
      }
      setListing(updated)
      onListingUpdated?.(updated)
    } catch (err) {
      console.error("[gyema] handleAccept error:", err)
      setActionError("Could not accept this listing. Please try again.")
    } finally {
      setAcceptPending(false)
    }
  }

  const handleConfirmCompletion = async () => {
    if (role !== "sender" && role !== "traveller") return
    setConfirmPending(true)
    setActionError(null)
    try {
      const updated = await confirmCompletionAsync({
        listingId: listing.id,
        role,
      })
      if (!updated) {
        setActionError("Could not confirm completion. Please try again.")
        setConfirmPending(false)
        return
      }
      setListing(updated)
      onListingUpdated?.(updated)
    } catch (err) {
      console.error("[gyema] handleConfirmCompletion error:", err)
      setActionError("Could not confirm completion. Please try again.")
    } finally {
      setConfirmPending(false)
    }
  }

  // Whether THIS viewer has already confirmed their side.
  const viewerHasConfirmed =
    (role === "sender" && listing.senderConfirmed) ||
    (role === "traveller" && listing.travellerConfirmed)

  // Status pill shown at the top of the sheet
  const statusBadge = (() => {
    switch (listing.status) {
      case "open":
        return { text: "Open", variant: "secondary" as const }
      case "matched":
        return { text: "Matched", variant: "default" as const }
      case "in_transit":
        return { text: "In transit", variant: "default" as const }
      case "completed":
        return { text: "Completed", variant: "default" as const }
      case "expired":
        return { text: "Expired", variant: "outline" as const }
      default:
        return { text: listing.status, variant: "secondary" as const }
    }
  })()

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-6 pt-4">
        <SheetHeader className="text-left space-y-1 pb-3">
          <div className="flex items-center justify-between">
            <Badge variant={statusBadge.variant} className="text-xs">
              {statusBadge.text}
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
              Coordinate payment off-platform · Pi Escrow coming in v2
            </p>
          </div>

          {/* Coordinate section: only meaningful once parties exist (matched onward).
              For open listings shown to outsiders, we still surface the poster's
              contact since that's how they currently make a deal pre-Accept. */}
          {(role === "sender" ||
            role === "traveller" ||
            role === "outsider") &&
            listing.status !== "completed" &&
            listing.status !== "expired" && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Coordinate
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {whatsappHref ? (
                    <a
                      href={whatsappHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <Button
                        variant="outline"
                        className="w-full h-11 text-sm font-semibold"
                      >
                        💬 WhatsApp
                      </Button>
                    </a>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full h-11 text-sm font-semibold"
                      disabled
                    >
                      💬 WhatsApp
                    </Button>
                  )}
                  <a
                    href={piChatHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <Button
                      variant="outline"
                      className="w-full h-11 text-sm font-semibold"
                    >
                      🥧 Chat in Pi
                    </Button>
                  </a>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  In Pi Chat, search{" "}
                  <span className="font-mono">@{otherPartyUsername}</span> to
                  start a conversation.
                </p>
              </div>
            )}

          {/* Primary action area — depends on viewer role and listing state */}
          <div className="pt-1 space-y-2">
            {role === "outsider" && listing.status === "open" && (
              <>
                <Button
                  className="w-full h-12 text-base font-semibold"
                  onClick={handleAccept}
                  disabled={acceptPending}
                >
                  {acceptPending ? "Accepting..." : "Accept this delivery"}
                </Button>
                <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                  By accepting, you agree to coordinate this delivery with{" "}
                  @{listing.postedByUsername} via WhatsApp or Pi Chat.
                </p>
              </>
            )}

            {role === "self_open" && (
              <p className="text-xs text-muted-foreground text-center leading-relaxed">
                This is your listing. Travellers and Senders will be able to
                accept it from their side.
              </p>
            )}

            {(role === "sender" || role === "traveller") &&
              (listing.status === "matched" ||
                listing.status === "in_transit") && (
                <>
                  <div className="rounded-lg bg-muted/40 p-3 space-y-1">
                    <p className="text-xs font-semibold">Confirmation status</p>
                    <p className="text-xs text-muted-foreground">
                      Sender: {listing.senderConfirmed ? "✓ confirmed" : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Traveller:{" "}
                      {listing.travellerConfirmed ? "✓ confirmed" : "—"}
                    </p>
                  </div>
                  <Button
                    className="w-full h-12 text-base font-semibold"
                    onClick={handleConfirmCompletion}
                    disabled={confirmPending || viewerHasConfirmed}
                  >
                    {viewerHasConfirmed
                      ? "You've confirmed — waiting on the other party"
                      : confirmPending
                        ? "Confirming..."
                        : `Mark as completed (as ${role})`}
                  </Button>
                  <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                    Both parties must confirm before the delivery is marked
                    completed.
                  </p>
                </>
              )}

            {listing.status === "completed" && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 space-y-1 text-center">
                <div className="text-2xl">✅</div>
                <p className="text-sm font-semibold text-emerald-900">
                  Delivery completed
                </p>
                <p className="text-xs text-emerald-800">
                  Both parties confirmed. Thank you for using Gyema.
                </p>
              </div>
            )}

            {listing.status === "expired" && (
              <div className="rounded-lg bg-muted/40 p-3 text-center">
                <p className="text-xs text-muted-foreground">
                  This listing has expired and is no longer available.
                </p>
              </div>
            )}

            {actionError && (
              <p className="text-xs text-destructive text-center leading-relaxed">
                {actionError}
              </p>
            )}
          </div>

          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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
