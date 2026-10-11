"use client"

import { useCallback, useEffect, useState } from "react"
import { STAMP_COURIER_CODE, hasStamp } from "@/lib/delivery-stamps"
import { canTakeJobs, visibleBoard, type EffectiveTier } from "./courier-view"
import { guestStatusChip } from "@/lib/status-labels"

// The signed-in courier's jobs (Phase 1 item 6, 6.8): the open job board with
// an accept button, the courier's own jobs, and the delivery code entry.
//
//   board   GET /api/guest/open, the public board, the one guest API the
//           courier host serves. Shown only while /api/courier/me's
//           effectiveTier is buffer or full, and for buffer only the jobs
//           with both areas on the bounded list (./courier-view.ts). Accept
//           still decides every claim.
//   accept  POST /api/courier/jobs/accept { trackingId }
//   mine    POST /api/courier/jobs/mine {}
//   code    POST /api/courier/jobs/confirm-delivery { trackingId, code }
//
// Every courier route reads the courier from the session cookie. Nothing here
// sends a courier id, a tier or a WhatsApp number.
//
// Money lines are formatted here and never computed: every figure arrives in
// an API response, worked out on the server by lib/guest-commission.ts.
//
// Copy approved 11 Oct 2026 (8.17): every visible string here.
//
// Like everything under app/courier, this file must not import lib/pi-network
// or load the Pi SDK (tests/courier-host.test.ts). lib/guest-jobs.ts imports
// the Pi client, so its helpers are not used here.

type OpenJob = {
  trackingId: string
  pickupArea: string
  dropoffArea: string
  packageSize: string
  whenPref: string | null
  scheduledDate: string | null
  keepsCedis: number | null
  quoteCedis: number | null
}

type MyJob = {
  trackingId: string
  pickupArea: string
  pickupLandmark: string | null
  dropoffArea: string
  dropoffLandmark: string | null
  packageSize: string
  recipientName: string | null
  recipientPhone: string | null
  quoteCedis: number | null
  remitCedis: number | null
  keepsCedis: number | null
  paymentType: string | null
  status: string
  deliveryConfirmedBy: string | null
  hasDeliveryCode: boolean
}

// COPY: later (8.17). not_open, courier_not_active and courier_not_registered
// differ in wording from the Pioneer sheet's lines for the same reasons
// (lib/guest-accept-message.ts).
const ACCEPT_ERRORS: Record<string, string> = {
  not_open: "Someone else took this job, or it is no longer open.",
  not_eligible: "Your account cannot take this job yet.",
  courier_not_active: "Your account cannot take jobs yet.",
  courier_not_registered: "This courier account cannot take jobs. Contact Gyema.",
  unavailable: "This courier account cannot take jobs. Contact Gyema.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
  limiter_unavailable: "We could not take that job just now. Try again in a few minutes.",
}

const CODE_ERRORS: Record<string, string> = {
  invalid_code: "Enter the 4 digits the recipient gave you.",
  code_locked: "Too many wrong codes for this delivery. Contact Gyema.",
  not_confirmable: "This delivery cannot be confirmed now.",
  state_changed: "This delivery cannot be confirmed now.",
  not_assigned: "This delivery is not assigned to you.",
  no_code: "This delivery has no code to enter.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
}

const FALLBACK_ERROR = "Something went wrong. Try again in a few minutes."

function cedis(value: number | null): string {
  return value === null ? "?" : `${value.toFixed(2)} GHS`
}

function payment(paymentType: string | null): string {
  if (paymentType === "momo") return " (MoMo)"
  if (paymentType === "cash") return " (cash)"
  return ""
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json }
}

function reasonOf(json: Record<string, unknown> | null): string | null {
  return typeof json?.reason === "string" ? json.reason : null
}

