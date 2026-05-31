// Server-side Pi Platform API client.
//
// Runs ONLY in Next.js API routes (route.ts files under app/api/).
// Never imported into client components or browser-running code.
//
// The PI_API_KEY environment variable is the server-side credential
// that authenticates Gyema as an app to Pi Platform. It must be set
// in Vercel's environment variables (Project Settings → Environment
// Variables → PI_API_KEY) and NEVER committed to the repo.
//
// Pi Platform docs: https://github.com/pi-apps/pi-platform-docs

const PI_PLATFORM_BASE_URL = "https://api.minepi.com"

// Shape of the user object returned by Pi Platform's /v2/me endpoint.
// Fields are documented at:
// https://github.com/pi-apps/pi-platform-docs/blob/master/platform_API.md
export type PiPlatformUser = {
  uid: string
  username: string
  credentials?: { scopes?: string[]; valid_until?: { timestamp: number; iso8601: string } }
  // Note: Pi Platform's /me does not currently return KYC status or
  // mainnet migration status as separate fields. KYC enforcement is
  // handled by Pi Browser refusing to authenticate non-KYC'd accounts.
  // We treat a successful /v2/me response as proof of Pi-KYC verification.
}

/**
 * Verify a Pi access token by calling Pi Platform's /v2/me endpoint.
 *
 * The access token comes from Pi.authenticate() in the browser. Sending
 * it server-to-server with our own PI_API_KEY in the Authorization
 * header asks Pi Platform to confirm the token is valid and return the
 * user it belongs to.
 *
 * Returns the Pi user object on success, or null on any failure
 * (invalid token, network error, missing API key, etc.).
 *
 * Failure modes are NOT differentiated here on purpose — the caller
 * (the /api/auth/verify route) decides what error to surface to the
 * client. This function's only job is "valid Pi user, yes or no?"
 */
export async function verifyPiAccessToken(
  accessToken: string
): Promise<PiPlatformUser | null> {
  const apiKey = process.env.PI_API_KEY

  if (!apiKey) {
    console.error("[pi-platform] PI_API_KEY is not configured in environment")
    return null
  }

  if (!accessToken || typeof accessToken !== "string") {
    console.warn("[pi-platform] Invalid access token format")
    return null
  }

  try {
    const response = await fetch(`${PI_PLATFORM_BASE_URL}/v2/me`, {
      method: "GET",
      headers: {
        // The access token comes from the Pioneer (via Pi SDK).
        // Pi Platform validates this token against its own records.
        Authorization: `Bearer ${accessToken}`,
      },
      // Don't cache — every verification is fresh.
      cache: "no-store",
    })

    if (!response.ok) {
      console.warn(
        `[pi-platform] /v2/me returned ${response.status}: ${response.statusText}`
      )
      return null
    }

    const user = (await response.json()) as PiPlatformUser
    console.log("[pi-platform] /v2/me granted scopes:", JSON.stringify((user as any).credentials?.scopes ?? "none"))

    // Defensive: confirm we got the fields we need.
    if (!user.uid || !user.username) {
      console.error("[pi-platform] /v2/me response missing uid or username")
      return null
    }

    return user
  } catch (error) {
    console.error("[pi-platform] Verification request failed:", error)
    return null
  }
}




