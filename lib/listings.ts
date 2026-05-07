// Listing type definitions for Gyema.
//
// Data access lives in lib/listings-async.ts. This file is a pure
// type-definitions module imported across the app for type safety.
//
// V2 fields (matchedWith*, *_confirmed, completedAt) are present in
// the database schema and now surfaced in these types so the
// Accept / Mark Complete flow can read and update them.
//
// TODO(v2): Move id and createdAt generation to Postgres defaults
// (gen_random_uuid() and now()) so timestamps are server-authoritative
// and ids are guaranteed unique across clients.

export type ListingKind = "trip" | "package"
export type PackageSize = "envelope" | "small" | "medium" | "large"

// Aligned with the DB CHECK constraint:
// listings_status_check allows exactly these 5 values.
export type ListingStatus =
  | "open"
  | "expired"
  | "matched"
  | "in_transit"
  | "completed"

// Fields shared by Trip and Package, including v2 (Accept / Mark Complete).
type ListingBase = {
  id: string
  fromCity: string
  toCity: string
  postedById: string
  postedByUsername: string
  whatsapp: string
  status: ListingStatus
  trackingId: string
  createdAt: string
  // v2 — populated once a counterparty Accepts the listing.
  matchedWithUserId?: string | null
  matchedWithUsername?: string | null
  matchedWithWhatsapp?: string | null
  matchedAt?: string | null
  // v2 — flipped true by each party's "Mark as Completed" tap.
  // When both are true, the listing transitions to "completed"
  // and completedAt is set.
  senderConfirmed?: boolean
  travellerConfirmed?: boolean
  completedAt?: string | null
}

export type TripListing = ListingBase & {
  kind: "trip"
  travelDate: string
  capacity: PackageSize
  pricePi: number
  notes?: string
}

export type PackageListing = ListingBase & {
  kind: "package"
  deliverBy: string
  size: PackageSize
  description: string
  offerPi: number
}

export type Listing = TripListing | PackageListing

export type CreateTripInput = Omit<
  TripListing,
  | "id"
  | "kind"
  | "status"
  | "trackingId"
  | "createdAt"
  | "matchedWithUserId"
  | "matchedWithUsername"
  | "matchedWithWhatsapp"
  | "matchedAt"
  | "senderConfirmed"
  | "travellerConfirmed"
  | "completedAt"
>

export type CreatePackageInput = Omit<
  PackageListing,
  | "id"
  | "kind"
  | "status"
  | "trackingId"
  | "createdAt"
  | "matchedWithUserId"
  | "matchedWithUsername"
  | "matchedWithWhatsapp"
  | "matchedAt"
  | "senderConfirmed"
  | "travellerConfirmed"
  | "completedAt"
>
