import { NextRequest, NextResponse } from "next/server"
import { buildCourierCsp, buildCsp, cspHeaderName } from "@/lib/csp"
import {
  courierSurfaceServes,
  isCourierOnlyPath,
  SURFACE_HEADER,
  surfaceFor,
} from "@/lib/courier-host"

// Edge middleware. Three jobs: get every request onto https, keep the courier
// host and the Pioneer front door apart (lib/courier-host.ts), and mint the
// CSP nonce for the request so the policy and the page agree about it.
//
// Vercel terminates TLS and answers http itself, so a request that arrives
// over http reaches the app as an ordinary request with x-forwarded-proto
// saying so. Without this, an http URL for a custom domain would serve the app
// over cleartext: the session token in the response body of /api/auth/verify,
// a delivery code from /api/guest/delivery-code, and a sender's phone number
// would all cross the network in the clear.
//
// HSTS in next.config.mjs tells a browser never to try http again. This is
// what handles the FIRST request, before the browser has been told, and any
// request from something that ignores HSTS.
//
// LOOPBACK IS EXEMPT, deliberately: `next dev` serves http://localhost, and a
// redirect there is an infinite loop against a server that has no https to
// redirect to. The check is on the hostname, not on an environment variable,
// so it cannot be switched off in production by setting NODE_ENV wrongly.
// Any name under .localhost counts too: browsers resolve it to loopback
// (RFC 6761), and it is how the courier host is tried locally, with
// COURIER_HOST=couriers.localhost. Vercel never routes such a name here.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopback(hostname: string): boolean {
  const bare = hostname.split(":")[0]
  return LOOPBACK_HOSTS.has(bare) || LOOPBACK_HOSTS.has(hostname) || bare.endsWith(".localhost")
}

export function middleware(request: NextRequest) {
  const proto = request.headers.get("x-forwarded-proto")
  const host = request.headers.get("host") ?? request.nextUrl.host

  // Only redirect when the proxy has told us it was http. An absent header
  // means nothing is in front of us, which is the local dev case, and
  // guessing there would break it.
  if (proto === "http" && !isLoopback(host)) {
    const url = request.nextUrl.clone()
    url.protocol = "https:"
    url.port = ""
    // 308 rather than 301: it preserves the method and the body, so a POST
    // that arrives over http is not silently turned into a GET. It should not
    // happen, and if it does, losing the request quietly is worse than
    // redirecting it.
    return NextResponse.redirect(url, 308)
  }

  // Which front door this is. COURIER_HOST is read directly, not through a
  // computed key, so the edge bundle sees it.
  const surface = surfaceFor(host, process.env.COURIER_HOST)
  const path = request.nextUrl.pathname

  // The courier host serves the courier page and its APIs and refuses the
  // rest. Every other host refuses the courier page and its APIs. A refusal
  // is a plain 404: it says nothing about what exists on the other surface.
  if (surface === "courier" ? !courierSurfaceServes(path) : isCourierOnlyPath(path)) {
    return refuse(path, surface)
  }

  // A fresh nonce per request. Base64 of 16 random bytes: not a secret, but
  // unpredictable to an injected script, which is the only reader that matters.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")
  const csp = surface === "courier" ? buildCourierCsp(nonce) : buildCsp(nonce)

  // The nonce reaches the layout through a REQUEST header, which is how a
  // server component reads a per-request value. It goes out on the response
  // too, so it can be read from a browser's network tab while debugging a
  // blocked script.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  // ALWAYS set, never read from the request: a client sending its own
  // x-gyema-surface on the pinet host must not reach the layout as courier,
  // or as anything else.
  requestHeaders.set(SURFACE_HEADER, surface)

  // On the courier host, "/" is the courier page. A rewrite, not a redirect,
  // so the address bar stays at the bare host.
  const response =
    surface === "courier" && path === "/"
      ? NextResponse.rewrite(new URL("/courier", request.url), { request: { headers: requestHeaders } })
      : NextResponse.next({ request: { headers: requestHeaders } })
  // CSP_ENFORCE governs the Pioneer surface only, where a wrong policy can
  // stop Pi sign-in. The courier host loads no Pi SDK, so its policy always
  // enforces (founder decision, 8 Oct 2026).
  const cspHeader =
    surface === "courier" ? "Content-Security-Policy" : cspHeaderName(process.env.CSP_ENFORCE)
  response.headers.set(cspHeader, csp)
  response.headers.set("x-nonce", nonce)
  if (surface === "courier") courierOnlyHeaders(response.headers)
  return response
}

/**
 * Set on the courier host only. Nothing frames it, and the Pi Browser rule
 * that keeps X-Frame-Options out of next.config.mjs does not apply here. A
 * search engine has no business indexing a sign-in host.
 */
function courierOnlyHeaders(h: Headers): void {
  h.set("X-Frame-Options", "DENY")
  h.set("X-Robots-Tag", "noindex, nofollow")
}

function refuse(path: string, surface: "courier" | "pioneer"): NextResponse {
  const res = path.startsWith("/api/")
    ? NextResponse.json({ error: "not_found" }, { status: 404 })
    : new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  if (surface === "courier") courierOnlyHeaders(res.headers)
  return res
}

export const config = {
  // Everything except Next's own static output and the icons, which are
  // served straight from the CDN and gain nothing from a middleware hop.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.txt$|.*\\.html$).*)",
  ],
}
