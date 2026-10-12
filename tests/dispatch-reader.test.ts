import { describe, it, expect } from "vitest"
import type { GuestJobStatus } from "@/lib/guest-jobs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = promisify(execFile)

// The dispatch reader is a real process, so these tests run it as one. Every
// case here exits before any socket is opened: the connection string points at
// a host that does not resolve, and a test that reached the network would fail
// with a connection error instead of the refusal being asserted.
const SCRIPT = "scripts/dispatch-reader.mjs"
// A placeholder project ref, so the network guard passes and the TLS checks
// below are what each refusal test reaches.
const REF = "abcdefghijklmnopqrst"
const UNROUTABLE = `postgres://gyema_reader.${REF}:not-a-real-password@no-such-host.invalid:5432/postgres`

async function runReader(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("node", [SCRIPT], {
      env: { ...process.env, GYEMA_READER_EXPECTED_REF: REF, ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

describe("dispatch reader, TLS refusal", () => {
  it("refuses to run without a database URL", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("GYEMA_READER_DATABASE_URL is not set")
  })

  it("refuses to connect when GYEMA_READER_CA_CERT is unset", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("GYEMA_READER_CA_CERT is not set")
    expect(res.stderr).toContain("will not open an unverified TLS connection")
    // The refusal happens before any connection is attempted.
    expect(res.stderr).not.toContain("could not connect")
  })

  it("refuses when the CA path does not exist", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: join(tmpdir(), "gyema-no-such-ca.pem"),
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("could not read GYEMA_READER_CA_CERT")
    expect(res.stderr).not.toContain("could not connect")
  })

  it("refuses a CA file that is not a certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gyema-ca-"))
    const path = join(dir, "not-a-cert.pem")
    writeFileSync(path, "this is not a certificate\n", "utf8")
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: path,
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("does not look like a PEM certificate")
    expect(res.stderr).not.toContain("could not connect")
  })

  it("there is no unverified fallback left in the source", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(SCRIPT, "utf8")
    // Exactly one setting of the option, and it is true. The prose above the
    // TLS block mentions the old fallback by name, so match the setting rather
    // than the word.
    const settings = source.match(/rejectUnauthorized:\s*(true|false)/g) ?? []
    expect(settings).toEqual(["rejectUnauthorized: true"])
  })
})

describe("dispatch reader, report shape", () => {
  it("dry run needs no credential and opens no connection", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "1",
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("No connection was opened and no credential was read.")
  })

  it("every generated statement reads a masked view, never a base table", async () => {
    const { SECTIONS, CHECKS, COURIER_REGISTRY_LOOKUP, buildSql, buildPreflightSql } = await import(
      "../scripts/dispatch-reader.mjs"
    )
    const statements = [
      buildPreflightSql(),
      ...[...SECTIONS, ...CHECKS, COURIER_REGISTRY_LOOKUP].map((s: { table: string }) => buildSql(s as never)),
    ]
    for (const sql of statements) {
      expect(sql).not.toMatch(/from public\.guest_jobs\b/)
      expect(sql).not.toMatch(/from public\.listings\b/)
      expect(sql).not.toMatch(/from public\.courier_registry\b/)
      // The identifying registry columns, none of which P15 carries.
      for (const hidden of ["pi_username", "commitment_salt", "piverify_session_id", "auth_user_id"]) {
        expect(sql).not.toContain(hidden)
      }
      // The raw phone columns are unreachable to this role, so a statement
      // naming one would fail at the database. Catch it here instead.
      expect(sql).not.toMatch(/\bsender_phone\b(?!_masked)/)
      expect(sql).not.toMatch(/\brecipient_phone\b(?!_masked)/)
      expect(sql).not.toContain("delivery_code_hash")
    }
  })

  // The preflight only checks REQUIRED_COLUMNS. A section that names a column
  // missing from that list passes the preflight and then fails its own query
  // with 42703, which is reported, but softly, and only once it has run
  // against a database. This test closes that gap at commit time: every
  // identifier a section or check uses in its columns, where or order must be
  // either SQL vocabulary on the list below or a column REQUIRED_COLUMNS
  // declares for that section's own view.
  //
  // The vocabulary list is deliberately closed. A new SQL word in a section
  // fails here until it is added, the same intended friction as the read only
  // guard's call allowlist.
  const SQL_VOCABULARY = new Set([
    "and", "or", "not", "is", "null", "true", "false", "in", "distinct", "from",
    "asc", "desc", "interval", "current_date", "to_char", "extract", "epoch", "now",
  ])

  function identifiersOutsideRequired(
    section: { id: string | number; table: string; columns: string[]; where: string; order: string },
    required: Record<string, string[]>,
  ) {
    const view = section.table.replace(/^public\./, "")
    const known = new Set(required[view] ?? [])
    const text = [...section.columns, section.where, section.order]
      .join(" ")
      .replace(/'[^']*'/g, " ")
      .replace(/::\s*[a-z_][a-z0-9_]*/gi, " ")
      .replace(/\bas\s+[a-z_][a-z0-9_]*/gi, " ")
    const names = (text.match(/\b[a-z_][a-z0-9_]*\b/gi) ?? []).map((n) => n.toLowerCase())
    return [...new Set(names.filter((n) => !SQL_VOCABULARY.has(n) && !known.has(n)))]
  }

  it("every column a section or check uses is in REQUIRED_COLUMNS for its own view", async () => {
    const { SECTIONS, CHECKS, COURIER_REGISTRY_LOOKUP, REQUIRED_COLUMNS } = await import("../scripts/dispatch-reader.mjs")
    for (const section of [...SECTIONS, ...CHECKS, COURIER_REGISTRY_LOOKUP]) {
      const view = section.table.replace(/^public\./, "")
      expect((REQUIRED_COLUMNS as Record<string, string[]>)[view], `section ${section.id} reads ${section.table}`).toBeDefined()
      expect(identifiersOutsideRequired(section, REQUIRED_COLUMNS), `section ${section.id}`).toEqual([])
    }
  })

  it("that check catches a column the view does not declare", async () => {
    const { REQUIRED_COLUMNS } = await import("../scripts/dispatch-reader.mjs")
    const probe = {
      id: "probe",
      table: "public.guest_jobs_dispatch",
      columns: ["tracking_id", "to_char(remit_paid_at, 'YYYY-MM-DD') as remit_paid_at_txt", "remit_pi"],
      where: "status = 'delivered' and remit_rate is not null",
      order: "created_at asc",
    }
    expect(identifiersOutsideRequired(probe, REQUIRED_COLUMNS)).toEqual(["remit_pi", "remit_rate"])
    // And a guest column is not accepted on the listings view.
    const crossed = { ...probe, table: "public.listings_dispatch", columns: ["tracking_id"], where: "remit_cedis is null" }
    expect(identifiersOutsideRequired(crossed, REQUIRED_COLUMNS)).toEqual(["remit_cedis"])
  })

  it("the report can no longer mask a phone itself", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    expect("maskPhone" in mod).toBe(false)
  })

  it("the read only guard refuses a write dressed as a select", async () => {
    const { assertReadOnlySql } = await import("../scripts/dispatch-reader.mjs")
    expect(() => assertReadOnlySql("select guest_stamp_delivery('GYM-000000', 'sender')")).toThrow()
    expect(() => assertReadOnlySql("select tracking_id from guest_jobs_dispatch; update x set y = 1")).toThrow()
    expect(() => assertReadOnlySql("update guest_jobs set status = 'delivered'")).toThrow()
    expect(assertReadOnlySql("select tracking_id from guest_jobs_dispatch")).toBeTruthy()
  })
})

