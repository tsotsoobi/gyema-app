// Async Supabase-backed variants of listing functions.
//
// These mirror the sync functions in lib/listings.ts but read/write to
// Supabase instead of localStorage. Both sets coexist during the migration
// (Commits 3-8). Once all components are migrated, the sync versions get
// removed and these become the canonical implementations.
//
// TODO(v2): Move id and createdAt generation to Postgres defaults
// (gen_random_uuid() and now()) so timestamps are server-authoritative
// and ids are guaranteed unique across clients.

import { supabase } from "./supabase"
import type {
  Listing,
  TripListing,
  PackageListing,
  CreateTripInput,
  CreatePackageInput,
} from "./listings"

// ---------- ID + tracking generation (kept identical to sync version) ----------

const generateTrackingId = (): string => {
  const chars = "0123456789ABCDEF"
  let suffix = ""
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return `GYM-000${suffix}`
}

const generateId = (): string => {
  return `listing_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

// ---------- Row mapping: camelCase TS <-> snake_case Postgres ----------

// Postgres row shape. Includes columns we don't use in v1 (matched_*, etc.)
// so that fromRow() can safely ignore them.
type ListingRow = {
  id: string
  kind: "trip" | "package"
  from_city: string
  to_city: string
  posted_by_id: string
  posted_by_username: string
  whatsapp: string
  status: string
  tracking_id: string
  created_at: string
  travel_date: string | null
  capacity: string | null
  price_pi: number | null
  notes: string | null
  deliver_by: string | null
  size: string | null
  description: string | null
  offer_pi: number | null
}

const fromRow = (row: ListingRow): Listing => {
  if (row.kind === "trip") {
    return {
      id: row.id,
      kind: "trip",
      fromCity: row.from_city,
      toCity: row.to_city,
      travelDate: row.travel_date ?? "",
      capacity: (row.capacity ?? "small") as TripListing["capacity"],
      pricePi: row.price_pi ?? 0,
      notes: row.notes ?? undefined,
      postedById: row.posted_by_id,
      postedByUsername: row.posted_by_username,
      whatsapp: row.whatsapp,
      status: row.status as TripListing["status"],
      trackingId: row.tracking_id,
      createdAt: row.created_at,
    }
  }
  return {
    id: row.id,
    kind: "package",
    fromCity: row.from_city,
    toCity: row.to_city,
    deliverBy: row.deliver_by ?? "",
    size: (row.size ?? "small") as PackageListing["size"],
    description: row.description ?? "",
    offerPi: row.offer_pi ?? 0,
    postedById: row.posted_by_id,
    postedByUsername: row.posted_by_username,
    whatsapp: row.whatsapp,
    status: row.status as PackageListing["status"],
    trackingId: row.tracking_id,
    createdAt: row.created_at,
  }
}

// ---------- Read functions ----------

export const getOpenListingsAsync = async (): Promise<Listing[]> => {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[gyema] getOpenListingsAsync failed:", error)
    return []
  }
  return (data as ListingRow[]).map(fromRow)
}

export const getListingsByUserAsync = async (
  userId: string
): Promise<Listing[]> => {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("posted_by_id", userId)
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[gyema] getListingsByUserAsync failed:", error)
    return []
  }
  return (data as ListingRow[]).map(fromRow)
}

export const getListingByTrackingIdAsync = async (
  trackingId: string
): Promise<Listing | null> => {
  const normalized = trackingId.trim().toUpperCase()
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("tracking_id", normalized)
    .maybeSingle()
  if (error) {
    console.error("[gyema] getListingByTrackingIdAsync failed:", error)
    return null
  }
  return data ? fromRow(data as ListingRow) : null
}

// ---------- Write functions ----------

export const createTripAsync = async (
  input: CreateTripInput
): Promise<TripListing> => {
  const listing: TripListing = {
    ...input,
    id: generateId(),
    kind: "trip",
    status: "open",
    trackingId: generateTrackingId(),
    createdAt: new Date().toISOString(),
  }
  const { error } = await supabase.from("listings").insert({
    id: listing.id,
    kind: "trip",
    from_city: listing.fromCity,
    to_city: listing.toCity,
    travel_date: listing.travelDate,
    capacity: listing.capacity,
    price_pi: listing.pricePi,
    notes: listing.notes ?? null,
    posted_by_id: listing.postedById,
    posted_by_username: listing.postedByUsername,
    whatsapp: listing.whatsapp,
    status: listing.status,
    tracking_id: listing.trackingId,
    created_at: listing.createdAt,
  })
  if (error) {
    console.error("[gyema] createTripAsync failed:", error)
    throw error
  }
  return listing
}

export const createPackageAsync = async (
  input: CreatePackageInput
): Promise<PackageListing> => {
  const listing: PackageListing = {
    ...input,
    id: generateId(),
    kind: "package",
    status: "open",
    trackingId: generateTrackingId(),
    createdAt: new Date().toISOString(),
  }
  const { error } = await supabase.from("listings").insert({
    id: listing.id,
    kind: "package",
    from_city: listing.fromCity,
    to_city: listing.toCity,
    deliver_by: listing.deliverBy,
    size: listing.size,
    description: listing.description,
    offer_pi: listing.offerPi,
    posted_by_id: listing.postedById,
    posted_by_username: listing.postedByUsername,
    whatsapp: listing.whatsapp,
    status: listing.status,
    tracking_id: listing.trackingId,
    created_at: listing.createdAt,
  })
  if (error) {
    console.error("[gyema] createPackageAsync failed:", error)
    throw error
  }
  return listing
}
