import type React from "react"
import type { Metadata, Viewport } from "next"
import Script from "next/script"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"

export const metadata: Metadata = {
  title: "Gyema — P2P Delivery on Pi",
  description:
    "Gyema connects routine travellers with senders needing packages delivered. Decentralized P2P delivery powered by Pi Network.",
  generator: "v0.app",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#7B2CBF",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
      </head>
      <body>
        {/*
          Pi Network SDK — must load BEFORE any code that calls window.Pi.
          strategy="beforeInteractive" guarantees the SDK script runs before
          React hydrates, which is exactly what was missing in PiLApp and why
          its "Sign in with Pi" button did nothing (window.Pi was undefined).

          sandbox flag is set dynamically based on hostname. Production URL
          (gyema-app.vercel.app) uses sandbox: false to avoid the May 6 2026
          bug where iframe-context event handlers broke text input focus.
          Preview deployments and sandbox-authorized URLs use sandbox: true
          so Pi.authenticate() works in Pi Browser's sandbox flow — without
          this, Pi.authenticate() hangs silently with no consent prompt.
        */}
        <Script
          src="https://sdk.minepi.com/pi-sdk.js"
          strategy="beforeInteractive"
        />
        <Script id="pi-init" strategy="beforeInteractive">
          {`
            try {
              if (typeof Pi !== 'undefined') {
                var isProduction = typeof window !== 'undefined' &&
                  window.location.hostname === 'gyema-app.vercel.app';
                Pi.init({ version: "2.0", sandbox: !isProduction });
              }
            } catch (e) {
              console.warn("Pi SDK init skipped:", e);
            }
          `}
        </Script>
        {children}
      </body>
    </html>
  )
}
