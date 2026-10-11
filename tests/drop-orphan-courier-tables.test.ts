import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_drop_orphan_courier_tables.sql, read as text. It
// was run against a throwaway postgres 17 when it was written, including with
// a dependent view and foreign key in place, which it refused to drop.

const sql = readFileSync("db/migrations/2026-10-08_drop_orphan_courier_tables.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")

const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

describe("orphan courier table drop", () => {
  it("drops exactly the two tables, if they exist, and never cascades", () => {
    expect(statements).toContain("drop table if exists public.couriers;")
    expect(statements).toContain("drop table if exists public.legacy_couriers;")
    expect(statements.match(/\bdrop\b/gi)).toHaveLength(2)
    expect(statements).not.toMatch(/cascade/i)
  })

  it("touches nothing else", () => {
    expect(statements).not.toMatch(/\b(create|alter|grant|revoke|insert|update|delete)\b/i)
    expect(statements).not.toMatch(/drop table if exists public\.(?!couriers;|legacy_couriers;)/)
  })

  it("carries the dependency pre-flight and ends with its verification", () => {
    expect(sql).toContain("from pg_depend d")
    expect(statements.trimEnd().endsWith(") as drop_orphan_courier_tables_verification;")).toBe(true)
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("catalog checks after the drop", () => {
  it("check 13 watches a2u_payments alone", () => {
    expect(catalog).toContain("from (values ('a2u_payments')) as t(name)")
  })

  it("check 9 confirms both tables are gone", () => {
    expect(catalog).toContain("to_regclass('public.couriers') is null")
    expect(catalog).toContain("to_regclass('public.legacy_couriers') is null")
  })
})
