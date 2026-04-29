// Listings store for Gyema v1.
//
// IMPORTANT — v1 limitation: listings are saved in the user's own device
// localStorage. This means a trip posted by Pioneer A is NOT visible to
// Pioneer B on a different device. v1 ships this way to keep the app
// simple enough for Pi App Studio submission; v2 replaces this with a
// real backend (Supabase planned) so listings sync across users.
//
// All public functions in this file return what they would return with
// a real backend, so swapping the storage layer in v2 won't change any
// component code.

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
  status: ListingStatus
  trackingId: string
  createdAt: string
}

export type Listing = TripListing | PackageListing

const STORAGE_KEY = "gyema-listings-v1"

// Tracking ID format matches the Railway design preview: GYM-XXXXXX (6 hex chars).
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

const loadAll = (): Listing[] => {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Listing[]) : []
  } catch {
    return []
  }
}

const saveAll = (listings: Listing[]) => {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(listings))
  } catch (e) {
    console.warn("[gyema] Could not persist listings:", e)
  }
}

export const getAllListings = (): Listing[] => {
  return loadAll().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

export const getListingsByUser = (userId: string): Listing[] => {
  return getAllListings().filter((l) => l.postedById === userId)
}

export const getOpenListings = (): Listing[] => {
  return getAllListings().filter((l) => l.status === "open")
}

export const getListingByTrackingId = (trackingId: string): Listing | null => {
  const normalized = trackingId.trim().toUpperCase()
  return getAllListings().find((l) => l.trackingId === normalized) ?? null
}

export type CreateTripInput = Omit<
  TripListing,
  "id" | "kind" | "status" | "trackingId" | "createdAt"
>

export const createTrip = (input: CreateTripInput): TripListing => {
  const listing: TripListing = {
    ...input,
    id: generateId(),
    kind: "trip",
    status: "open",
    trackingId: generateTrackingId(),
    createdAt: new Date().toISOString(),
  }
  const all = loadAll()
  all.unshift(listing)
  saveAll(all)
  return listing
}

export type CreatePackageInput = Omit<
  PackageListing,
  "id" | "kind" | "status" | "trackingId" | "createdAt"
>

export const createPackage = (input: CreatePackageInput): PackageListing => {
  const listing: PackageListing = {
    ...input,
    id: generateId(),
    kind: "package",
    status: "open",
    trackingId: generateTrackingId(),
    createdAt: new Date().toISOString(),
  }
  const all = loadAll()
  all.unshift(listing)
  saveAll(all)
  return listing
}

export const updateListingStatus = (
  id: string,
  status: ListingStatus
): Listing | null => {
  const all = loadAll()
  const idx = all.findIndex((l) => l.id === id)
  if (idx === -1) return null
  all[idx].status = status
  saveAll(all)
  return all[idx]
}
