import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_piverify_webhook.sql, read as text.
//
// The function's behaviour (forward only, once per event, once per approval,
// operator pause kept) was run against a throwaway postgres 17 when it was
// written. These tests hold the statements that keep it service_role only,
// and the shape the route depends on, so a later edit cannot quietly drop
// one. Same approach as tests/courier-registry-migration.test.ts.

const sql = readFileSync("db/migrations/2026-10-08_piverify_webhook.sql", "utf8")

const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

const SIGNATURE = "public.courier_apply_kyc_status(text, text, text, text, text)"

describe("piverify webhook migration", () => {
  it("marks the write path for founder review", () => {
    expect(sql).toContain("ATTESTATION WRITE: founder review required.")
  })

  it("makes the function security definer with search_path pinned", () => {
    expect(statements).toContain("create or replace function public.courier_apply_kyc_status(")
    expect(statements).toMatch(/security definer\s+set search_path = public, pg_temp/)
  })

  it("revokes EXECUTE from public, anon and authenticated, and grants it to service_role alone", () => {
    expect(statements).toContain(`revoke all on function ${SIGNATURE}\n  from public, anon, authenticated;`)
    expect(statements).toContain(`grant execute on function ${SIGNATURE}\n  to service_role;`)
    const executeGrants = statements.match(/grant execute on function/g) ?? []
    expect(executeGrants).toHaveLength(1)
  })

  it("gives service_role SELECT on piverify_events and nothing to write with", () => {
    expect(statements).toContain("alter table public.piverify_events enable row level security;")
    expect(statements).toContain("revoke all on table public.piverify_events from public, anon, authenticated;")
    expect(statements).toContain("grant select on table public.piverify_events to service_role;")
    expect(statements).not.toMatch(/grant [^;]*(insert|update|delete)[^;]*piverify_events/i)
    expect(statements).not.toMatch(/create policy/i)
  })

  it("backs approval-once with a unique index", () => {
    expect(statements).toMatch(
      /create unique index if not exists piverify_events_one_approval_per_courier\s+on public\.piverify_events \(courier_id\)\s+where outcome = 'applied' and piverify_status = 'approved';/
    )
  })

  it("returns the outcomes the route branches on", () => {
    for (const outcome of [
      "duplicate", "session_not_bound", "applied", "not_forward",
      "unknown_courier", "stale_session", "external_user_mismatch", "shredded",
    ]) {
      expect(statements).toContain(`'${outcome}'`)
    }
  })

  it("never binds a session: only reads piverify_session_id", () => {
    expect(statements).not.toMatch(/set\s+piverify_session_id/i)
    expect(statements).not.toMatch(/piverify_session_id\s*=\s*p_session_id\s*,/)
  })

  it("never lifts an operator pause", () => {
    expect(statements).toContain("if coalesce(v_courier.paused_reason, '') <> 'operator' then")
  })

  it("ends with the read-only verification as its last statement", () => {
    expect(statements.trimEnd().endsWith(") as piverify_webhook_verification;")).toBe(true)
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})