describe("dispatch reader, commission", () => {
  type Section = {
    id: string | number
    where: string
    columns: string[]
    footer?: (rows: Record<string, unknown>[]) => string[]
    render: (row: Record<string, unknown>) => { flags: string[]; fields: [string, string][] }
  }

  async function load() {
    const mod = await import("../scripts/dispatch-reader.mjs")
    // The .mjs sections are inferred as a union of object literals; the shape
    // this block reads from them is declared once, above.
    const all = [...mod.SECTIONS, ...mod.CHECKS] as unknown as Section[]
    const byId = (id: string | number) => {
      const s = all.find((x) => String(x.id) === String(id))
      if (!s) throw new Error(`no section ${id}`)
      return s
    }
    return { mod, byId }
  }

  it("the view carries remit_cedis and no other new remit column", async () => {
    const { mod } = await load()
    const guest: string[] = mod.REQUIRED_COLUMNS.guest_jobs_dispatch
    expect(guest).toContain("remit_cedis")
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_ref"]) {
      expect(guest).not.toContain(hidden)
    }
  })

  it("sections 8 and 8b split one population on remit_cedis and nothing else", async () => {
    const { byId } = await load()
    const eight = byId(8).where
    const eightB = byId("8b").where
    expect(eight).toBe("status = 'delivered' and remit_paid_at is null and remit_cedis is not null")
    expect(eightB).toBe("status = 'delivered' and remit_paid_at is null and remit_cedis is null")
  })

  it("section 8 totals the commission, not the quote", async () => {
    const { byId } = await load()
    const lines = byId(8).footer!([
      { remit_cedis: "3.00", quote_cedis: "40.00" },
      { remit_cedis: "5.50", quote_cedis: "70.00" },
    ])
    expect(lines[0]).toBe("  remit_cedis total over 2 of 2 rows: 8.50")
    expect(lines.join("\n")).not.toContain("110.00")
  })

  it("check 0.4 totals the commission and counts a missing one apart", async () => {
    const { byId } = await load()
    const lines = byId("0.4").footer!([
      { remit_cedis: "3.00", quote_cedis: "40.00" },
      { remit_cedis: null, quote_cedis: "50.00" },
    ])
    expect(lines[0]).toBe("  remit_cedis total over 1 of 2 rows: 3.00")
    expect(lines).toContain("  1 row(s) carried no usable remit_cedis and are excluded from that total")
  })

  it("section 8b never prints a cedi total", async () => {
    const { byId } = await load()
    const lines = byId("8b").footer!([
      { quote_cedis: "40.00", created_after_window: false, stamped_before_window: true },
      { quote_cedis: "50.00", created_after_window: true, stamped_before_window: null },
      { quote_cedis: "70.00", created_after_window: false, stamped_before_window: null },
    ])
    const text = lines.join("\n")
    expect(text).not.toContain("total over")
    for (const amount of ["40.00", "50.00", "70.00", "90.00", "120.00", "160.00"]) {
      expect(text).not.toContain(amount)
    }
    expect(lines).toContain("  No cedi total is printed for this section, by design.")
  })

  it("section 8b places each row against the window, and only strict true is evidence", async () => {
    const { mod, byId } = await load()
    const era = mod.commissionEra
    expect(era({ created_after_window: false, stamped_before_window: true })).toBe("pre_change")
    expect(era({ created_after_window: true, stamped_before_window: null })).toBe("data_gap")
    expect(era({ created_after_window: false, stamped_before_window: null })).toBe("cannot_tell")
    expect(era({ created_after_window: null, stamped_before_window: null })).toBe("cannot_tell")
    expect(era({ created_after_window: true, stamped_before_window: true })).toBe("inconsistent")

    // A pre-change or undecidable row is listed without an alert; a data gap is flagged.
    const render = byId("8b").render
    expect(render({ created_after_window: false, stamped_before_window: true }).flags).toEqual([])
    expect(render({ created_after_window: null, stamped_before_window: null }).flags).toEqual([])
    expect(render({ created_after_window: true, stamped_before_window: null }).flags[0]).toMatch(/^DATA GAP/)
  })

  it("the window bounds are the deployment records widened by one hour outward", async () => {
    const { mod, byId } = await load()
    expect(mod.COMMISSION_SHIPPED_EARLIEST).toBe("2026-09-14 15:48:36+00")
    expect(mod.COMMISSION_SHIPPED_LATEST).toBe("2026-09-15 01:51:41+00")
    // Testnet deployment 6441956927 less one hour, Mainnet 6449391484 plus one hour.
    const hour = 3600 * 1000
    expect(Date.parse("2026-09-14T16:48:36Z") - Date.parse(mod.COMMISSION_SHIPPED_EARLIEST.replace(" ", "T").replace("+00", "Z"))).toBe(hour)
    expect(Date.parse(mod.COMMISSION_SHIPPED_LATEST.replace(" ", "T").replace("+00", "Z")) - Date.parse("2026-09-15T00:51:41Z")).toBe(hour)
    // Check 0.5 filters on the later bound, never the earlier one.
    expect(byId("0.5").where).toContain(`created_at >= '${mod.COMMISSION_SHIPPED_LATEST}'::timestamptz`)
    expect(byId("0.5").where).not.toContain(mod.COMMISSION_SHIPPED_EARLIEST)
  })
})

