import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_default_function_privileges.sql and the catalog
// checks that watch function privileges, read as text. The SQL was run against
// a throwaway postgres 17 when it was written; these tests hold its shape and,
// above all, its honesty about what it does not do.

const sql = readFileSync("db/migrations/2026-10-08_default_function_privileges.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")

const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

describe("default function privileges migration", () => {
  it("runs the one statement, scoped to role postgres and schema public", () => {
    expect(statements).toContain(
      "alter default privileges for role postgres in schema public\n  revoke execute on functions from anon, authenticated;"
    )
    expect(statements.match(/alter default privileges/g)).toHaveLength(1)
  })

  it("does not run the global form against PUBLIC, which is a separate decision", () => {
    expect(statements).not.toMatch(/from public\b/i)
    // It explains the gap rather than leaving it to be discovered.
    expect(sql).toContain("A new function is STILL executable by anon and authenticated afterwards")
    expect(sql).toContain("through PUBLIC")
  })

  it("ends with the read-only verification and changes nothing else", () => {
    expect(statements.trimEnd().endsWith(") as default_function_privileges_verification;")).toBe(true)
    expect(statements).not.toMatch(/\b(create|drop|grant)\b/i)
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("catalog checks on function privileges", () => {
  it("check 12 reads the ACL rather than matching text, and covers anon and authenticated", () => {
    const check12 = catalog.slice(catalog.indexOf("check_12_public_execute as ("), catalog.indexOf("check_12b_default_privileges as ("))
    expect(check12).toContain("aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))")
    expect(check12).toContain("pg_get_userbyid(a.grantee) in ('anon', 'authenticated')")
    expect(check12).not.toContain("not like '%service_role=X%'")
  })

  it("scopes the default privileges rows in check 9 to role postgres", () => {
    const rows = catalog.match(/defaclrole = 'postgres'::regrole/g) ?? []
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it("no longer claims there is no functions row", () => {
    expect(catalog).not.toContain("There will be NO functions row")
    expect(catalog).toContain("CORRECTED 8 October")
  })
})
