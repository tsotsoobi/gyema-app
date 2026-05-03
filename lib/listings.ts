// Listing type definitions for Gyema v1.
//
// As of Commit 8 of the Supabase migration, all data access lives in
// lib/listings-async.ts. This file is now a pure type-definitions module
// imported across the app for type safety.
//
// TODO(v2): Move id and createdAt generation to Postgres defaults
// (gen_random_uuid() and now()) so timestamps are server-authoritative
// and ids are guaranteed unique across clients.

export type ListingKind = "trip" | "package"
export type PackageSize = "envelope" | "small" | "medium" | "large"
export type ListingStatus = "open" | "matched" | "completed" | "cancelled"

export type TripListing = {
  id: string
  kind: "trip"
  fromCity: string
  toCity: string
  travelDate: string
  capacity: PackageSize
  pricePi: number
  notes?: string
  postedById: string
  postedByUsername: string
  whatsapp: string
  status: ListingStatus
  trackingId: string
  createdAt: string
}

export type PackageListing = {
  id: string
  kind: "package"
  fromCity: string
  toCity: string
  deliverBy: string
  size: PackageSize
  description: string
  offerPi: number
  postedById: string
  postedByUsername: string
  whatsapp: string
  status: ListingStatus
  trackingId: string
  createdAt: string
}

export type Listing = TripListing | PackageListing

export type CreateTripInput = Omit<
  TripListing,
  "id" | "kind" | "status" | "trackingId" | "createdAt"
>

export type CreatePackageInput = Omit<
  PackageListing,
  "id" | "kind" | "status" | "trackingId" | "createdAt"
>