describe("dispatch reader, couriers and declared value (item 6 part (d))", () => {
  type Ctx = { registry?: Map<string, Record<string, unknown>[]> }
  type Section = {
    id: string | number
    table: string
    where: string
    columns: string[]
    footer?: (rows: Record<string, unknown>[]) => string[]
    render: (row: Record<string, unknown>, ctx?: Ctx) => { flags: string[]; fields: [string, string][] }
  }

  async function load() {
    const mod = await import("../scripts/dispatch-reader.mjs")
    const all = [...mod.SECTIONS, ...mod.CHECKS] as unknown as Section[]
    const byId = (id: string | number) => {
      const s = all.find((x) => String(x.id) === String(id))
      if (!s) throw new Error(`no section ${id}`)
      return s
    }
    return { mod, all, byId }
  }

  const LEGACY_ID = "1a2b3c4d-0000-4000-8000-00000000aaaa"
  const PIONEER_ID = "9f8e7d6c-0000-4000-8000-00000000bbbb"
  const REGISTRY_ROWS = [
    { courier_ref: "1a2b3c4d", class: "legacy", status: "full" },
    { courier_ref: "9f8e7d6c", class: "pioneer", status: "full" },
  ]

  // The four job shapes the reader has to tell apart. created_at is after the
  // commission window, so check 0.5 applies to every one of them.
  const AFTER = "2026-10-01T10:00:00Z"
  const pioneerJob = {
    tracking_id: "GYM-P10NE1", status: "accepted", created_at: AFTER,
    assigned_courier: "ama_b", assigned_courier_id: PIONEER_ID,
    remit_cedis: null, declared_value_cedis: 150, quote_cedis: "40.00",
  }
  const legacyJob = {
    tracking_id: "GYM-1E6AC1", status: "accepted", created_at: AFTER,
    assigned_courier: null, assigned_courier_id: LEGACY_ID,
    remit_cedis: null, declared_value_cedis: 80, quote_cedis: "35.00",
  }
  const unassignedJob = {
    tracking_id: "GYM-0PEN01", status: "posted", created_at: AFTER,
    assigned_courier: null, assigned_courier_id: null,
    remit_cedis: null, declared_value_cedis: 60, quote_cedis: "30.00",
  }
  const noValueJob = { ...legacyJob, tracking_id: "GYM-N0VAL1", declared_value_cedis: null }

  function field(view: { fields: [string, string][] }, label: string) {
    const hit = view.fields.find(([l]) => l === label)
    if (!hit) throw new Error(`no field ${label}`)
    return hit[1]
  }

  // Evaluates the restricted where clauses the checks use against a mocked
  // row: terms joined by "and", arms joined by "or", and binds tighter than or,
  // as in SQL. Any term it does not recognise throws, so a clause it cannot
  // read fails the test instead of passing it. now() is the fixed NOW, and a
  // comparison against a null column is false, as SQL's unknown is.
  const NOW = Date.parse("2026-10-11T12:00:00Z")
  function matches(where: string, row: Record<string, unknown>): boolean {
    const term = (t: string): boolean => {
      let m = t.match(/^([a-z_]+) = '([^']*)'$/)
      if (m) return row[m[1]] === m[2]
      m = t.match(/^([a-z_]+) in \(((?:'[^']*'(?:, )?)+)\)$/)
      if (m) return [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]).includes(row[m[1]] as string)
      m = t.match(/^([a-z_]+) <= now\(\) - interval '(\d+) hours'$/)
      if (m) {
        const v = row[m[1]]
        if (v === null || v === undefined) return false
        return Date.parse(String(v)) <= NOW - Number(m[2]) * 3600 * 1000
      }
      m = t.match(/^([a-z_]+) is not null$/)
      if (m) return row[m[1]] !== null && row[m[1]] !== undefined
      m = t.match(/^([a-z_]+) is null$/)
      if (m) return row[m[1]] === null || row[m[1]] === undefined
      m = t.match(/^([a-z_]+) >= '([^']+)'::timestamptz$/)
      if (m) {
        const v = row[m[1]]
        if (v === null || v === undefined) return false
        return Date.parse(String(v)) >= Date.parse(m[2].replace(" ", "T").replace(/\+00$/, "Z"))
      }
      throw new Error(`unrecognised term: ${t}`)
    }
    return where.split(" or ").some((arm) => arm.split(" and ").every((t) => term(t.trim())))
  }

  it("reads MAX_CODE_ATTEMPTS and BUFFER_WINDOW_DAYS from their one definition and keeps no copy", async () => {
    const { readFileSync } = await import("node:fs")
    const { mod } = await load()
    const { MAX_CODE_ATTEMPTS } = await import("@/lib/guest-claim")
    const { BUFFER_WINDOW_DAYS } = await import("@/lib/courier-ladder")
    expect(mod.MAX_CODE_ATTEMPTS).toBe(MAX_CODE_ATTEMPTS)
    expect(mod.BUFFER_WINDOW_DAYS).toBe(BUFFER_WINDOW_DAYS)
    const source = readFileSync(SCRIPT, "utf8")
    expect(source).not.toMatch(/MAX_CODE_ATTEMPTS\s*=\s*\d/)
    expect(source).not.toMatch(/BUFFER_WINDOW_DAYS\s*=\s*\d/)
    expect(source).toContain('loadSharedConstant("lib/guest-claim.ts", "MAX_CODE_ATTEMPTS")')
    expect(source).toContain('loadSharedConstant("lib/courier-ladder.ts", "BUFFER_WINDOW_DAYS")')
  })

  it("refuses to start on a shared figure it cannot read as exactly one definition", async () => {
    const { mod } = await load()
    const parse = mod.parseSharedConstant
    expect(parse("export const MAX_CODE_ATTEMPTS = 5\n", "MAX_CODE_ATTEMPTS", "f.ts")).toBe(5)
    expect(parse("export const MAX_CODE_ATTEMPTS = 5\r\nconst x = MAX_CODE_ATTEMPTS === 5\r\n", "MAX_CODE_ATTEMPTS", "f.ts")).toBe(5)
    expect(() => parse("const OTHER = 5\n", "MAX_CODE_ATTEMPTS", "f.ts")).toThrow(/exactly one/)
    expect(() => parse("export const MAX_CODE_ATTEMPTS = 5\nexport const MAX_CODE_ATTEMPTS = 6\n", "MAX_CODE_ATTEMPTS", "f.ts")).toThrow(/found 2/)
    expect(() => parse("export const MAX_CODE_ATTEMPTS = 5\nMAX_CODE_ATTEMPTS = 6\n", "MAX_CODE_ATTEMPTS", "f.ts")).toThrow(/2 assignment/)
    expect(() => parse("export const MAX_CODE_ATTEMPTS = Number(5)\n", "MAX_CODE_ATTEMPTS", "f.ts")).toThrow(/f\.ts/)
  })

  it("requires P14's two columns, all nine of P15's and P18's two", async () => {
    const { mod } = await load()
    const guest: string[] = mod.REQUIRED_COLUMNS.guest_jobs_dispatch
    expect(guest.slice(-2)).toEqual(["assigned_courier_id", "declared_value_cedis"])
    expect(mod.REQUIRED_COLUMNS.courier_registry_dispatch).toEqual([
      "courier_ref", "class", "status", "buffer_since",
      "piverify_status", "piverify_status_at", "paused_reason", "shredded_at",
      "piverify_allowed_action", "operator_checked_at", "operator_check_deadline",
    ])
  })

  it("a missing P14 column fails the preflight, and the failure names P14", async () => {
    const { mod } = await load()
    const required = mod.REQUIRED_COLUMNS as Record<string, string[]>
    const visible = Object.entries(required).flatMap(([table_name, cols]) =>
      cols.filter((c) => c !== "assigned_courier_id").map((column_name) => ({ table_name, column_name }))
    )
    const sent: string[] = []
    const client = { query: async (sql: string) => { sent.push(sql); return { rows: visible } } }
    const { missing } = await mod.preflight(client)
    expect(missing).toEqual(["guest_jobs_dispatch.assigned_courier_id"])
    expect(sent).toEqual([mod.buildPreflightSql()])
    expect(sent[0]).toContain("'courier_registry_dispatch'")

    const text = mod.describePreflightFailure(missing).join("\n")
    expect(text).toContain("PREFLIGHT FAILED, no section was run")
    expect(text).toContain("2026-10-09_dispatch_view_courier_id.sql (P14)")
    expect(text).toContain("    guest_jobs_dispatch.assigned_courier_id")
    expect(text).not.toContain("(P15)")
  })

  it("a missing P15 view fails the preflight on all eleven columns, and names P15 and P18", async () => {
    const { mod } = await load()
    const required = mod.REQUIRED_COLUMNS as Record<string, string[]>
    const visible = Object.entries(required)
      .filter(([t]) => t !== "courier_registry_dispatch")
      .flatMap(([table_name, cols]) => cols.map((column_name) => ({ table_name, column_name })))
    const { missing } = await mod.preflight({ query: async () => ({ rows: visible }) })
    expect(missing).toHaveLength(11)
    expect(missing.every((m: string) => m.startsWith("courier_registry_dispatch."))).toBe(true)
    const text = mod.describePreflightFailure(missing).join("\n")
    expect(text).toContain("2026-10-10_courier_registry_dispatch_view.sql (P15)")
    expect(text).toContain("2026-10-12_courier_operator_check.sql (P18)")
    expect(text).not.toContain("(P14)")
    expect(text).toContain("Expect exactly three rows")
  })

  it("check 0.5 is keyed on either assignment column: Pioneer and legacy match, unassigned does not", async () => {
    const { byId } = await load()
    const where = byId("0.5").where
    expect(matches(where, pioneerJob)).toBe(true)
    expect(matches(where, legacyJob)).toBe(true)
    expect(matches(where, noValueJob)).toBe(true)
    expect(matches(where, unassignedJob)).toBe(false)
    // A commission recorded, or a job older than the window, leaves the check.
    expect(matches(where, { ...legacyJob, remit_cedis: "3.00" })).toBe(false)
    expect(matches(where, { ...legacyJob, created_at: "2026-09-01T10:00:00Z" })).toBe(false)
    expect(matches(where, { ...pioneerJob, remit_cedis: "3.00" })).toBe(false)
  })

  it("check 0.5 names a legacy courier by reference, never as (null)", async () => {
    const { mod, byId } = await load()
    const ctx = { registry: mod.indexCourierRegistry(REGISTRY_ROWS) }
    const legacy = byId("0.5").render(legacyJob, ctx)
    expect(legacy.flags[0]).toContain("assigned to courier_ref 1a2b3c4d, class legacy")
    expect(legacy.flags[0]).not.toContain("(null)")
    expect(byId("0.5").render(pioneerJob, ctx).flags[0]).toContain("assigned to ama_b")
  })

  it("every guest section shows a Pioneer, a legacy and an unassigned job by the right courier field", async () => {
    const { mod, all } = await load()
    const ctx = { registry: mod.indexCourierRegistry(REGISTRY_ROWS) }
    const guest = all.filter((s) => s.table === "public.guest_jobs_dispatch" && s.columns.includes("assigned_courier"))
    expect(guest.map((s) => String(s.id))).toEqual(["3", "4", "5", "6", "7", "8", "8b", "0.3", "0.4", "0.5"])
    for (const s of guest) {
      expect(s.columns, `section ${s.id}`).toContain("assigned_courier_id")

      const p = s.render(pioneerJob, ctx)
      expect(field(p, "assigned_courier"), `section ${s.id}`).toBe("ama_b")
      expect(field(p, "courier_ref"), `section ${s.id}`).toBe("9f8e7d6c, class pioneer, status full")

      const l = s.render(legacyJob, ctx)
      expect(field(l, "assigned_courier"), `section ${s.id}`).toBe("(null)")
      expect(field(l, "courier_ref"), `section ${s.id}`).toBe("1a2b3c4d, class legacy, status full")

      const u = s.render(unassignedJob, ctx)
      expect(field(u, "assigned_courier"), `section ${s.id}`).toBe("(null)")
      expect(field(u, "courier_ref"), `section ${s.id}`).toBe("(null, no assigned_courier_id)")

      // The full id is read to find the registry row and never printed.
      for (const view of [p, l, u]) {
        const text = JSON.stringify(view)
        expect(text, `section ${s.id}`).not.toContain(LEGACY_ID)
        expect(text, `section ${s.id}`).not.toContain(PIONEER_ID)
        expect(text, `section ${s.id}`).not.toContain("-0000-4000-")
      }
    }
  })

  it("a reference shows only what courier_registry_dispatch holds, and says so when it cannot", async () => {
    const { mod } = await load()
    const ref = mod.courierRef
    expect(ref(legacyJob, undefined)).toBe("(courier registry not read)")
    expect(ref(legacyJob, mod.indexCourierRegistry([]))).toBe("(no courier_registry_dispatch row carries this job's reference)")
    const twice = mod.indexCourierRegistry([...REGISTRY_ROWS, { courier_ref: "1a2b3c4d", class: "pioneer", status: "buffer" }])
    expect(ref(legacyJob, twice)).toBe("1a2b3c4d, ambiguous: 2 courier_registry_dispatch rows share this reference")
    // An upper case id still finds its lower case reference.
    expect(ref({ assigned_courier_id: LEGACY_ID.toUpperCase() }, mod.indexCourierRegistry(REGISTRY_ROWS))).toBe(
      "1a2b3c4d, class legacy, status full"
    )
  })

  it("reads the references through the masked view, as one lone SELECT", async () => {
    const { mod } = await load()
    const sent: string[] = []
    const client = { query: async (sql: string) => { sent.push(sql); return { rows: REGISTRY_ROWS } } }
    const registry = await mod.readCourierRegistry(client)
    expect(sent).toEqual([mod.buildSql(mod.COURIER_REGISTRY_LOOKUP)])
    expect(sent[0]).toContain("from public.courier_registry_dispatch")
    expect(mod.COURIER_REGISTRY_LOOKUP.columns).toEqual(["courier_ref", "class", "status"])
    expect(registry.get("1a2b3c4d")).toEqual([REGISTRY_ROWS[0]])
  })

  it("sections 1 to 6 show the declared value, and a job with none says so", async () => {
    const { mod, all, byId } = await load()
    const ctx = { registry: mod.indexCourierRegistry(REGISTRY_ROWS) }
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const s = byId(id)
      expect(s.columns, `section ${id}`).toContain("declared_value_cedis")
      expect(field(s.render(legacyJob, ctx), "declared_value_cedis"), `section ${id}`).toBe("80")
      expect(field(s.render({ ...legacyJob, declared_value_cedis: 0 }, ctx), "declared_value_cedis"), `section ${id}`).toBe("0")
      expect(field(s.render(noValueJob, ctx), "declared_value_cedis"), `section ${id}`).toBe("(null, no value declared)")
    }
    // No footer anywhere prints or sums it.
    const valued = [{ ...legacyJob, declared_value_cedis: 377 }, { ...pioneerJob, declared_value_cedis: 211 }, noValueJob]
    for (const s of all) {
      if (!s.footer) continue
      const text = s.footer(valued).join("\n")
      for (const figure of ["377", "211", "588"]) expect(text, `section ${s.id}`).not.toContain(figure)
    }
  })

  it("section 10 lists buffer couriers at or past the window, and those with no buffer_since", async () => {
    const { mod, byId } = await load()
    const s = byId(10)
    expect(s.table).toBe("public.courier_registry_dispatch")
    expect(s.where).toBe(
      `status = 'buffer' and shredded_at is null and buffer_since <= now() - interval '${mod.BUFFER_WINDOW_DAYS} days' and buffer_since is distinct from operator_checked_at or status = 'buffer' and shredded_at is null and buffer_since is null`
    )
    expect(s.render({ courier_ref: "1a2b3c4d", buffer_since_txt: null }).flags[0]).toMatch(/no buffer_since/)
    expect(s.render({ courier_ref: "1a2b3c4d", buffer_since_txt: "2026-09-01 10:00" }).flags[0]).toMatch(/past the 30 day/)
  })

  it("section 11 lists stale unsettled sessions, a rejection only while it carries an allowed action", async () => {
    const { byId } = await load()
    const s = byId(11)
    expect(s.table).toBe("public.courier_registry_dispatch")
    expect(s.where).toBe(
      "piverify_status in ('created', 'started', 'pending_review') and shredded_at is null and piverify_status_at <= now() - interval '24 hours'"
        + " or piverify_status = 'rejected' and piverify_allowed_action is not null and shredded_at is null and piverify_status_at <= now() - interval '24 hours'"
    )
    expect(s.columns).toContain("piverify_allowed_action")
  })

  it("section 11 matches isUnsettled in app/courier/courier-panel.tsx, row for row", async () => {
    const { byId } = await load()
    const s = byId(11)
    const STALE = "2026-10-10T11:00:00Z"
    const row = (piverify_status: string, piverify_allowed_action: string | null, extra: Record<string, unknown> = {}) => ({
      piverify_status, piverify_allowed_action, shredded_at: null, piverify_status_at: STALE, ...extra,
    })
    for (const status of ["created", "started", "pending_review"]) {
      expect(matches(s.where, row(status, null)), status).toBe(true)
    }
    expect(matches(s.where, row("rejected", "RESUBMIT"))).toBe(true)
    expect(matches(s.where, row("rejected", "APPEAL"))).toBe(true)
    // A rejection with no allowed action is final: settled, never listed.
    expect(matches(s.where, row("rejected", null))).toBe(false)
    for (const status of ["approved", "failed"]) {
      expect(matches(s.where, row(status, null)), status).toBe(false)
    }
    // Shredded, or touched inside 24 hours, leaves the list on either arm.
    expect(matches(s.where, row("rejected", "RESUBMIT", { shredded_at: STALE }))).toBe(false)
    expect(matches(s.where, row("started", null, { shredded_at: STALE }))).toBe(false)
    expect(matches(s.where, row("rejected", "RESUBMIT", { piverify_status_at: "2026-10-11T00:00:00Z" }))).toBe(false)
    expect(matches(s.where, row("started", null, { piverify_status_at: "2026-10-11T00:00:00Z" }))).toBe(false)

    const listed = s.render({ piverify_status: "rejected", piverify_allowed_action: "APPEAL" })
    expect(listed.flags).toEqual([])
    expect(field(listed, "piverify_allowed_action")).toBe("APPEAL")
    expect(s.render({ piverify_status: "started", piverify_allowed_action: null }).flags).toEqual([])

    const lines = s.footer!([
      { piverify_status: "created" }, { piverify_status: "pending_review" },
      { piverify_status: "rejected", piverify_allowed_action: "RESUBMIT" },
    ])
    expect(lines).toEqual([
      "  buckets, counted from the rows above:",
      "    unsettled, created or started or pending_review, or rejected with an allowed action: 3 row(s)",
    ])
    expect(lines.join("\n")).not.toMatch(/cannot tell/i)
  })

  it("the dry run accepts every statement, the lookup and both courier sections included", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "1",
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("20 statements, each checked by the read only guard.")
    expect(res.stdout).not.toContain("GUARD REJECTED")
    expect(res.stdout).toContain("courier reference lookup")
    expect(res.stdout).toContain("section 10, BUFFER COURIERS DUE A HAND PAUSE")
    expect(res.stdout).toContain("section 11, PIVERIFY SESSIONS UNTOUCHED FOR 24h")
  })
})

