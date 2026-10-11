import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// Phase 1 item 6, part (a): P13, P14 and P15 and their catalog checks, read
// as text. No test here touches a database. The three files were run against
// a throwaway postgres 17 when they were written (docs/anchoring-phase1-notes.md,
// item 6, part (a)); these tests hold the statements that keep the founder
// function owner only, the lookup service_role only, the dispatch view's
// first 23 columns as they were, and the registry view unreachable to anyone
// but gyema_reader.

const p13 = readFileSync("db/migrations/2026-10-09_guest_jobs_courier_assignment.sql", "utf8")
const p14 = readFileSync("db/migrations/2026-10-09_dispatch_view_courier_id.sql", "utf8")
const p15 = readFileSync("db/migrations/2026-10-10_courier_registry_dispatch_view.sql", "utf8")
const p0915 = readFileSync("db/migrations/2026-09-15_dispatch_view_remit_cedis.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")

/** A file with its comment lines removed: the statements it actually runs. */
function statementsOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}

/** The select list of a guest_jobs_dispatch replace, one entry per column. */
function selectList(sql: string): string[] {
  const start = sql.indexOf("create or replace view public.guest_jobs_dispatch")
  const body = sql.slice(sql.indexOf("select", start) + "select".length, sql.indexOf("from public.guest_jobs", start))
  return body
    .split(",")
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

const p13Sql = statementsOf(p13)
const p14Sql = statementsOf(p14)
const p15Sql = statementsOf(p15)

describe("P13: guest_jobs.assigned_courier_id, vouched_at and the Pioneer lookup", () => {
  it("adds a nullable uuid column with a named foreign key, guarded, and no cascade", () => {
    expect(p13Sql).toMatch(/alter table public\.guest_jobs\s+add column if not exists assigned_courier_id uuid null;/)
    expect(p13Sql).toContain("conname = 'guest_jobs_assigned_courier_id_fkey'")
    expect(p13Sql).toMatch(
      /add constraint guest_jobs_assigned_courier_id_fkey\s+foreign key \(assigned_courier_id\) references public\.courier_registry \(id\);/
    )
    const fk = p13Sql.slice(p13Sql.indexOf("add constraint guest_jobs_assigned_courier_id_fkey"))
    expect(fk.slice(0, fk.indexOf(";"))).not.toMatch(/on delete|on update|cascade/i)
    expect(p13Sql.match(/add constraint/g)).toHaveLength(2)
  })

  it("adds the partial index on assigned_courier_id", () => {
    expect(p13Sql).toMatch(
      /create index if not exists guest_jobs_assigned_courier_id_idx\s+on public\.guest_jobs \(assigned_courier_id\)\s+where assigned_courier_id is not null;/
    )
  })

  it("adds vouched_at to the registry, additively, held to Pioneer rows by a named, guarded check", () => {
    expect(p13Sql).toMatch(/alter table public\.courier_registry\s+add column if not exists vouched_at timestamptz null;/)
    expect(p13Sql).toContain("conname = 'courier_registry_vouched_pioneer_only_check'")
    expect(p13Sql).toMatch(
      /add constraint courier_registry_vouched_pioneer_only_check\s+check \(vouched_at is null or class = 'pioneer'\);/
    )
    expect(p13Sql).toContain(
      "constraint courier_registry_vouched_pioneer_only_check, validated, vouched_at null or class pioneer"
    )
  })

  it("registers a Pioneer as full and vouched, never KYC-approved", () => {
    const fn = p13Sql.slice(
      p13Sql.indexOf("create or replace function public.courier_register_pioneer"),
      p13Sql.indexOf("create or replace function public.courier_find_pioneer")
    )
    expect(fn).toContain("insert into public.courier_registry (class, status, pi_username, vouched_at, commitment_salt)")
    expect(fn).toContain("values ('pioneer', 'full', p_pi_username, now(),")
    expect(fn).toContain("sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()))")
    expect(fn).not.toContain("kyc_approved_at")
    expect(fn).toContain("p_pi_username <> btrim(p_pi_username)")
    expect(fn).toContain("using errcode = '22023'")
  })

  it("looks up on lower(pi_username), states the index predicate, and skips shredded and legacy rows", () => {
    const fnStart = p13Sql.indexOf("create or replace function public.courier_find_pioneer")
    const fn = p13Sql.slice(fnStart, p13Sql.indexOf("$$;", fnStart))
    expect(fn).toContain("where r.pi_username is not null")
    expect(fn).toContain("and lower(r.pi_username) = lower(p_pi_username)")
    expect(fn).toContain("and r.class = 'pioneer'")
    expect(fn).toContain("and r.shredded_at is null;")
    expect(fn).toMatch(/language sql\s+stable\s+security definer/)
    // No pattern matching: ilike reads _ as a wildcard.
    expect(fn).not.toMatch(/\b(i?like|similar to)\b|~\*?\s*'/i)
    for (const column of ["id", "status", "buffer_since", "paused_reason", "kyc_approved_at", "vouched_at"]) {
      expect(fn).toMatch(new RegExp(`\\b${column}\\s+(uuid|text|timestamptz)`))
    }
    expect(fn).not.toMatch(/pi_username\s+text,|commitment_salt|piverify_session_id/)
  })

  it("makes both functions security definer with search_path pinned", () => {
    expect(p13Sql.match(/create or replace function/g) ?? []).toHaveLength(2)
    expect(p13Sql.match(/security definer\s+set search_path = public, pg_temp/g) ?? []).toHaveLength(2)
  })

  it("keeps courier_register_pioneer owner only and courier_find_pioneer service_role only", () => {
    expect(p13Sql).toContain(
      "revoke all on function public.courier_register_pioneer(text)\n  from public, anon, authenticated, service_role;"
    )
    expect(p13Sql).not.toContain("grant execute on function public.courier_register_pioneer")
    expect(p13Sql).toContain("revoke all on function public.courier_find_pioneer(text)\n  from public, anon, authenticated;")
    expect(p13Sql).toContain("grant execute on function public.courier_find_pioneer(text)\n  to service_role;")
    expect(p13Sql.match(/grant execute on function/g) ?? []).toHaveLength(1)
    // No table or column grant: service_role's table-wide grant covers the column.
    expect(p13Sql).not.toMatch(/grant [^;]* on (table )?public\.(guest_jobs|courier_registry)\b/i)
  })

  it("marks the identity write for founder review", () => {
    expect(p13.match(/^-- IDENTITY WRITE: founder review required\./gm) ?? []).toHaveLength(1)
  })

  it("writes no row and touches neither the dispatch view nor an applied function", () => {
    // Outside the function bodies, nothing writes a row.
    const outsideBodies = p13Sql.replace(/\$\$[\s\S]*?\$\$/g, "")
    expect(outsideBodies).not.toMatch(/^\s*(insert into|update|delete from)\s+public\./im)
    expect(p13Sql).not.toContain("guest_jobs_dispatch")
    for (const applied of ["guest_stamp_delivery", "guest_bump_delivery_code_attempts", "guest_bump_last4_attempts",
      "courier_session_resolve", "courier_register_legacy", "courier_apply_kyc_status"]) {
      expect(p13Sql).not.toContain(applied)
    }
  })

  it("ends with the read-only verification, naming every object it adds", () => {
    expect(p13Sql.trimEnd().endsWith(") as guest_jobs_courier_assignment_verification;")).toBe(true)
    for (const row of [
      "column guest_jobs.assigned_courier_id",
      "constraint guest_jobs_assigned_courier_id_fkey, validated",
      "index guest_jobs_assigned_courier_id_idx, partial on not null",
      "anon holds no privilege on assigned_courier_id",
      "authenticated holds no privilege on assigned_courier_id",
      "gyema_reader holds no privilege on assigned_courier_id",
      "column courier_registry.vouched_at",
      "service_role cannot execute ",
      ": EXECUTE for no role but the owner",
      ": EXECUTE for service_role only",
    ]) {
      expect(p13Sql).toContain(row)
    }
    expect(p13Sql).toContain("'all_present', (select bool_and(present) from rows)")
  })

  it("says it goes in before the code, and records the P2 cell caveat", () => {
    expect(p13).toContain("Apply on a project BEFORE the item 6 code deploys there.")
    expect(p13).toContain('"no columns beyond the expected fifteen"')
  })
})

describe("P14: guest_jobs_dispatch gains assigned_courier_id and declared_value_cedis", () => {
  it("reproduces the 2026-09-15 select list exactly and appends the two columns, in order", () => {
    const before = selectList(statementsOf(p0915))
    const after = selectList(p14Sql)
    expect(before).toHaveLength(23)
    expect(after).toHaveLength(25)
    expect(after.slice(0, 23)).toEqual(before)
    expect(after.slice(23)).toEqual(["assigned_courier_id", "declared_value_cedis"])
  })

  it("keeps the options, the order and the cap, and is a replace, never a drop", () => {
    expect(p14Sql).toMatch(/create or replace view public\.guest_jobs_dispatch\s+with \(security_invoker = false\)/)
    expect(p14Sql).toMatch(/from public\.guest_jobs\s+order by created_at desc\s+limit 2000;/)
    expect(p14Sql).not.toMatch(/\bdrop\b/i)
    expect(p14Sql).not.toMatch(/\b(grant|revoke)\b/i)
  })

  it("guards before the replace: server version, both columns, and the live shape", () => {
    const guard = p14Sql.indexOf("do $$")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(p14Sql.indexOf("create or replace view"))
    expect(p14Sql).toContain("current_setting('server_version_num')::int < 150000")
    expect(p14Sql).toContain("attname = 'assigned_courier_id'")
    expect(p14Sql).toContain("attname = 'declared_value_cedis'")
    expect(p14Sql).toContain("v_live is distinct from v_before and v_live is distinct from v_after")
    // The guard's expected list is the same 23 columns as the select list.
    const listed = p14Sql.slice(p14Sql.indexOf("v_before    text[] := array["), p14Sql.indexOf("v_after"))
    const names = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(names).toEqual(selectList(statementsOf(p0915)).map((c) => c.split(" as ").pop()!.trim()))
  })

  it("ends with the read-only verification, checking positions 24 and 25 and the grants", () => {
    expect(p14Sql.trimEnd().endsWith(") as dispatch_view_courier_id_verification;")).toBe(true)
    for (const row of [
      "exactly 25 columns",
      "columns 1 to 25 by name, in order",
      "column 24 assigned_courier_id is uuid",
      "column 25 declared_value_cedis is integer",
      "gyema_reader holds exactly SELECT",
      "anon, authenticated and PUBLIC hold nothing",
    ]) {
      expect(p14Sql).toContain(row)
    }
  })

  it("names its prerequisites", () => {
    expect(p14).toContain("PREREQUISITES. P12b (2026-10-10_guest_jobs_declared_value.sql) and P13")
  })
})

describe("P15: courier_registry_dispatch", () => {
  it("carries the reference, the ladder columns and piverify_allowed_action only", () => {
    const body = p15Sql.slice(p15Sql.indexOf("create or replace view public.courier_registry_dispatch"),
      p15Sql.indexOf("from public.courier_registry;"))
    expect(body).toContain("left(id::text, 8) as courier_ref,")
    const columns = body
      .slice(body.indexOf("select") + 6)
      .replace(/\([^()]*\)/g, "()")
      .split(",")
      .map((c) => c.trim().split(/\s+/).pop())
    expect(columns).toEqual(["courier_ref", "class", "status", "buffer_since", "piverify_status",
      "piverify_status_at", "paused_reason", "shredded_at", "piverify_allowed_action"])
    expect(body).not.toMatch(/pi_username|commitment_salt|piverify_session_id|auth_user_id|vouched_at|kyc_approved_at/)
  })

  it("is security_invoker false, revoked from everyone including service_role, and granted to gyema_reader alone", () => {
    expect(p15Sql).toMatch(/create or replace view public\.courier_registry_dispatch\s+with \(security_invoker = false\)/)
    expect(p15Sql).toContain(
      "revoke all on public.courier_registry_dispatch from public, anon, authenticated, service_role;"
    )
    expect(p15Sql).toContain("grant select on public.courier_registry_dispatch to gyema_reader;")
    expect(p15Sql.match(/\bgrant\b/g) ?? []).toHaveLength(1)
    // The revoke follows the create immediately: nothing else runs between them.
    const create = p15Sql.indexOf("create or replace view public.courier_registry_dispatch")
    const revoke = p15Sql.indexOf("revoke all on public.courier_registry_dispatch")
    expect(p15Sql.slice(create, revoke)).not.toMatch(/\b(grant|insert|update|delete)\b/i)
  })

  it("grants nothing on courier_registry itself", () => {
    expect(p15Sql).not.toMatch(/(grant|revoke)[^;]*on (table )?public\.courier_registry\b(?!_)/i)
  })

  it("ends with the read-only verification", () => {
    expect(p15Sql.trimEnd().endsWith(") as courier_registry_dispatch_verification;")).toBe(true)
    for (const row of [
      "exactly 9 columns, by name, in order",
      "no pi_username, commitment_salt, piverify_session_id, auth_user_id or id",
      "(9, 'piverify_allowed_action')",
      "nobody but gyema_reader holds anything, service_role included",
      "gyema_reader still holds nothing on courier_registry itself",
    ]) {
      expect(p15Sql).toContain(row)
    }
  })
})

describe("item 6 part (a) files", () => {
  it("name no network, so they mirror between repositories as bytes", () => {
    for (const text of [p13, p14, p15]) {
      expect(text).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
    }
  })

  it("carry no em-dash", () => {
    for (const text of [p13, p14, p15]) expect(text).not.toContain("\u2014")
  })
})

describe("catalog checks for item 6 part (a)", () => {
  it("has the check 9 rows for each file", () => {
    expect(catalog.match(/\('2026-10-09 courier assignment',/g)).toHaveLength(10)
    expect(catalog.match(/\('2026-10-09 dispatch view courier id',/g)).toHaveLength(2)
    expect(catalog.match(/\('2026-10-10 courier registry dispatch',/g)).toHaveLength(4)
    expect(catalog).toContain("column_name='piverify_allowed_action' and ordinal_position=9)")
  })

  it("lists both functions in check 7 and the view in check 11", () => {
    const check7 = catalog.slice(catalog.indexOf("check_07_function_acls as ("), catalog.indexOf("check_08_guard_columns as ("))
    expect(check7).toContain("'courier_find_pioneer',")
    expect(check7).toContain("'courier_register_pioneer',")
    const check11 = catalog.slice(catalog.indexOf("check_11_inventory as ("), catalog.indexOf("check_12_public_execute as ("))
    expect(check11).toContain("'courier_registry_dispatch'")
  })

  it("amends check 14's full rule to kyc_approved_at or vouched_at, only once vouched_at exists", () => {
    const check14 = statementsOf(
      catalog.slice(catalog.indexOf("check_14_courier_registry as ("), catalog.indexOf("check_15_courier_signin as ("))
    )
    expect(check14).toContain("'full_without_kyc_approved_at_or_vouched_at'")
    expect(check14).toContain("then ' and vouched_at is null' else '' end")
    // vouched_at is named only inside SQL strings or the information_schema guard.
    expect(check14.replace(/'[^']*'/g, "")).not.toMatch(/\bvouched_at\b/)
  })

  it("has check 17, reading assigned_courier_id through query_to_xml so it parses before P13", () => {
    const start = catalog.indexOf("check_17_courier_assignment as (")
    expect(start).toBeGreaterThan(-1)
    const body = catalog.slice(start, catalog.indexOf("\nselect jsonb_pretty", start))
    expect(body).toContain("'exists', false")
    expect(body).toContain("legacy_claims_with_assigned_courier_set")
    expect(body.replace(/'[^']*'/g, "")).not.toMatch(/assigned_courier_id is|g\.assigned_courier/)
    expect(catalog).toContain("'check_17_courier_assignment',    (select v from check_17_courier_assignment)")
    expect(catalog).toMatch(/'check_17_courier_assignment',\r?\n/)
  })
})
