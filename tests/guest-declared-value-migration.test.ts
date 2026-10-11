import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { DECLARED_VALUE_CAP_CEDIS } from "@/lib/declared-value"

// db/migrations/2026-10-10_guest_jobs_declared_value.sql (P12b) and its
// catalog checks, read as text. The SQL was run against a throwaway postgres
// 17 when it was written (docs/anchoring-phase1-notes.md, item 7); these tests
// hold its shape.

const sql = readFileSync("db/migrations/2026-10-10_guest_jobs_declared_value.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")

const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

describe("guest_jobs declared value migration", () => {
  it("adds a nullable integer column, only if absent", () => {
    expect(statements).toMatch(
      /alter table public\.guest_jobs\s+add column if not exists declared_value_cedis integer null;/
    )
    expect(statements).not.toMatch(/integer not null|set not null/i)
    expect(statements).not.toMatch(/add column[^;]*\bdefault\b/i)
    expect(statements).not.toMatch(/not valid/i)
  })

  it("adds the named check, guarded on pg_constraint, with the same cap as the schema", () => {
    expect(statements).toContain("conname = 'guest_jobs_declared_value_cedis_check'")
    expect(statements).toContain(
      `check (declared_value_cedis is null or declared_value_cedis between 0 and ${DECLARED_VALUE_CAP_CEDIS});`
    )
    expect(statements.match(/add constraint/g)).toHaveLength(1)
  })

  it("grants, revokes, drops and touches the dispatch view not at all", () => {
    expect(statements).not.toMatch(/\b(grant|revoke|drop)\b/i)
    expect(statements).not.toContain("guest_jobs_dispatch")
    expect(statements).not.toMatch(/\b(insert|update|delete)\s+(into\s+)?public\./i)
  })

  it("ends with the read-only verification, checking type, check and role privileges", () => {
    expect(statements.trimEnd().endsWith(") as guest_jobs_declared_value_verification;")).toBe(true)
    for (const row of [
      "declared_value_cedis is integer",
      "constraint guest_jobs_declared_value_cedis_check, validated",
      "anon holds no privilege on declared_value_cedis",
      "authenticated holds no privilege on declared_value_cedis",
      "gyema_reader holds no privilege on declared_value_cedis",
      "service_role can SELECT, INSERT and UPDATE declared_value_cedis",
    ]) {
      expect(statements).toContain(row)
    }
    expect(statements).toContain("'all_present', (select bool_and(present) from rows)")
  })

  it("says it goes in before the code", () => {
    expect(sql).toContain("Apply on a project BEFORE the item 7 code deploys there.")
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(sql).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("catalog checks for the declared value", () => {
  it("has the three check 9 rows", () => {
    expect(catalog.match(/\('2026-10-10 declared value',/g)).toHaveLength(3)
  })

  it("has check 16, reading the column through query_to_xml so it parses before the file", () => {
    const start = catalog.indexOf("check_16_guest_declared_value as (")
    expect(start).toBeGreaterThan(-1)
    const body = catalog.slice(start, catalog.indexOf("\nselect jsonb_pretty", start))
    expect(body).toContain("'exists', false")
    expect(body).toContain("null_rows_posted_after_first_valued_row")
    // Every reference to the column sits inside a query_to_xml string.
    expect(body.replace(/'[^']*'/g, "")).not.toContain("declared_value_cedis is")
    expect(catalog).toContain("'check_16_guest_declared_value',  (select v from check_16_guest_declared_value)")
    expect(catalog).toMatch(/'check_16_guest_declared_value',\r?\n/)
  })
})