// ---------------------------------------------------------------------------
// Item 10 (notes 10.8): section 10's new clause and section 12
// ---------------------------------------------------------------------------

describe("item 10: operator-checked couriers in the reader", () => {
  type Row = Record<string, unknown>
  type Sec = {
    id: string | number
    title: string
    table: string
    where: string
    order: string
    columns: string[]
    footer?: (rows: Row[]) => string[]
    render: (row: Row, ctx?: { rows?: Row[] }) => { flags: string[]; fields: [string, string][] }
  }
  const NOW = Date.parse("2026-10-12T12:00:00Z")
  const DAY = 24 * 60 * 60 * 1000

  async function section(id: number): Promise<{ mod: Record<string, any>; s: Sec }> {
    const mod = await import("../scripts/dispatch-reader.mjs")
    return { mod, s: (mod.SECTIONS as unknown as Sec[]).find((x) => x.id === id)! }
  }

  // The terms sections 10 and 12 use, as SQL reads them; anything else throws.
  function matches(where: string, row: Row): boolean {
    const present = (v: unknown) => v !== null && v !== undefined
    const term = (t: string): boolean => {
      let m = t.match(/^([a-z_]+) = '([^']*)'$/)
      if (m) return row[m[1]] === m[2]
      m = t.match(/^([a-z_]+) <> '([^']*)'$/)
      if (m) return present(row[m[1]]) && row[m[1]] !== m[2]
      m = t.match(/^([a-z_]+) is not null$/)
      if (m) return present(row[m[1]])
      m = t.match(/^([a-z_]+) is null$/)
      if (m) return !present(row[m[1]])
      m = t.match(/^([a-z_]+) is distinct from ([a-z_]+)$/)
      if (m) return (row[m[1]] ?? null) !== (row[m[2]] ?? null)
      m = t.match(/^([a-z_]+) <= now\(\) - interval '(\d+) days'$/)
      if (m) return present(row[m[1]]) && Date.parse(String(row[m[1]])) <= NOW - Number(m[2]) * DAY
      throw new Error(`unrecognised term: ${t}`)
    }
    return where.split(" or ").some((arm) => arm.split(" and ").every((t) => term(t.trim())))
  }

  const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

  it("section 10 leaves out a courier in buffer through the check, at any age", async () => {
    const { s } = await section(10)
    const t = ago(40)
    expect(matches(s.where, { status: "buffer", shredded_at: null, buffer_since: t, operator_checked_at: t })).toBe(false)
    // An ordinary buffer courier at 40 days is listed, as before.
    expect(matches(s.where, { status: "buffer", shredded_at: null, buffer_since: t, operator_checked_at: null })).toBe(true)
    // A checked courier back through PiVerify, its own clock 40 days old: listed.
    expect(matches(s.where, { status: "buffer", shredded_at: null, buffer_since: t, operator_checked_at: ago(60) })).toBe(true)
    // The no-clock arm is unchanged, and still lists a checked row with no clock.
    expect(matches(s.where, { status: "buffer", shredded_at: null, buffer_since: null, operator_checked_at: ago(5) })).toBe(true)
  })

  it("section 12 lists checked couriers not shredded and not full, from the masked view", async () => {
    const { mod, s } = await section(12)
    expect(s.title).toBe("OPERATOR-CHECKED COURIERS")
    expect(s.table).toBe("public.courier_registry_dispatch")
    expect(s.where).toBe("operator_checked_at is not null and shredded_at is null and status <> 'full'")
    const checked = { operator_checked_at: ago(3), shredded_at: null }
    for (const status of ["buffer", "paused", "registered"]) expect(matches(s.where, { ...checked, status }), status).toBe(true)
    expect(matches(s.where, { ...checked, status: "full" })).toBe(false)
    expect(matches(s.where, { ...checked, status: "buffer", shredded_at: ago(1) })).toBe(false)
    expect(matches(s.where, { operator_checked_at: null, shredded_at: null, status: "buffer" })).toBe(false)
    expect(() => mod.assertReadOnlySql(mod.buildSql(s))).not.toThrow()
    expect(mod.buildSql(s)).not.toContain("operator_checked_by")
  })

  it("section 12 flags: no deadline yet, past the deadline, through PiVerify, and the alarm", async () => {
    const { s } = await section(12)
    const base = { courier_ref: "1a2b3c4d", class: "legacy", status: "buffer", through_check: true, past_deadline: null }
    const none = { ...base, operator_check_deadline_txt: null }
    const due = { ...base, operator_check_deadline_txt: "2026-10-11 12:00", past_deadline: true }
    const ahead = { ...base, operator_check_deadline_txt: "2026-11-11 12:00", past_deadline: false }

    expect(s.render(none, { rows: [none] }).flags).toEqual(["no deadline yet: the sunset has not started"])
    expect(s.render(ahead, { rows: [ahead] }).flags).toEqual([])
    expect(s.render(due, { rows: [due] }).flags).toEqual([
      "past the sunset deadline with status still buffer: the ladder refuses this courier every job; due a hand pause, paused_reason pending_timeout",
    ])
    expect(s.render({ ...ahead, through_check: false }, { rows: [ahead] }).flags).toEqual([
      "in buffer through PiVerify, not the check: on the 30-day rule, section 10",
    ])
    // A paused courier past the deadline is not due a pause.
    expect(s.render({ ...due, status: "paused" }, { rows: [due] }).flags).toEqual([])
    // The alarm: no deadline while another listed courier has one.
    expect(s.render(none, { rows: [none, ahead] }).flags[0]).toMatch(/^ALARM: no deadline while another checked courier has one/)
    // A null past_deadline or through_check is no evidence, never a flag.
    expect(s.render({ ...due, past_deadline: null }, { rows: [due] }).flags).toEqual([])
  })

  it("section 12's footer counts what it printed, the alarm included", async () => {
    const { s } = await section(12)
    const rows = [
      { status: "buffer", through_check: true, past_deadline: true, operator_check_deadline_txt: "2026-10-11 12:00" },
      { status: "buffer", through_check: true, past_deadline: false, operator_check_deadline_txt: "2026-11-11 12:00" },
      { status: "paused", through_check: false, past_deadline: null, operator_check_deadline_txt: null },
    ]
    expect(s.footer!(rows)).toEqual([
      "  buckets, counted from the rows above:",
      "    with a sunset deadline: 2 row(s)",
      "    past the deadline, still buffer, due a hand pause: 1 row(s)",
      "    ALARM, no deadline while another has one: 1 row(s)",
    ])
    expect(s.footer!([rows[2]])).toContain("    ALARM, no deadline while another has one: 0 row(s)")
  })

  it("never shows operator_checked_by, and every row is rendered with its section's rows", async () => {
    const { mod } = await section(12)
    expect(mod.REQUIRED_COLUMNS.courier_registry_dispatch).not.toContain("operator_checked_by")
    for (const s of [...mod.SECTIONS, ...mod.CHECKS] as Sec[]) expect(s.columns.join(" "), String(s.id)).not.toContain("operator_checked_by")
    const src = readFileSync(SCRIPT, "utf8")
    expect(src).toContain("const rowCtx = { ...ctx, rows }")
    expect(src).toContain("alerts += printRow(section, row, rowCtx).flags.length")
  })

  it("a missing P18 column fails the preflight, naming P18", async () => {
    const { mod } = await section(12)
    const required = mod.REQUIRED_COLUMNS as Record<string, string[]>
    const visible = Object.entries(required).flatMap(([table_name, cols]) =>
      cols.filter((c) => c !== "operator_check_deadline").map((column_name) => ({ table_name, column_name }))
    )
    const { missing } = await mod.preflight({ query: async () => ({ rows: visible }) })
    expect(missing).toEqual(["courier_registry_dispatch.operator_check_deadline"])
    expect(mod.describePreflightFailure(missing).join("\n")).toContain("2026-10-12_courier_operator_check.sql (P18)")
  })
})

