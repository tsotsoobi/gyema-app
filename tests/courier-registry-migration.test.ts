import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_courier_registry.sql, read as text.
//
// No test here touches a database. The SQL was run against a throwaway
// postgres 17 when it was written; these tests hold the statements that make
// the table service_role only in place, so a later edit cannot quietly drop
// one. Same approach as tests/grant-baseline-defaults.test.ts.

const sql = readFileSync("db/migrations/2026-10-08_courier_registry.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")
const orphan = readFileSync("docs/orphan-courier-tables.sql", "utf8")
const usernameCase = readFileSync("docs/pioneer-username-case.sql", "utf8")

/** A file with its comment lines removed: the statements it actually runs. */
function statementsOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}

const statements = statementsOf(sql)

describe("courier_registry migration", () => {
  it("creates the table idempotently, with RLS on and no policy", () => {
    expect(statements).toContain("create table if not exists public.courier_registry (")
    expect(statements).toContain("alter table public.courier_registry enable row level security;")
    expect(statements).not.toMatch(/create policy/i)
  })

  it("revokes from public, anon and authenticated, and grants service_role three privileges only", () => {
    expect(statements).toContain("revoke all on table public.courier_registry from public, anon, authenticated;")
    expect(statements).toContain("revoke all on table public.courier_registry from service_role;")
    expect(statements).toContain("grant select, insert, update on table public.courier_registry to service_role;")
    const grants = statements.match(/^\s*grant .*$/gim) ?? []
    expect(grants).toHaveLength(1)
  })

  it("creates no function, trigger or view, so nothing needs an EXECUTE revoke", () => {
    expect(statements).not.toMatch(/create (or replace )?function/i)
    expect(statements).not.toMatch(/create trigger/i)
    expect(statements).not.toMatch(/create (or replace )?view/i)
  })

  it("never touches the orphan tables or any existing table", () => {
    expect(statements).not.toMatch(/\b(drop|alter|insert into|update|delete from)\b[^;]*\b(couriers|legacy_couriers)\b/i)
    expect(statements).not.toMatch(/\b(guest_jobs|listings|pioneers)\b/)
  })

  it("stores no pi_uid and gives the salt no default", () => {
    expect(statements).not.toMatch(/\bpi_uid\b/)
    expect(statements).toMatch(/commitment_salt\s+bytea\s+null,/)
    expect(statements).not.toMatch(/gen_random_bytes/)
  })

  it("names every constraint and index the verification reports", () => {
    const names = [
      "courier_registry_pkey",
      "courier_registry_class_check",
      "courier_registry_status_check",
      "courier_registry_piverify_status_check",
      "courier_registry_paused_reason_check",
      "courier_registry_salt_length_check",
      "courier_registry_salt_until_shredded_check",
      "courier_registry_legacy_no_username_check",
      "courier_registry_pioneer_username_check",
      "courier_registry_pi_username_trimmed_check",
      "courier_registry_auth_user_id_fkey",
      "courier_registry_pi_username_lower_key",
      "courier_registry_piverify_session_key",
      "courier_registry_auth_user_key",
    ]
    for (const name of names) {
      // Once where it is created, once in the verification's expected list.
      expect(statements.split(name).length - 1).toBeGreaterThanOrEqual(2)
    }
  })

  it("indexes pi_username case-insensitively", () => {
    expect(statements).toMatch(/courier_registry_pi_username_lower_key\s+on public\.courier_registry \(lower\(pi_username\)\)/)
  })

  it("links to the auth user, one courier per user, set null on delete", () => {
    expect(statements).toMatch(/auth_user_id\s+uuid\s+null,/)
    expect(statements).toContain("foreign key (auth_user_id) references auth.users (id) on delete set null")
    expect(statements).not.toMatch(/on delete cascade/i)
    expect(statements).toMatch(/courier_registry_auth_user_key\s+on public\.courier_registry \(auth_user_id\)\s+where auth_user_id is not null/)
  })

  it("ends with the read-only verification as its last statement", () => {
    const tail = statements.trimEnd()
    expect(tail.endsWith(") as courier_registry_verification;")).toBe(true)
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
    expect(orphan).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
    expect(usernameCase).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("catalog checks know the courier registry", () => {
  it("adds check 14 and lists it in the output", () => {
    expect(catalog).toContain("check_14_courier_registry as (")
    expect(catalog).toContain("'check_14_courier_registry',      (select v from check_14_courier_registry)")
  })

  it("marks courier_registry as referenced by the repository", () => {
    // Checks 1 and 11 each carry a referenced_by_repo list. Membership, not
    // position: later tables join the end of both lists.
    expect(catalog).toMatch(/'auth_events',\s*'courier_registry'[,)]/)
    expect(catalog).toMatch(/'listings_dispatch', 'courier_registry'[,)]/)
  })
})

describe("orphan courier tables query", () => {
  it("is read only and never selects a column value", () => {
    const body = statementsOf(orphan)
    expect(body).not.toMatch(/\b(insert|update|delete|drop|alter|grant|revoke|create)\b/i)
    // Every read of a table goes through count(...).
    const reads = body.match(/format\('select [^']*from public\.%I'/g) ?? []
    expect(reads.length).toBe(2)
    for (const read of reads) expect(read).toMatch(/select count\(/)
  })
})

describe("pioneer username case query", () => {
  it("is read only and returns no username, only counts", () => {
    const body = statementsOf(usernameCase)
    expect(body).not.toMatch(/\b(insert|update|delete|drop|alter|grant|revoke|create)\b/i)
    // The output object is built from count(...) and sum(...) values only.
    const output = body.slice(body.indexOf("select jsonb_pretty"))
    expect(output).not.toMatch(/'[a-z_]+',\s+pi_username\b/)
    expect(output).not.toMatch(/jsonb_agg|array_agg|string_agg/)
  })
})