export function CourierJobs({
  effectiveTier,
  onSignedOut,
}: {
  effectiveTier: EffectiveTier
  onSignedOut: () => void
}) {
  const offerJobs = canTakeJobs(effectiveTier)
  const [board, setBoard] = useState<OpenJob[] | null>(null)
  const [mine, setMine] = useState<MyJob[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [codeMessages, setCodeMessages] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const own = await post("/api/courier/jobs/mine", {})
      if (own.status === 401) return onSignedOut()
      if (own.status !== 200 || !Array.isArray(own.json?.jobs)) {
        setFailed(true)
        return
      }
      setMine(own.json.jobs as MyJob[])
      if (offerJobs) {
        const res = await fetch("/api/guest/open", { credentials: "same-origin", cache: "no-store" })
        const json = (await res.json().catch(() => null)) as { jobs?: unknown } | null
        if (!res.ok || !Array.isArray(json?.jobs)) {
          setFailed(true)
          return
        }
        setBoard(json.jobs as OpenJob[])
      }
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [offerJobs, onSignedOut])

  useEffect(() => {
    void load()
  }, [load])

  async function accept(trackingId: string) {
    if (busy) return
    setBusy(trackingId)
    setMessage(null)
    try {
      const { status, json } = await post("/api/courier/jobs/accept", { trackingId })
      if (status === 401) return onSignedOut()
      if (status === 200 && json?.ok === true) {
        setMessage(`You took ${trackingId}. It is in your jobs below.`)
      } else {
        const reason = reasonOf(json)
        setMessage((reason && ACCEPT_ERRORS[reason]) ?? FALLBACK_ERROR)
      }
      await load()
    } catch {
      setMessage(FALLBACK_ERROR)
    } finally {
      setBusy(null)
    }
  }

  async function confirm(trackingId: string) {
    if (busy) return
    setBusy(trackingId)
    setCodeMessages((m) => ({ ...m, [trackingId]: "" }))
    try {
      const { status, json } = await post("/api/courier/jobs/confirm-delivery", {
        trackingId,
        code: (codes[trackingId] ?? "").trim(),
      })
      if (status === 401) return onSignedOut()
      let text: string
      if (status === 200 && json?.ok === true) {
        text =
          json.delivered === true
            ? "Code accepted. The delivery is complete."
            : "Code accepted. Waiting for the sender to confirm."
        setCodes((c) => ({ ...c, [trackingId]: "" }))
        await load()
      } else {
        const reason = reasonOf(json)
        if (reason === "wrong_code" && typeof json?.attemptsLeft === "number") {
          text = `That code did not match. ${json.attemptsLeft} ${json.attemptsLeft === 1 ? "try" : "tries"} left.`
        } else {
          text = (reason && CODE_ERRORS[reason]) ?? FALLBACK_ERROR
        }
      }
      setCodeMessages((m) => ({ ...m, [trackingId]: text }))
    } catch {
      setCodeMessages((m) => ({ ...m, [trackingId]: FALLBACK_ERROR }))
    } finally {
      setBusy(null)
    }
  }

  const shownBoard = board === null ? null : visibleBoard(board, effectiveTier)

  if (failed && mine === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">We could not load your jobs just now.</p>
        <button type="button" onClick={() => void load()} className="self-start rounded-md border px-4 py-2 text-sm font-medium">
          Try again
        </button>
      </div>
    )
  }

  if (mine === null) {
    return <p className="text-sm text-muted-foreground">Loading jobs...</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your jobs</h2>
        {mine.length === 0 && <p className="text-sm text-muted-foreground">You have no jobs yet.</p>}
        {mine.map((job) => {
          const codeDone = hasStamp(job.deliveryConfirmedBy, STAMP_COURIER_CODE)
          const askCode = job.status === "in_transit" && job.hasDeliveryCode && !codeDone
          return (
            <article key={job.trackingId} className="rounded-md border p-3 text-sm">
              <p className="font-mono font-semibold">{job.trackingId}</p>
              {/* Plain text, the label only (8.3), from the shared map. */}
              <p>{guestStatusChip(job.status).label}</p>
              <p className="mt-2">
                <span className="text-muted-foreground">From:</span> {job.pickupArea}
                {job.pickupLandmark ? `, ${job.pickupLandmark}` : ""}
              </p>
              <p>
                <span className="text-muted-foreground">To:</span> {job.dropoffArea}
                {job.dropoffLandmark ? `, ${job.dropoffLandmark}` : ""}
              </p>
              <p>
                <span className="text-muted-foreground">Package:</span> {job.packageSize}
              </p>
              {job.recipientName && (
                <p>
                  <span className="text-muted-foreground">Recipient:</span> {job.recipientName}
                </p>
              )}
              {job.recipientPhone && (
                <p>
                  <span className="text-muted-foreground">Recipient phone:</span> {job.recipientPhone}
                </p>
              )}
              <p className="mt-2">
                <span className="text-muted-foreground">Collect at the door:</span> {cedis(job.quoteCedis)}
                {payment(job.paymentType)}
              </p>
              {job.keepsCedis !== null && job.remitCedis !== null && (
                <>
                  <p>
                    <span className="text-muted-foreground">You keep:</span> {cedis(job.keepsCedis)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">You owe Gyema:</span> {cedis(job.remitCedis)}
                  </p>
                </>
              )}
              {codeDone && <p className="mt-2">Delivery code accepted.</p>}
              {askCode && (
                <form
                  className="mt-3 flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void confirm(job.trackingId)
                  }}
                >
                  <label htmlFor={`code-${job.trackingId}`} className="font-medium">
                    Enter the code the recipient gives you
                  </label>
                  <input
                    id={`code-${job.trackingId}`}
                    value={codes[job.trackingId] ?? ""}
                    onChange={(e) => setCodes((c) => ({ ...c, [job.trackingId]: e.target.value }))}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    placeholder="0000"
                    className="w-32 rounded-md border px-3 py-2 font-mono text-lg tracking-widest"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || (codes[job.trackingId] ?? "").trim().length !== 4}
                    className="self-start rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-50"
                  >
                    {busy === job.trackingId ? "Checking..." : "Confirm delivery"}
                  </button>
                  {codeMessages[job.trackingId] && (
                    <p role="status" className="text-sm">
                      {codeMessages[job.trackingId]}
                    </p>
                  )}
                </form>
              )}
            </article>
          )
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Open jobs</h2>
        {!offerJobs && <p className="text-sm text-muted-foreground">You can take jobs once your account is active.</p>}
        {offerJobs && shownBoard !== null && shownBoard.length === 0 && (
          <p className="text-sm text-muted-foreground">No open jobs right now.</p>
        )}
        {offerJobs &&
          shownBoard?.map((job) => (
            <article key={job.trackingId} className="rounded-md border p-3 text-sm">
              <p>
                {job.pickupArea} to {job.dropoffArea}
              </p>
              <p className="text-muted-foreground">
                {job.packageSize}
                {job.whenPref ? `, ${job.whenPref === "date" ? job.scheduledDate : job.whenPref}` : ""}
              </p>
              <p className="mt-1">You keep {cedis(job.keepsCedis)}</p>
              <button
                type="button"
                onClick={() => void accept(job.trackingId)}
                disabled={busy !== null}
                className="mt-2 rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-50"
              >
                {busy === job.trackingId ? "Taking..." : "Take this job"}
              </button>
            </article>
          ))}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy !== null}
          className="self-start rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Refresh
        </button>
      </section>
    </div>
  )
}
