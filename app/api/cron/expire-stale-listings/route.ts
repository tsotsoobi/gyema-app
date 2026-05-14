// Vercel Cron Job: sweep stale 'open' listings → 'expired'.
//
// Runs on the schedule defined in vercel.json (hourly).
// Uses the admin client to bypass RLS — this is a system maintenance
// operation, not a user action, and operates across every Pioneer's
// listings.
//
// Replaces the old client-side expireStaleListingsAsync sweep, which:
//   - Fired on every app load (wasteful)
//   - Wouldn't work at all under tightened RLS (anon role can't
//     update others' listings)
//   - Didn't run when nobody opened the app for a day
//
// Security: Vercel Cron sends a Bearer token in the Authorization
// header matching CRON_SECRET. Manual calls from the internet without
// that header are rejected with 401.

import { createAdminClient } from "@/lib/supabase-admin"

// Force Node.js runtime — the admin client uses Node crypto.
export const runtime = "nodejs"

// Don't cache — every cron tick computes fresh "today" against UTC clock.
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  // Reject unauthorized calls in production. Vercel Cron sends a Bearer
  // token matching CRON_SECRET; manual curl/browser calls won't.
  //
  // The VERCEL === "1" check ensures local development with `vercel dev`
  // can still invoke this route without the secret (Vercel doesn't set
  // VERCEL=1 in local dev).
  if (process.env.VERCEL === "1") {
    const authHeader = request.headers.get("authorization")
    const expected = `Bearer ${process.env.CRON_SECRET}`
    if (!process.env.CRON_SECRET || authHeader !== expected) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }
  }

  const admin = createAdminClient()

  // Compute "today" in Africa/Accra (UTC+0, no DST).
  // Ghana = UTC+0 so toISOString().slice(0, 10) gives the right date,
  // but we keep the explicit timezone math for correctness if Gyema
  // ever serves users in a different timezone.
  const nowGhana = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Accra" })
  )
  const todayIso = nowGhana.toISOString().slice(0, 10) // YYYY-MM-DD

  // Sweep stale packages: deliver_by < today AND status = 'open'
  const { data: pkgData, error: pkgError } = await admin
    .from("listings")
    .update({ status: "expired" })
    .eq("status", "open")
    .eq("kind", "package")
    .lt("deliver_by", todayIso)
    .select("id")

  if (pkgError) {
    console.error("[cron/expire-stale] packages error:", pkgError.message)
  }

  // Sweep stale trips: travel_date < today AND status = 'open'
  const { data: tripData, error: tripError } = await admin
    .from("listings")
    .update({ status: "expired" })
    .eq("status", "open")
    .eq("kind", "trip")
    .lt("travel_date", todayIso)
    .select("id")

  if (tripError) {
    console.error("[cron/expire-stale] trips error:", tripError.message)
  }

  const packagesExpired = pkgData?.length ?? 0
  const tripsExpired = tripData?.length ?? 0
  const totalExpired = packagesExpired + tripsExpired

  if (totalExpired > 0) {
    console.log(
      `[cron/expire-stale] Expired ${totalExpired} listing(s) (today=${todayIso}, packages=${packagesExpired}, trips=${tripsExpired})`
    )
  }

  return Response.json({
    ok: true,
    today: todayIso,
    expiredCount: totalExpired,
    packagesExpired,
    tripsExpired,
  })
}
