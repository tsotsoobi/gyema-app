// The staging marker for the courier host, in place of the Pioneer staging
// banner there.
//
// The Pioneer banner sends people to the Pioneer app in Pi Browser, which is the
// wrong advice for a courier with no Pi account. This one says only that the
// environment is a test one. Copy approved 11 Oct 2026 (8.17).
//
// Same rule as the Pioneer banner: server component, no interactivity, and it
// appears ONLY when NEXT_PUBLIC_IS_TESTNET is exactly the string "true", so
// the live courier host can never show it by accident.

export function CourierTestBanner() {
  if (process.env.NEXT_PUBLIC_IS_TESTNET !== "true") return null

  return (
    <div
      role="status"
      className="w-full px-4 py-1.5 text-center text-xs font-medium text-white"
      style={{ backgroundColor: "#DC2626" }}
    >
      Test environment. Deliveries here are not real.
    </div>
  )
}
