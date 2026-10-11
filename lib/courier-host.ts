// The courier host: the front door for couriers without a Pi account
// (docs/anchoring-decisions.md, answer 1). One subdomain of the company
// domain per network, pointed at the same deployment as everything else.
//
// The app tells the two surfaces apart by the Host header alone, and
// middleware.ts enforces the split on every request:
//
//   courier surface  the host named in COURIER_HOST. Serves the courier page
//                    and the few APIs a courier calls, and nothing else. The
//                    Pi SDK is never loaded here (app/layout.tsx), and the
//                    CSP names no Pi origin (lib/csp.ts, buildCourierCsp).
//   pioneer surface  every other host: the pinet host, the raw Vercel URL,
//                    previews, localhost. Everything as before, except that
//                    the courier pages and courier APIs are refused, so a
//                    courier identity cannot be used through the Pioneer
//                    front door.
//
// WHY AN ENVIRONMENT VARIABLE, not the host written here: each deployment is
// told its own courier host, so the two networks' hosts cannot swap by a
// copy of this file, and the file names no network, so it mirrors between
// repositories as bytes. COURIER_HOST unset or empty means no host is the
// courier host: every courier path is refused everywhere. It fails closed.
//
// The Host header is trusted here because Vercel routes a request to this
// deployment only for a domain attached to the project.

/** Set by middleware on every request, always overwriting what came in. */
export const SURFACE_HEADER = "x-gyema-surface"

export type Surface = "courier" | "pioneer"

/** The hostname of a Host header: lower case, no port, no trailing dot. */
export function hostnameOf(host: string | null | undefined): string {
  if (!host) return ""
  let h = host.trim().toLowerCase()
  if (h.startsWith("[")) {
    // An IPv6 literal; never a courier host, but keep it whole.
    const end = h.indexOf("]")
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.indexOf(":")
  if (colon !== -1) h = h.slice(0, colon)
  return h.replace(/\.+$/, "")
}

/** Which surface a request is on. Exact hostname match, nothing looser. */
export function surfaceFor(host: string | null | undefined, courierHost: string | undefined): Surface {
  const want = hostnameOf(courierHost)
  if (want === "") return "pioneer"
  return hostnameOf(host) === want ? "courier" : "pioneer"
}

/** Pages and APIs that exist only for the courier surface. */
export function isCourierOnlyPath(pathname: string): boolean {
  return (
    pathname === "/courier" ||
    pathname.startsWith("/courier/") ||
    pathname === "/api/courier" ||
    pathname.startsWith("/api/courier/")
  )
}

/**
 * The one guest API the courier page calls: the job board, which is public
 * and carries no contact field. Everything else a courier does on this host
 * goes through /api/courier/jobs/* (accept, mine, confirm-delivery), resolved
 * from the session cookie (Phase 1 item 6, 6.2 and 6.10 decision 1).
 *
 * NOT here, deliberately: /api/guest/accept, /api/guest/mine and
 * /api/guest/confirm-delivery, which are Pioneer routes (confirm-delivery
 * also carries the sender's last-4 branch: item 4, founder decision 2); the
 * sender's routes (create, track, confirm-pickup, delivery-code); every
 * listings and payments route; /api/auth/verify (Pi sign-in);
 * /api/kyc/webhook (registered on the raw Vercel URL); and /api/cron/*.
 */
export const COURIER_GUEST_APIS: readonly string[] = ["/api/guest/open"]

/** Whether the courier surface serves this path. "/" is rewritten to /courier. */
export function courierSurfaceServes(pathname: string): boolean {
  return pathname === "/" || isCourierOnlyPath(pathname) || COURIER_GUEST_APIS.includes(pathname)
}
