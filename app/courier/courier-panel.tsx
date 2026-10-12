"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CourierJobs } from "./courier-jobs"
import {
  OPERATOR_CHECK_ENDED_LINE,
  PIVERIFY_NOT_OPEN_LINE,
  bufferWindowLapsed,
  operatorCheckLines,
  showPiverifyNotOpen,
  type EffectiveTier,
} from "./courier-view"

// The courier page's interactive part: sign-in with the code the founder
// sent, then the status card (Phase 1 item 5, 5.2), with the verification
// button and the waiting state (5.4).
//
// It learns who is signed in from GET /api/courier/me after load, never from
// the server render: the session cookie is SameSite=Strict, so it is absent
// on the cross-site tap from WhatsApp that opens this page, and present on
// this same-site fetch.
//
// VERIFICATION. The button shows only when /api/courier/me says canStartKyc,
// which is the same decision POST /api/courier/kyc/start makes. A tap posts
// to kyc/start and navigates top-level to the hosted_flow_url it returns,
// https only. While the session is unsettled the page polls
// POST /api/courier/kyc/refresh once on load, and every 60 seconds while the
// waiting screen (pending_review) is open, then reads /api/courier/me again.
// A refused or failed poll is skipped silently: the next one tries again.
//
// JOBS (item 6). Below the status card, CourierJobs (./courier-jobs.tsx)
// lists the courier's own jobs with the delivery code entry, and the open
// job board while /api/courier/me's effectiveTier is buffer or full. The
// tier decides, never the stored status (./courier-view.ts).
//
// PIVERIFY OFF (item 10, decision 10). While /api/courier/me says
// piverifyEnabled is false, the button is hidden, the not-open line is shown in
// its place, and nothing polls kyc/refresh. The OPERATOR CHECK lines
// come from ./courier-view.ts. None of them says the
// courier is verified: the operator check is not identity verification.
//
// Copy approved 11 Oct 2026 (8.17): every visible string here. The item 10
// strings in ./courier-view.ts: Copy approved 12 Oct 2026 (item 10).
//
// Like everything under app/courier, this file must not import lib/pi-network
// or load the Pi SDK (tests/courier-host.test.ts).

type Courier = {
  reference: string
  status: string
  piverifyStatus: string | null
  piverifyAllowedAction: string | null
  canStartKyc: boolean
  effectiveTier: EffectiveTier
  operatorChecked: boolean
  operatorCheckDeadline: string | null
  piverifyEnabled: boolean
}

type View =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; courier: Courier }
  | { kind: "unavailable" }

const STATUS_LABELS: Record<string, string> = {
  registered: "Signed up",
  buffer: "Starter (limited jobs)",
  full: "Verified courier",
  paused: "Paused",
}

const VERIFICATION_LABELS: Record<string, string> = {
  created: "Started, not submitted",
  started: "In progress",
  pending_review: "Waiting for the result",
  approved: "Approved",
  rejected: "Not approved",
  failed: "Could not be completed",
}

const SIGNIN_ERRORS: Record<string, string> = {
  invalid_code: "That code did not work. Check it and try again, or ask for a new one.",
  no_match: "That code did not work. Check it and try again, or ask for a new one.",
  expired: "That code has expired. Ask for a new one.",
  unavailable: "This courier account cannot sign in.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
  limiter_unavailable: "Too many attempts. Try again in a few minutes.",
}

const FALLBACK_ERROR = "Something went wrong. Try again in a few minutes."

const KYC_ERRORS: Record<string, string> = {
  verification_unavailable: "We could not start verification just now. Try again in a few minutes.",
  paused: "Verification is paused for this account. Contact Gyema.",
  unavailable: "This courier account cannot start verification.",
  rate_limited: "Too many attempts today. Try again tomorrow.",
  limiter_unavailable: "We could not start verification just now. Try again in a few minutes.",
  piverify_not_enabled: PIVERIFY_NOT_OPEN_LINE,
}

const POLL_INTERVAL_MS = 60_000

/**
 * A session still moving: the poll may learn something, and the button
 * carries on in it rather than starting a new one.
 */
function isUnsettled(c: Courier): boolean {
  if (c.piverifyStatus === "created" || c.piverifyStatus === "started" || c.piverifyStatus === "pending_review") {
    return true
  }
  return c.piverifyStatus === "rejected" && c.piverifyAllowedAction !== null
}

async function postJson(path: string, body: unknown): Promise<{ status: number; reason: string | null }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  })
  const json = (await res.json().catch(() => null)) as { reason?: unknown } | null
  return { status: res.status, reason: typeof json?.reason === "string" ? json.reason : null }
}

