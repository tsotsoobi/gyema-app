"use client"

import { useCallback, useEffect, useRef } from "react"

// The Cloudflare Turnstile widget, rendered explicitly.
//
// WHY EXPLICIT RENDERING RATHER THAN THE AUTOMATIC MODE
//
// Turnstile's automatic mode scans the document for a div with a magic class
// and renders into whatever it finds. That works on a static page. This form
// is a React tree with three steps, the widget lives on the second, and it
// mounts and unmounts as the sender moves between them. Automatic mode has no
// way to be told that the element it rendered into is gone, so it leaves an
// orphaned widget and the next mount gets nothing. Explicit mode hands back a
// widget id that this component removes on unmount.
//
// WHY A RESET SIGNAL
//
// A Turnstile token is single use and short lived. Cloudflare refuses a
// replay, which is the property that stops a captured token being reused for a
// flood, and it means a failed submit cannot simply be retried with the token
// already in hand: the second attempt would be refused for a reason that has
// nothing to do with the sender. The parent bumps resetKey after any failure
// and this asks Cloudflare for a fresh challenge.
//
// RENDERS NOTHING WITHOUT A SITE KEY
//
// Same rule as everywhere else in this feature: no key, no widget, no script
// tag, no network request to Cloudflare at all. A deployment that has not been
// given the keys behaves as though this file does not exist.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const SCRIPT_ID = "cf-turnstile-script"

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      "expired-callback"?: () => void
      "error-callback"?: () => void
      theme?: "light" | "dark" | "auto"
      appearance?: "always" | "execute" | "interaction-only"
    }
  ) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/**
 * Load the Turnstile script once per document.
 *
 * Resolves immediately if it is already there, which happens when the sender
 * steps back to the form and forward to the quote again. A second script tag
 * would re-register the global and orphan the first one's widgets.
 */
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.turnstile) return Promise.resolve()

  const existing = document.getElementById(SCRIPT_ID)
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve())
      existing.addEventListener("error", () => reject(new Error("turnstile script failed")))
    })
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.id = SCRIPT_ID
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("turnstile script failed"))
    document.head.appendChild(script)
  })
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onUnavailable,
  resetKey = 0,
}: {
  /** NEXT_PUBLIC_TURNSTILE_SITE_KEY. Empty string means render nothing. */
  siteKey: string
  /** Called with a token when the challenge is solved, and null when it is not. */
  onToken: (token: string | null) => void
  /**
   * Called when the challenge cannot run at all, as opposed to not having been
   * solved yet. An ad blocker, a captive portal, or Cloudflare being
   * unreachable all land here.
   *
   * Reported separately because the two states look identical from the outside
   * and need opposite treatment. "Not solved yet" resolves itself in a second
   * and the right thing to do is wait. "Cannot run" never resolves, and a
   * parent that treats it as waiting leaves a disabled button and a sender
   * with no idea why they cannot post.
   */
  onUnavailable?: () => void
  /** Any change to this value asks Cloudflare for a fresh challenge. */
  resetKey?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  // Held in a ref so the render effect below does not depend on the identity
  // of the callback. The parent recreates it on every render, and a dependency
  // on it would tear the widget down and rebuild it on every keystroke in the
  // form.
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  const emit = useCallback((token: string | null) => {
    onTokenRef.current(token)
  }, [])

  const emitUnavailable = useCallback(() => {
    onUnavailableRef.current?.()
  }, [])

  useEffect(() => {
    if (!siteKey) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile) return
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          callback: (token: string) => emit(token),
          // An expired token is worth nothing to the route, so the parent is
          // told to drop it rather than being left holding a value that will
          // be refused at submit time.
          "expired-callback": () => emit(null),
          "error-callback": () => emit(null),
          theme: "light",
        })
      })
      .catch(() => {
        // The script did not load: an ad blocker, a captive portal, or
        // Cloudflare being unreachable. Report it as unavailable rather than
        // as an unsolved challenge, so the parent can say something true
        // instead of waiting forever. Throwing here would take the form down
        // over a control that is meant to be additive.
        console.warn("[gyema] Turnstile script did not load")
        emit(null)
        emitUnavailable()
      })

    return () => {
      cancelled = true
      const id = widgetIdRef.current
      if (id && window.turnstile) {
        try {
          window.turnstile.remove(id)
        } catch {
          // Already gone. Nothing to clean up and nothing worth reporting.
        }
      }
      widgetIdRef.current = null
    }
  }, [siteKey, emit, emitUnavailable])

  useEffect(() => {
    // Skip the initial render: resetKey starts at zero and the widget has just
    // been created, so resetting it here would discard a fresh challenge.
    if (resetKey === 0) return
    const id = widgetIdRef.current
    if (id && window.turnstile) {
      emit(null)
      window.turnstile.reset(id)
    }
  }, [resetKey, emit])

  if (!siteKey) return null

  return <div ref={containerRef} className="flex justify-center" />
}
