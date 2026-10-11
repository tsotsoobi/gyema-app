import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_piverify_resubmission.sql, read as text.
//
// Resubmit-then-approve, appeal-then-approve, a final rejection staying final,
// and every rule from 2026-10-08_piverify_webhook.sql were run against a
// throwaway postgres 17 when this was written. These tests hold the
// statements that keep the function service_role only and the old signature
// gone, so a later edit cannot quietly drop one.

const sql = readFileSync("db/migrations/2026-10-08_piverify_resubmission.sql", "utf8")

const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

const OLD = "public.courier_apply_kyc_status(text, text, text, text, text)"
const NEW = "public.courier_apply_kyc_status(text, text, text, text, text, text)"

describe("piverify resubmission migration", () => {
  it("marks the write path for founder review", () => {
    expect(sql).toContain("ATTESTATION WRITE: founder review required.")
  })

  it("drops the five-argument function before creating the six-argument one", () => {
    const drop = statements.indexOf(`drop function if exists ${OLD};`)
    const create = statements.indexOf("create or replace function public.courier_apply_kyc_status(")
    expect(drop).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(drop)
    expect(statements).toMatch(/p_status\s+text,\s+p_allowed_action\s+text\s+\)/)
  })

  it("makes the function security definer with search_path pinned", () => {
    expect(statements).toMatch(/security definer\s+set search_path = public, pg_temp/)
  })

  it("revokes EXECUTE from public, anon and authenticated, and grants it to service_role alone", () => {
    expect(statements).toContain(`revoke all on function ${NEW}\n  from public, anon, authenticated;`)
    expect(statements).toContain(`grant execute on function ${NEW}\n  to service_role;`)
    expect(statements.match(/grant execute on function/g) ?? []).toHaveLength(1)
    expect(statements).not.toMatch(/grant [^;]*on table/i)
  })

  it("adds both columns and their checks idempotently", () => {
    expect(statements).toContain("add column if not exists piverify_allowed_action text null;")
    expect(statements).toContain("add column if not exists allowed_action text null;")
    expect(statements).toContain("conname = 'courier_registry_piverify_allowed_action_check'")
    expect(statements).toContain("conname = 'piverify_events_allowed_action_check'")
    expect(statements).toMatch(
      /piverify_allowed_action in \('RESUBMIT', 'APPEAL'\)\s+and piverify_status = 'rejected'/
    )
  })

  it("reopens only a rejection that carried an allowed_action", () => {
    expect(statements).toMatch(
      /v_reopened := v_courier\.piverify_status = 'rejected'\s+and v_courier\.piverify_allowed_action is not null;/
    )
  })

  it("keeps approval once, the operator pause, and the outcomes the route branches on", () => {
    expect(statements).toContain("or v_courier.kyc_approved_at is not null")
    expect(statements).toContain("if coalesce(v_courier.paused_reason, '') <> 'operator' then")
    for (const outcome of [
      "duplicate", "session_not_bound", "applied", "not_forward",
      "unknown_courier", "stale_session", "external_user_mismatch", "shredded",
    ]) {
      expect(statements).toContain(`'${outcome}'`)
    }
  })

  it("stores allowed_action only for a rejection", () => {
    expect(statements).toContain("v_action := case when p_status = 'rejected' then p_allowed_action end;")
    expect(statements).toContain("piverify_allowed_action = v_action,")
  })

  it("never binds a session", () => {
    expect(statements).not.toMatch(/set\s+piverify_session_id/i)
    expect(statements).not.toMatch(/piverify_session_id\s*=\s*p_session_id\s*,/)
  })

  it("ends with the read-only verification, which counts the signatures", () => {
    expect(statements.trimEnd().endsWith(") as piverify_resubmission_verification;")).toBe(true)
    expect(statements).toContain("exactly one signature")
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})