// ---------------------------------------------------------------------------
// Reader fixes, 12 Oct 2026 (item 10 build, commit 5)
// ---------------------------------------------------------------------------

describe("reader fixes: variables come from the shell, not a file", () => {
  it("the header and the missing-variable message no longer say .env.local is loaded", async () => {
    const source = readFileSync(SCRIPT, "utf8")
    expect(source).not.toMatch(/belongs in a\s*\n\/\/ gitignored \.env\.local/)
    expect(source).not.toContain("in a gitignored .env.local or in the shell")
    expect(source).toContain("nothing loads .env.local or any other file")
    expect(source).not.toMatch(/import [^\n]*dotenv|require\(["']dotenv|--env-file/)
    const res = await runReader({ GYEMA_READER_DATABASE_URL: "", GYEMA_READER_CA_CERT: "", GYEMA_DISPATCH_DRY_RUN: "" })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("Set it in")
    expect(res.stderr).toContain("the shell this script runs in: nothing loads .env.local or any other file.")
  })
})

describe("reader fixes: check 0.2 reads the GuestJobStatus union", () => {
  // Typed against the union, so tsc fails here if a status is added to or
  // removed from lib/guest-jobs.ts and this list is not changed with it.
  const UNION: Record<GuestJobStatus, true> = {
    posted: true,
    pending_quote: true,
    accepted: true,
    in_transit: true,
    delivered: true,
    cancelled: true,
    expired: true,
  }

  it("DECLARED_GUEST_STATUSES equals the union, pending_quote included", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    expect([...mod.DECLARED_GUEST_STATUSES].sort()).toEqual(Object.keys(UNION).sort())
    expect(mod.DECLARED_GUEST_STATUSES).toContain("pending_quote")
  })

  it("is read from lib/guest-jobs.ts, with no copy kept in the script", async () => {
    const source = readFileSync(SCRIPT, "utf8")
    expect(source).toContain('const DECLARED_GUEST_STATUSES = loadStatusUnion("lib/guest-jobs.ts")')
    expect(source).not.toMatch(/DECLARED_GUEST_STATUSES = \[/)
    expect(source).not.toContain("which the union does not carry")
  })

  it("refuses to start on a union it cannot read", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    const parse = mod.parseStatusUnion
    expect(parse('export type GuestJobStatus =\n  | "posted"\n  | "expired"\n', "f.ts")).toEqual(["posted", "expired"])
    expect(parse('export type GuestJobStatus =\r\n  | "posted"\r\n  | "expired"\r\n', "f.ts")).toEqual(["posted", "expired"])
    expect(() => parse("", "f.ts")).toThrow(/found 0/)
    expect(() => parse('export type GuestJobStatus =\n  | "a"\nexport type GuestJobStatus =\n  | "b"\n', "f.ts")).toThrow(/found 2/)
    expect(() => parse("export type GuestJobStatus =\n  string\n", "f.ts")).toThrow(/no \| "value" lines/)
    expect(() => parse('export type GuestJobStatus =\n  | "a"\n  | "a"\n', "f.ts")).toThrow(/twice/)
  })

  it("the where clause carries all seven, so a pending_quote row is not a finding", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    const check = (mod.CHECKS as Array<{ id: string; where: string }>).find((c) => c.id === "0.2")!
    for (const status of Object.keys(UNION)) expect(check.where).toContain(`'${status}'`)
  })
})

describe("reader fixes: no ssl parameter in the connection string", () => {
  for (const query of ["sslmode=disable", "sslmode=no-verify", "sslmode=require", "ssl=true", "SSLMode=verify-full", "sslrootcert=/x", "uselibpqcompat=true&sslmode=require"]) {
    it(`refuses ?${query} before reading the CA, naming the parameter and never printing the URL`, async () => {
      const url = `${UNROUTABLE}?${query}`
      const res = await runReader({ GYEMA_READER_DATABASE_URL: url, GYEMA_READER_CA_CERT: "", GYEMA_DISPATCH_DRY_RUN: "" })
      expect(res.code).toBe(1)
      expect(res.stderr).toContain("refused: GYEMA_READER_DATABASE_URL carries")
      const names = query.split("&").map((q) => q.split("=")[0].toLowerCase())
      for (const n of names) expect(res.stderr).toContain(n)
      expect(res.stderr + res.stdout).not.toContain("not-a-real-password")
      expect(res.stderr + res.stdout).not.toContain("no-such-host.invalid")
      expect(res.stderr).not.toContain("GYEMA_READER_CA_CERT is not set")
    })
  }

  it("lists the parameter names only, lower case, once each", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    expect(mod.sslParametersIn("postgres://u:p@h/db?sslmode=disable&SSL=1&sslmode=x&application_name=a")).toEqual(["sslmode", "ssl"])
    expect(mod.sslParametersIn("postgres://u:p@h/db?application_name=a")).toEqual([])
    expect(mod.sslParametersIn("not a url")).toBeNull()
  })
})

