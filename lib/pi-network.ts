// Gyema's Pi Network integration.
//
// Key difference from PiLApp's lib/pi-network.ts:
// - PiLApp silently substituted MOCK auth when window.Pi was undefined,
//   which made it look like sign-in worked but actually used fake users.
// - Gyema fails LOUDLY if window.Pi is missing, so you can tell when the
//   SDK didn't load (e.g. running outside Pi Browser, or the script tag
//   in app/layout.tsx didn't fire).
//
// Pi SDK reference: https://github.com/pi-apps/pi-platform-docs

export type PiUser = {
  uid: string
  username: string
  accessToken: string
}

export type UserRole = "traveller" | "sender"

declare global {
  interface Window {
    Pi?: {
      init: (config: { version: string; sandbox?: boolean }) => void
      authenticate: (
        scopes: string[],
        onIncompletePaymentFound: (payment: PiPayment) => void
      ) => Promise<{ accessToken: string; user: { uid: string; username: string } }>
      createPayment: (
        paymentData: {
          amount: number
          memo: string
          metadata: Record<string, unknown>
        },
        callbacks: {
          onReadyForServerApproval: (paymentId: string) => void
          onReadyForServerCompletion: (paymentId: string, txid: string) => void
          onCancel: (paymentId: string) => void
          onError: (error: Error, payment?: PiPayment) => void
        }
      ) => Promise<PiPayment>
    }
  }
}

export type PiPayment = {
  identifier: string
  amount: number
  memo: string
  metadata: Record<string, unknown>
}

/**
 * True only when the official Pi SDK script has loaded and Pi Browser
 * has injected the Pi global. Use this to gate sign-in UI.
 */
export const isPiSdkAvailable = (): boolean => {
  return typeof window !== "undefined" && typeof window.Pi !== "undefined"
}

/**
 * Authenticate the current Pioneer with Pi Network.
 * Throws an explicit error if the SDK is not available — no silent mock fallback.
 */
export const authenticateWithPi = async (): Promise<PiUser> => {
  if (!isPiSdkAvailable()) {
    throw new Error(
      "Pi SDK not available. Open Gyema inside Pi Browser to sign in."
    )
  }

  const Pi = window.Pi!
  const scopes = ["username", "payments"]

  const onIncompletePaymentFound = (payment: PiPayment) => {
    // When real escrow is built (v2), this callback notifies the backend
    // that an unfinished payment exists so it can be resolved.
    console.log("[gyema] Incomplete payment found:", payment)
  }

  try {
    const auth = await Pi.authenticate(scopes, onIncompletePaymentFound)
    return {
      uid: auth.user.uid,
      username: auth.user.username,
      accessToken: auth.accessToken,
    }
  } catch (error) {
    console.error("[gyema] Pi authentication failed:", error)
    throw new Error("Sign-in cancelled or failed. Please try again.")
  }
}

/**
 * Create a tiny test payment (0.001 testnet π) to satisfy Pi Develop's
 * "Process a Transaction" checklist item.
 *
 * The payment lifecycle requires server-side approval and completion via
 * /api/payments/approve and /api/payments/complete. Without these, Pi
 * times out the payment with "developer failed to approve" error.
 */
export const createTestPayment = async (): Promise<string> => {
  if (!isPiSdkAvailable()) {
    throw new Error(
      "Pi SDK not available. Open Gyema inside Pi Browser to test."
    )
  }

  const Pi = window.Pi!

  return new Promise<string>((resolve, reject) => {
    Pi.createPayment(
      {
        amount: 0.001,
        memo: "Gyema test transaction",
        metadata: { type: "checklist_test", app: "gyema" },
      },
      {
        onReadyForServerApproval: async (paymentId: string) => {
          console.log("[gyema] Payment ready for server approval:", paymentId)
          try {
            const res = await fetch("/api/payments/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paymentId }),
            })
            if (!res.ok) {
              const errText = await res.text()
              console.error("[gyema] Approve endpoint failed:", errText)
              reject(new Error("Server approval failed"))
            }
          } catch (err) {
            console.error("[gyema] Approve fetch error:", err)
            reject(err instanceof Error ? err : new Error("Approve fetch failed"))
          }
        },
        onReadyForServerCompletion: async (paymentId: string, txid: string) => {
          console.log("[gyema] Payment completed by SDK:", paymentId, txid)
          try {
            const res = await fetch("/api/payments/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paymentId, txid }),
            })
            if (!res.ok) {
              const errText = await res.text()
              console.error("[gyema] Complete endpoint failed:", errText)
              reject(new Error("Server completion failed"))
              return
            }
            // Resolve only after server confirms completion.
            resolve(paymentId)
          } catch (err) {
            console.error("[gyema] Complete fetch error:", err)
            reject(err instanceof Error ? err : new Error("Complete fetch failed"))
          }
        },
        onCancel: (paymentId: string) => {
          console.log("[gyema] Payment cancelled:", paymentId)
          reject(new Error("Payment cancelled."))
        },
        onError: (error: Error, payment?: PiPayment) => {
          console.error("[gyema] Payment error:", error, payment)
          reject(error)
        },
      }
    ).catch(reject)
  })
}

// Local-storage helpers for role persistence between sessions.
// (Listings themselves are also persisted locally for v1 — see lib/listings.ts.)

const ROLE_KEY = "gyema-role"
const USER_KEY = "gyema-user"

export const getStoredRole = (): UserRole | null => {
  if (typeof window === "undefined") return null
  const v = localStorage.getItem(ROLE_KEY)
  return v === "traveller" || v === "sender" ? v : null
}

export const setStoredRole = (role: UserRole) => {
  if (typeof window !== "undefined") {
    localStorage.setItem(ROLE_KEY, role)
  }
}

export const getStoredUser = (): PiUser | null => {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as PiUser) : null
  } catch {
    return null
  }
}

export const setStoredUser = (user: PiUser | null) => {
  if (typeof window === "undefined") return
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } else {
    localStorage.removeItem(USER_KEY)
  }
}

export const clearStoredAuth = () => {
  if (typeof window !== "undefined") {
    localStorage.removeItem(ROLE_KEY)
    localStorage.removeItem(USER_KEY)
  }
}
