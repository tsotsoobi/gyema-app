// Carbon impact math for Gyema.
//
// Estimates CO2 saved per delivery by routing packages through
// travellers who were already making the trip — vs a dedicated
// motorbike or car run.
//
// All functions are pure. No I/O, no side effects, no DB access.
// Unknown cities return 0 rather than throwing or guessing.
//
// Methodology (see /methodology.html for the full explainer):
//   - 130 g CO2/km baseline = avg of motorbike (~80 g/km)
//     and car (~180 g/km), reflecting Ghana's mixed last-mile fleet.
//   - Straight-line haversine distance × 1.3 road correction factor
//     (no real route data in V1).
//   - 50/50 split between sender and traveller — both parties
//     share credit for the avoided dedicated trip.
//
// V2 will replace the city table with real geocoding and
// the road correction with actual route distances.

import type { Listing } from "./listings"

// --- Constants ---------------------------------------------------------------

// kg CO2 emitted per km by a typical Ghana last-mile vehicle.
// Mixed motorbike + car baseline. See /methodology.html.
const KG_CO2_PER_KM = 0.130

// Multiplier to convert straight-line distance to approximate
// road distance. Standard cartography heuristic.
const ROAD_CORRECTION = 1.3

// Earth's mean radius in km, used by the haversine formula.
const EARTH_RADIUS_KM = 6371

// --- City coordinates --------------------------------------------------------

// Ghana cities with (latitude, longitude) in decimal degrees.
// Lookups are case-insensitive and trim whitespace.
// Add new cities here as Gyema expands.
const GHANA_CITIES: Record<string, { lat: number; lng: number }> = {
  accra: { lat: 5.5560, lng: -0.1969 },
  kumasi: { lat: 6.6885, lng: -1.6244 },
  "cape coast": { lat: 5.1053, lng: -1.2466 },
  takoradi: { lat: 4.8845, lng: -1.7554 },
  tamale: { lat: 9.4008, lng: -0.8393 },
  sunyani: { lat: 7.3349, lng: -2.3123 },
  koforidua: { lat: 6.0940, lng: -0.2591 },
  ho: { lat: 6.6118, lng: 0.4709 },
  wa: { lat: 10.0601, lng: -2.5057 },
  bolgatanga: { lat: 10.7856, lng: -0.8514 },
  tema: { lat: 5.6698, lng: -0.0166 },
  kasoa: { lat: 5.5347, lng: -0.4244 },
  nsawam: { lat: 5.8089, lng: -0.3486 },
  madina: { lat: 5.6837, lng: -0.1677 },
  aflao: { lat: 6.1198, lng: 1.1881 },
}

// --- Helpers -----------------------------------------------------------------

function normaliseCity(name: string): string {
  return name.trim().toLowerCase()
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

// Haversine great-circle distance between two lat/lng points.
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_KM * c
}

// --- Public API --------------------------------------------------------------

/**
 * Approximate road distance in km between two Ghana cities.
 * Returns 0 if either city is not in the lookup table.
 *
 * Example: distanceKm("Accra", "Kumasi") ≈ 260
 */
export function distanceKm(fromCity: string, toCity: string): number {
  const from = GHANA_CITIES[normaliseCity(fromCity)]
  const to = GHANA_CITIES[normaliseCity(toCity)]
  if (!from || !to) return 0
  const straightLine = haversineKm(from.lat, from.lng, to.lat, to.lng)
  return straightLine * ROAD_CORRECTION
}

/**
 * Total CO2 saved (in kg) for a delivery covering the given distance.
 * This is the gross saving — split between sender and traveller
 * happens in co2SavedForListing.
 */
export function co2SavedKg(distanceKm: number): number {
  return distanceKm * KG_CO2_PER_KM
}

/**
 * Per-user CO2 saved (in kg) for a single listing.
 * Already split 50/50 between sender and traveller.
 *
 * Returns 0 if either city is unknown — we don't fabricate.
 *
 * Example: co2SavedForListing({ fromCity: "Accra", toCity: "Kumasi", ... })
 *          ≈ 17 kg per user
 */
export function co2SavedForListing(listing: Listing): number {
  const km = distanceKm(listing.fromCity, listing.toCity)
  if (km === 0) return 0
  return co2SavedKg(km) / 2
}
