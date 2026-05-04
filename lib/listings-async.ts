import { supabase } from "./supabase"
import type { Listing, PackageSize } from "./listings"

// Database row shape (snake_case, as stored in Supabase)
type ListingRow = {
  id: string
  kind: "trip" | "package"
  from_city: string
  to_city: string
  posted_by_id: string
  posted_by_username: string
  whatsapp: string
  status: "open" | "expired" | "matched" | "in_transit" | "completed"
  tracking_id: string
  created_at: string
  // Trip-only
  travel_date: string | null
  capacity: string | null
  price_pi: number | null
  notes: string | null
  // Package-only
  deliver_by: string | null
  size: string | null
  description: string | null
  offer_pi: number | null
  // v2 (reserved, currently unused)
  matched_with_user_id: string | null
  matched_with_username: string | null
  matched_with_whatsapp: string | null
  matched_at: string | null
  sender_confirmed: boolean
  traveller_confirmed: boolean
  completed_at: string | null
}

// Convert a Supabase row → app-shaped Listing (camelCase)
function fromRow(row: ListingRow): Listing {
  const base = {
    id: row.id,
    trackingId: row.tracking_id,
    postedById: row.posted_by_id,
    postedByUsername: row.posted_by_username,
    whatsapp: row.whatsapp,
    status: row.status,
    from: row.from_city,
    to: row.to_city,
    createdAt: row.created_at,
  }

  if (row.kind === "trip") {
    return {
      ...base,
      kind: "trip",
      travelDate: row.travel_date ?? "",
      capacity: (row.capacity as PackageSize) ?? "small",
      pricePi: row.price_pi ?? 0,
      notes: row.notes ?? "",
    } as Listing
  }

  return {
    ...base,
    kind: "package",
    deliverBy: row.deliver_by ?? "",
    size: (row.size as PackageSize) ?? "small",
    description: row.description ?? "",
    offerPi: row.offer_pi ?? 0,
  } as Listing
}

// ---- Read paths ----

export async function getOpenListingsAsync(): Promise<Listing[]> {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("getOpenListingsAsync error:", error)
    return []
  }

  return (data as ListingRow[]).map(fromRow)
}

export async function getListingsByUserAsync(userId: string): Promise<Listing[]> {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("posted_by_id", userId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("getListingsByUserAsync error:", error)
    return []
  }

  return (data as ListingRow[]).map(fromRow)
}

export async function getListingByTrackingIdAsync(
  trackingId: string
): Promise<Listing | null> {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("tracking_id", trackingId.trim().toUpperCase())
    .maybeSingle()

  if (error) {
    console.error("getListingByTrackingIdAsync error:", error)
    return null
  }
  if (!data) return null

  return fromRow(data as ListingRow)
}

// ---- Write paths ----

// TODO(v2): switch id/trackingId/createdAt to Postgres-generated defaults
// (gen_random_uuid() and now()) once we add proper migrations.

export async function createTripAsync(input: {
  postedById: string
  postedByUsername: string
  whatsapp: string
  from: string
  to: string
  travelDate: string
  capacity: PackageSize
  pricePi: number
  notes: string
}): Promise<Listing | null> {
  const id = `listing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const trackingId = `GYM-${Math.random().toString(16).slice(2, 8).toUpperCase()}`
  const createdAt = new Date().toISOString()

  const row = {
    id,
    kind: "trip" as const,
    from_city: input.from,
    to_city: input.to,
    posted_by_id: input.postedById,
    posted_by_username: input.postedByUsername,
    whatsapp: input.whatsapp,
    status: "open" as const,
    tracking_id: trackingId,
    created_at: createdAt,
    travel_date: input.travelDate,
    capacity: input.capacity,
    price_pi: input.pricePi,
    notes: input.notes,
  }

  const { data, error } = await supabase
    .from("listings")
    .insert(row)
    .select()
    .single()

  if (error) {
    console.error("createTripAsync error:", error)
    return null
  }

  return fromRow(data as ListingRow)
}

export async function createPackageAsync(input: {
  postedById: string
  postedByUsername: string
  whatsapp: string
  from: string
  to: string
  deliverBy: string
  size: PackageSize
  description: string
  offerPi: number
}): Promise<Listing | null> {
  const id = `listing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const trackingId = `GYM-${Math.random().toString(16).slice(2, 8).toUpperCase()}`
  const createdAt = new Date().toISOString()

  const row = {
    id,
    kind: "package" as const,
    from_city: input.from,
    to_city: input.to,
    posted_by_id: input.postedById,
    posted_by_username: input.postedByUsername,
    whatsapp: input.whatsapp,
    status: "open" as const,
    tracking_id: trackingId,
    created_at: createdAt,
    deliver_by: input.deliverBy,
    size: input.size,
    description: input.description,
    offer_pi: input.offerPi,
  }

  const { data, error } = await supabase
    .from("listings")
    .insert(row)
    .select()
    .single()

  if (error) {
    console.error("createPackageAsync error:", error)
    return null
  }

  return fromRow(data as ListingRow)
}

// ---- Maintenance ----

// Sweep stale 'open' listings → 'expired'.
// Packages expire when deliver_by is strictly before today (Ghana time).
// Trips expire when travel_date is strictly before today (Ghana time).
// Safe to call on every app load — costs one query, idempotent.
export async function expireStaleListingsAsync(): Promise<number> {
  // Compute "today" in Africa/Accra (UTC+0, no DST).
  // Ghana = UTC+0 so toISOString().slice(0, 10) gives the right date,
  // but we keep the explicit timezone math so this stays correct if we ever
  // host the app or its users in a different timezone.
  const nowGhana = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Accra" })
  )
  const todayIso = nowGhana.toISOString().slice(0, 10) // YYYY-MM-DD

  // Sweep packages: deliver_by < today
  const { data: pkgData, error: pkgError } = await supabase
    .from("listings")
    .update({ status: "expired" })
    .eq("status", "open")
    .eq("kind", "package")
    .lt("deliver_by", todayIso)
    .select("id")

  if (pkgError) {
    console.error("expireStaleListingsAsync (packages) error:", pkgError)
  }

  // Sweep trips: travel_date < today
  const { data: tripData, error: tripError } = await supabase
    .from("listings")
    .update({ status: "expired" })
    .eq("status", "open")
    .eq("kind", "trip")
    .lt("travel_date", todayIso)
    .select("id")

  if (tripError) {
    console.error("expireStaleListingsAsync (trips) error:", tripError)
  }

  const expiredCount =
    (pkgData?.length ?? 0) + (tripData?.length ?? 0)

  if (expiredCount > 0) {
    console.log(`[gyema] Expired ${expiredCount} stale listing(s) (today=${todayIso})`)
  }

  return expiredCount
}