export function CourierPanel() {
  const [view, setView] = useState<View>({ kind: "loading" })
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const polledOnLoad = useRef(false)
  const signedOut = useCallback(() => setView({ kind: "signed_out" }), [])

  // quiet: a background read after a poll. A failure keeps what is on the
  // screen rather than replacing it with an error.
  const load = useCallback(async (quiet = false) => {
    try {
      const res = await fetch("/api/courier/me", { credentials: "same-origin", cache: "no-store" })
      if (res.status === 401) return setView({ kind: "signed_out" })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; courier?: Courier } | null
      if (res.ok && json?.ok && json.courier) return setView({ kind: "signed_in", courier: json.courier })
      if (!quiet) setView({ kind: "unavailable" })
    } catch {
      if (!quiet) setView({ kind: "unavailable" })
    }
  }, [])

  const pollThenLoad = useCallback(async () => {
    try {
      await postJson("/api/courier/kyc/refresh", {})
    } catch {
      // Skipped; the next poll tries again.
    }
    await load(true)
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  // Once on load, while the result is unsettled. Never while PiVerify is off.
  const unsettled = view.kind === "signed_in" && view.courier.piverifyEnabled && isUnsettled(view.courier)
  useEffect(() => {
    if (!unsettled || polledOnLoad.current) return
    polledOnLoad.current = true
    void pollThenLoad()
  }, [unsettled, pollThenLoad])

  // Every 60 seconds while the waiting screen is open. Never while PiVerify is off.
  const waiting =
    view.kind === "signed_in" && view.courier.piverifyEnabled && view.courier.piverifyStatus === "pending_review"
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void pollThenLoad(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [waiting, pollThenLoad])

  async function startVerification() {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/courier/kyc/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      })
      const json = (await res.json().catch(() => null)) as { reason?: unknown; hostedFlowUrl?: unknown } | null
      const url = typeof json?.hostedFlowUrl === "string" ? json.hostedFlowUrl : null
      if (res.ok && url && url.startsWith("https://")) {
        window.location.assign(url)
        return
      }
      if (res.status === 401) return setView({ kind: "signed_out" })
      if (res.status === 409) {
        await load(true)
        return
      }
      const reason = typeof json?.reason === "string" ? json.reason : null
      setMessage((reason && KYC_ERRORS[reason]) ?? FALLBACK_ERROR)
    } catch {
      setMessage(FALLBACK_ERROR)
    } finally {
      setBusy(false)
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const { status, reason } = await postJson("/api/courier/sign-in", { code })
      if (status === 200) {
        setCode("")
        await load()
      } else {
        setMessage((reason && SIGNIN_ERRORS[reason]) ?? FALLBACK_ERROR)
      }
    } catch {
      setMessage(FALLBACK_ERROR)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const { status } = await postJson("/api/courier/sign-out", {})
      if (status === 200) setView({ kind: "signed_out" })
      else setMessage(FALLBACK_ERROR)
    } catch {
      setMessage(FALLBACK_ERROR)
    } finally {
      setBusy(false)
    }
  }

  if (view.kind === "loading") {
    return <p className="mt-6 text-sm text-muted-foreground">Loading...</p>
  }

  if (view.kind === "unavailable") {
    return (
      <div className="mt-6">
        <p className="text-sm text-muted-foreground">We could not check your sign-in just now.</p>
        <button
          type="button"
          onClick={() => {
            setView({ kind: "loading" })
            void load()
          }}
          className="mt-4 rounded-md border px-4 py-2 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    )
  }

  if (view.kind === "signed_out") {
    return (
      <form onSubmit={signIn} className="mt-6 flex flex-col gap-3">
        <label htmlFor="courier-code" className="text-sm font-medium">
          Enter the sign-in code Gyema sent you
        </label>
        <input
          id="courier-code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          placeholder="XXXXX-XXXXX"
          className="rounded-md border px-3 py-2 font-mono text-lg tracking-widest uppercase"
          required
        />
        <button
          type="submit"
          disabled={busy || code.trim() === ""}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>
        {message && (
          <p role="alert" className="text-sm text-red-600">
            {message}
          </p>
        )}
      </form>
    )
  }

  const { courier } = view
  const verification = courier.piverifyStatus
    ? (VERIFICATION_LABELS[courier.piverifyStatus] ?? courier.piverifyStatus)
    : "Not started"

  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-base">
        Your courier reference: <span className="font-mono font-semibold">{courier.reference}</span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Account</dt>
        <dd>{STATUS_LABELS[courier.status] ?? courier.status}</dd>
        <dt className="text-muted-foreground">Verification</dt>
        <dd>{verification}</dd>
      </dl>
      {waiting && (
        <p role="status" className="text-sm text-muted-foreground">
          Your verification has been submitted. We are waiting for the result. This page checks again every minute.
        </p>
      )}
      {operatorCheckLines(courier).map((line) => (
        <p key={line} className="text-sm text-muted-foreground">
          {line}
        </p>
      ))}
      {showPiverifyNotOpen(courier) && (
        <p role="status" className="text-sm text-muted-foreground">
          {PIVERIFY_NOT_OPEN_LINE}
        </p>
      )}
      {courier.piverifyEnabled && courier.canStartKyc && !waiting && (
        <button
          type="button"
          onClick={startVerification}
          disabled={busy}
          className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? "Opening..." : isUnsettled(courier) ? "Continue verification" : "Start verification"}
        </button>
      )}
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="self-start rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        Sign out
      </button>
      {message && (
        <p role="alert" className="text-sm text-red-600">
          {message}
        </p>
      )}
      {bufferWindowLapsed(courier.status, courier.effectiveTier) && (
        <p role="status" className="text-sm text-muted-foreground">
          {courier.operatorChecked
            ? OPERATOR_CHECK_ENDED_LINE
            : "Your verification has taken longer than 30 days. Jobs are paused until it completes."}
        </p>
      )}
      <CourierJobs effectiveTier={courier.effectiveTier} onSignedOut={signedOut} />
    </div>
  )
}
