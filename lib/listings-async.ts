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
  // v2 — Accept / Mark Complete
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
    fromCity: row.from_city,
    toCity: row.to_city,
    createdAt: row.created_at,
    // v2 fields surface as nullable values from the DB
    matchedWithUserId: row.matched_with_user_id,
    matchedWithUsername: row.matched_with_username,
    matchedWithWhatsapp: row.matched_with_whatsapp,
    matchedAt: row.matched_at,
    senderConfirmed: row.sender_confirmed,
    travellerConfirmed: row.traveller_confirmed,
    completedAt: row.completed_at,
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
  // Return both: listings the user posted, AND listings where the user
  // accepted (matched_with_user_id). Either makes the listing "theirs".
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .or(`posted_by_id.eq.${userId},matched_with_user_id.eq.${userId}`)
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
  fromCity: string
  toCity: string
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
    from_city: input.fromCity,
    to_city: input.toCity,
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
  fromCity: string
  toCity: string
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
    from_city: input.fromCity,
    to_city: input.toCity,
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

// ---- Accept / Mark Complete (v2) ----

// Accept a listing: the current user agrees to be the counterparty.
// Only succeeds if the listing is still 'open' — prevents two users
// from both "accepting" the same listing in a race.
//
// On success, the listing transitions: open → matched.
// posted_by_id remains the original poster; matched_with_* records
// the accepter so both parties are now stored on the row.
export async function acceptListingAsync(input: {
  listingId: string
  accepterUserId: string
  accepterUsername: string
  accepterWhatsapp: string
}): Promise<Listing | null> {
  const { data, error } = await supabase
    .from("listings")
    .update({
      status: "matched",
      matched_with_user_id: input.accepterUserId,
      matched_with_username: input.accepterUsername,
      matched_with_whatsapp: input.accepterWhatsapp,
      matched_at: new Date().toISOString(),
    })
    .eq("id", input.listingId)
    .eq("status", "open") // race guard: only update if still open
    .select()
    .single()

  if (error) {
    console.error("acceptListingAsync error:", error)
    return null
  }

  return data ? fromRow(data as ListingRow) : null
}

// Confirm completion of a delivery from one party's side.
//
// Roles work like this:
//   - kind = 'package' (Sender posted): poster is the Sender,
//     the matched user is the Traveller.
//   - kind = 'trip' (Traveller posted): poster is the Traveller,
//     the matched user is the Sender.
//
// We DON'T re-derive role here from kind — the caller already knows
// because it's their listing. The caller passes whether THEY are
// confirming as the sender or the traveller.
//
// If the other side has already confirmed, the listing transitions to
// 'completed' and completed_at is set. Otherwise the listing stays in
// 'matched' but the relevant *_confirmed flag is now true.
export async function confirmCompletionAsync(input: {
  listingId: string
  role: "sender" | "traveller"
}): Promise<Listing | null> {
  // First, read current confirmation state so we know if THIS confirmation
  // is the one that completes the delivery.
  const { data: existing, error: readError } = await supabase
    .from("listings")
    .select("sender_confirmed, traveller_confirmed, status")
    .eq("id", input.listingId)
    .single()

  if (readError || !existing) {
    console.error("confirmCompletionAsync read error:", readError)
    return null
  }

  // Listings that haven't been matched yet can't be confirmed.
  if (existing.status === "open" || existing.status === "expired") {
    console.warn("confirmCompletionAsync: listing not in matched state")
    return null
  }
  // Already completed — return as-is, no double-completion.
  if (existing.status === "completed") {
    const { data, error } = await supabase
      .from("listings")
      .select("*")
      .eq("id", input.listingId)
      .single()
    if (error || !data) return null
    return fromRow(data as ListingRow)
  }

  const otherAlreadyConfirmed =
    input.role === "sender"
      ? existing.traveller_confirmed
      : existing.sender_confirmed

  // Build the update: flip THIS side's flag. If the other side was already
  // true, also transition the listing to 'completed' and stamp completed_at.
  const update: Record<string, unknown> = {}
  if (input.role === "sender") {
    update.sender_confirmed = true
  } else {
    update.traveller_confirmed = true
  }
  if (otherAlreadyConfirmed) {
    update.status = "completed"
    update.completed_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from("listings")
    .update(update)
    .eq("id", input.listingId)
    .select()
    .single()

  if (error || !data) {
    console.error("confirmCompletionAsync update error:", error)
    return null
  }

  return fromRow(data as ListingRow)
}

// Cancel a matched listing: either party (poster or matched user) can call this
// when a deal falls through, the counterparty ghosts, or the date passes
// without completion. Listing transitions: matched/in_transit → expired.
//
// V1.x: caller is responsible for verifying the user is actually one of the
// two parties before showing the cancel UI. Server-side enforcement (RLS)
// arrives in V2 along with proper Pi-auth-to-Supabase JWT bridging.
//
// Once expired, the listing cannot be revived — it falls into the user's
// Past Trips/Deliveries section. This is a destructive action; UI must
// confirm before calling.
export async function cancelMatchedListingAsync(input: {
  listingId: string
}): Promise<Listing | null> {
  const { data, error } = await supabase
    .from("listings")
    .update({ status: "expired" })
    .eq("id", input.listingId)
    // Race guard: only cancel if still in matched/in_transit. Prevents
    // accidentally overwriting a listing that just transitioned to
    // 'completed' between sheet render and button tap.
    .in("status", ["matched", "in_transit"])
    .select()
    .single()

  if (error) {
    console.error("cancelMatchedListingAsync error:", error)
    return null
  }

  return data ? fromRow(data as ListingRow) : null
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
