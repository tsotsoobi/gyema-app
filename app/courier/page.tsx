import type { Metadata } from "next"
import { CourierPanel } from "./courier-panel"

// The courier host's front page (lib/courier-host.ts). middleware.ts rewrites
// "/" on the courier host to this page, and refuses this page on every other
// host.
//
// A neutral shell (Phase 1 item 5, 5.2). The server render is the same for
// everyone and reads no cookie: the session cookie is SameSite=Strict and is
// not sent on the tap from WhatsApp that opens this page. CourierPanel asks
// GET /api/courier/me after load and shows the sign-in form, or the status
// card and the courier's jobs. Copy approved 11 Oct 2026 (8.17).
//
// This page, and anything it ever imports, must not import lib/pi-network or
// load the Pi SDK: there is no Pi account on this surface, and the courier
// CSP admits no Pi origin. tests/courier-host.test.ts checks the imports.

export const metadata: Metadata = {
  title: "Gyema couriers",
  // Its own description, so the courier page does not inherit the root one,
  // which tells a courier with no Pi account about Pi Network (8.4, 8.17 D7).
  description: "Sign in to see and take Gyema delivery jobs.",
  robots: { index: false, follow: false },
}

export default function CourierHome() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold">Gyema couriers</h1>
      <CourierPanel />
    </main>
  )
}