describe("reader fixes: the network guard", () => {
  it("requires GYEMA_READER_EXPECTED_REF", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_EXPECTED_REF: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("refused: GYEMA_READER_EXPECTED_REF is not set.")
    expect(res.stderr).not.toContain("not-a-real-password")
  })

  it("refuses a URL naming another project, before the CA is read", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_EXPECTED_REF: "zyxwvutsrqponmlkjihg",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain(`the connection string names project ${REF}, and GYEMA_READER_EXPECTED_REF says zyxwvutsrqponmlkjihg.`)
    expect(res.stderr).not.toContain("GYEMA_READER_CA_CERT is not set")
    expect(res.stderr).not.toContain("not-a-real-password")
  })

  it("refuses a user that carries no ref", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "postgres://gyema_reader:pw@no-such-host.invalid:5432/postgres",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("is not gyema_reader.<project_ref>")
  })

  it("matches exactly: no trimming, no case folding, no prefix", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    const check = mod.checkExpectedRef
    expect(check(UNROUTABLE, REF)).toEqual({ ok: true, ref: REF })
    for (const bad of [` ${REF}`, `${REF} `, REF.toUpperCase(), REF.slice(0, 10), `${REF}x`]) {
      expect(check(UNROUTABLE, bad).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(check(`postgres://gyema_reader.${REF}x:p@h/db`, REF).ok).toBe(false)
    expect(check(`postgres://other_role.${REF}:p@h/db`, REF).ok).toBe(false)
    expect(mod.projectRefFromUrl(`postgres://gyema_reader.${REF}:p@h/db`)).toBe(REF)
    expect(mod.projectRefFromUrl("not a url")).toBeNull()
  })

  it("prints the ref in the header, and the header no longer says the reader reads one network", async () => {
    const source = readFileSync(SCRIPT, "utf8")
    expect(source).toContain('console.log(field("project ref", `${network.ref} (matches GYEMA_READER_EXPECTED_REF)`))')
    expect(source).not.toContain("It reads Testnet")
    // The guards run before the CA is read, and before any connection.
    const main = source.slice(source.indexOf("async function main()"))
    expect(main.indexOf("sslParametersIn(rawUrl)")).toBeLessThan(main.indexOf("process.env.GYEMA_READER_CA_CERT"))
    expect(main.indexOf("checkExpectedRef(rawUrl")).toBeLessThan(main.indexOf("process.env.GYEMA_READER_CA_CERT"))
    expect(main.indexOf("checkExpectedRef(rawUrl")).toBeLessThan(main.indexOf("client.connect()"))
  })
})

describe("reader fixes: section 3's subtitle", () => {
  it("says create writes posted for a listed job and pending_quote for an off-list one", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    const s3 = (mod.SECTIONS as Array<{ id: number; subtitle: string }>).find((s) => s.id === 3)!
    expect(s3.subtitle).toContain("a job with both areas on the list as status posted and an off-list one as pending_quote")
    expect(s3.subtitle).not.toContain("writes status posted with phone_verified false on the same insert")
    const route = readFileSync("app/api/guest/create/route.ts", "utf8")
    expect(route).toContain('status: offList ? "pending_quote" : "posted",')
  })
})
