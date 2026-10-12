import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { BUFFER_WINDOW_DAYS, effectiveTier, throughOperatorCheck } from "@/lib/courier-ladder"
import { piverifyEnabled } from "@/lib/piverify"
import {
  OPERATOR_CHECK_DEADLINE_TEMPLATE,
  OPERATOR_CHECK_ENDED_LINE,
  OPERATOR_CHECK_LINE,
  PIVERIFY_NOT_OPEN_LINE,
  formatDeadlineDate,
  operatorCheckLines,
  showPiverifyNotOpen,
  type CourierKycView,
} from "@/app/courier/courier-view"

// Item 10 (docs/anchoring-phase1-notes.md 10.2 to 10.9): the operator-checked
// buffer. P18 is pinned as text, in the style of
// tests/piverify-webhook-guards.test.ts; its behaviour is probed against a
// throwaway postgres by db/probes/2026-10-12_operator_check/run.sh. The
// ladder, the switch and the page logic are pure and tested directly.

const P18_PATH = "db/migrations/2026-10-12_courier_operator_check.sql"
const P12_PATH = "db/migrations/2026-10-08_courier_piverify_bind.sql"
const P15_PATH = "db/migrations/2026-10-10_courier_registry_dispatch_view.sql"

/** A migration with its -- comment lines removed, so only code is pinned. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}

/** The body of one function, from its CREATE to its closing $$. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf("$$;", start) + 3)
}

const p18 = code(P18_PATH)
const check = fn(p18, "courier_record_operator_check")
const sunset = fn(p18, "courier_start_operator_check_sunset")
const bind18 = fn(p18, "courier_bind_piverify_session")
const bind12 = fn(code(P12_PATH), "courier_bind_piverify_session")

// ---------------------------------------------------------------------------
// P18, the schema
// ---------------------------------------------------------------------------

describe("P18: the columns and the four checks (10.2)", () => {
  it("adds the three columns, all nullable, with add column if not exists", () => {
    expect(p18).toContain("add column if not exists operator_checked_at timestamptz null;")
    expect(p18).toContain("add column if not exists operator_checked_by text null;")
    expect(p18).toContain("add column if not exists operator_check_deadline timestamptz null;")
  })

  it("names each check and guards it on pg_constraint by name", () => {
    const checks: Array<[string, string]> = [
      ["courier_registry_operator_checked_legacy_only_check", "check (operator_checked_at is null or class = 'legacy');"],
      ["courier_registry_operator_check_pair_check", "check ((operator_checked_at is null) = (operator_checked_by is null));"],
      ["courier_registry_operator_checked_by_check", "check (operator_checked_by is null or operator_checked_by in ('founder'));"],
      ["courier_registry_operator_check_deadline_check", "check (operator_check_deadline is null or operator_checked_at is not null);"],
    ]
    for (const [name, def] of checks) {
      expect(p18, name).toMatch(new RegExp(`conname = '${name}'\\) then\\s+alter table public\\.courier_registry\\s+add constraint ${name}\\s+${def.replace(/[()]/g, "\\$&")}`))
    }
  })

  it("founder is the only allowed operator_checked_by (decision 7)", () => {
    expect(p18.match(/operator_checked_by in \(([^)]*)\)/)![1]).toBe("'founder'")
    expect(check).toContain("if p_checked_by is null or p_checked_by not in ('founder') then")
  })
})

describe("P18: the guard (section 1)", () => {
  it("stops the file before any write if P2, P9, P11, P12, P13, P15 or P17 is missing", () => {
    const guard = p18.slice(p18.indexOf("do $$"), p18.indexOf("$$;") + 3)
    for (const p of ["P2", "P9", "P11", "P12", "P13", "P15", "P17"]) {
      expect(guard, p).toContain(`Apply ${p} first. Stop.`)
    }
    // The guard is the first statement: nothing is altered or created before it.
    const firstWrite = p18.search(/alter table|create or replace|revoke|grant/)
    expect(p18.indexOf("do $$")).toBeLessThan(firstWrite)
  })

  it("accepts the view in its P15 shape or the shape P18 leaves, and nothing else", () => {
    expect(p18).toContain("v_p18    text[] := v_p15 || array['operator_checked_at', 'operator_check_deadline'];")
    expect(p18).toContain("if v_live is distinct from v_p15 and v_live is distinct from v_p18 then")
  })

  it("ends with the all_present verification as its last statement", () => {
    const trimmed = p18.trimEnd()
    expect(trimmed.endsWith(")) as courier_operator_check_verification;")).toBe(true)
    expect(p18.slice(p18.lastIndexOf("\nwith\n"))).toContain("'all_present', (select bool_and(present) from rows)")
  })
})

// ---------------------------------------------------------------------------
// P18, courier_record_operator_check (10.3)
// ---------------------------------------------------------------------------

describe("P18: courier_record_operator_check", () => {
  const body = check.slice(check.indexOf("begin\n"))

  it("takes the advisory lock as its first statement, then locks the courier row", () => {
    expect(body).toMatch(/^begin\n\s+perform pg_advisory_xact_lock\(20261012\);\n/)
    const lock = body.indexOf("pg_advisory_xact_lock(20261012)")
    const rowLock = body.indexOf("for update;")
    expect(rowLock).toBeGreaterThan(lock)
    expect(body.indexOf("select * into v_courier from public.courier_registry r")).toBeLessThan(rowLock)
  })

  it("checks guards 1 to 11 in the designed order, after the row lock and before the one UPDATE", () => {
    const order = [
      "bad_checked_by",
      "unknown_courier",
      ": shredded'",
      "not_legacy",
      "'already_checked'",
      "sunset_started",
      "not_registered",
      ": paused'",
      "already_approved",
      "piverify_refused",
      "never_signed_in",
    ]
    const at = order.map((w) => body.indexOf(w))
    for (let i = 0; i < order.length; i++) expect(at[i], order[i]).toBeGreaterThan(-1)
    for (let i = 1; i < order.length; i++) expect(at[i], `${order[i - 1]} before ${order[i]}`).toBeGreaterThan(at[i - 1])
    expect(at[0]).toBeGreaterThan(body.indexOf("for update;"))
    const update = body.indexOf("update public.courier_registry r")
    expect(update).toBeGreaterThan(at[at.length - 1])
    expect(body.match(/update public\.courier_registry/g)).toHaveLength(1)
  })

  it("raises each refusal with its SQLSTATE, the message ending in its code word", () => {
    const expected: Array<[string, string]> = [
      ["bad_checked_by", "22023"],
      ["unknown_courier", "P0002"],
      ["shredded", "55000"],
      ["not_legacy", "55000"],
      ["sunset_started", "55000"],
      ["not_registered", "55000"],
      ["paused", "55000"],
      ["already_approved", "55000"],
      ["piverify_refused", "55000"],
      ["never_signed_in", "55000"],
    ]
    for (const [word, state] of expected) {
      expect(body, word).toMatch(new RegExp(`raise exception 'courier_record_operator_check: [^']*(?:''[^']*)*: ${word}'[^;]*\\s+using errcode = '${state}';`))
    }
  })

  it("guard 6 reads the sunset as started from the rows: any operator_check_deadline set", () => {
    expect(body).toMatch(/if exists \(select 1 from public\.courier_registry r\s+where r\.operator_check_deadline is not null\) then\s+raise exception '[^']*sunset_started'/)
  })

  it("guard 10 refuses a current session that is rejected or failed (decision 5)", () => {
    expect(body).toContain("if v_courier.piverify_status in ('rejected', 'failed') then")
  })

  it("guard 11 reads courier_sessions by courier_id and locks nothing in it (decision 11)", () => {
    expect(body).toMatch(/if not exists \(select 1 from public\.courier_sessions s\s+where s\.courier_id = v_courier\.id\) then/)
    expect(body).not.toMatch(/courier_sessions[^;]*for update/)
    expect(body.match(/for update/g)).toHaveLength(1)
  })

  it("the re-run branch returns already_checked before sunset_started and before the status guard, writing nothing", () => {
    const rerun = body.indexOf("if v_courier.operator_checked_at is not null then")
    expect(rerun).toBeGreaterThan(-1)
    expect(rerun).toBeLessThan(body.indexOf("sunset_started"))
    expect(rerun).toBeLessThan(body.indexOf("if v_courier.status <> 'registered' then"))
    const branch = body.slice(rerun, body.indexOf("end if;", rerun))
    expect(branch).toContain("'already_checked'::text")
    expect(branch).toContain("return;")
    expect(branch).not.toMatch(/update|insert/)
  })

  it("the UPDATE writes exactly the five columns, buffer_since and operator_checked_at from one now()", () => {
    const update = body.slice(body.indexOf("update public.courier_registry r"), body.indexOf("returning", body.indexOf("update public.courier_registry r")))
    const set = [...update.matchAll(/^\s+(?:set\s+)?([a-z_]+)\s+= ([^,\n]+),?$/gm)].map((m) => [m[1], m[2].trim()])
    expect(set).toEqual([
      ["status", "'buffer'"],
      ["buffer_since", "now()"],
      ["operator_checked_at", "now()"],
      ["operator_checked_by", "p_checked_by"],
      ["updated_at", "now()"],
    ])
    expect(update).toContain("where r.id = v_courier.id")
  })

  it("returns the row it wrote, with RETURNING (invariant 8)", () => {
    expect(body).toContain("returning r.id, r.status, r.buffer_since, r.operator_checked_at")
    expect(body).toContain("return query select v_id, 'checked'::text, v_status, v_since, v_checked;")
  })
})

// ---------------------------------------------------------------------------
// P18, courier_start_operator_check_sunset (10.6)
// ---------------------------------------------------------------------------

describe("P18: courier_start_operator_check_sunset", () => {
  const body = sunset.slice(sunset.indexOf("begin\n"))

  it("has no parameter (decision 1)", () => {
    expect(sunset).toMatch(/^create or replace function public\.courier_start_operator_check_sunset\(\)\n/)
    expect(p18).not.toMatch(/courier_start_operator_check_sunset\([^)]/)
  })

  it("takes the same advisory lock key as the check, as its first statement", () => {
    expect(body).toMatch(/^begin\n\s+perform pg_advisory_xact_lock\(20261012\);\n/)
    expect(p18.match(/pg_advisory_xact_lock\((\d+)\)/g)).toEqual([
      "pg_advisory_xact_lock(20261012)",
      "pg_advisory_xact_lock(20261012)",
    ])
  })

  it("sets now() + interval '30 days', the only place the 30 is written", () => {
    expect(body).toContain("v_deadline := now() + interval '30 days';")
    expect(p18.match(/interval '30 days'/g)).toHaveLength(1)
    // No other day count anywhere in P18's code.
    expect(p18.match(/interval '\d+ days?'/g)).toEqual(["interval '30 days'"])
  })

  it("marks only eligible rows: checked, no deadline yet, not shredded, not full", () => {
    const update = body.slice(body.indexOf("update public.courier_registry r"))
    expect(update).toMatch(/set operator_check_deadline = v_deadline,\s+updated_at\s+= now\(\)\s+where r\.operator_checked_at is not null\s+and r\.operator_check_deadline is null\s+and r\.shredded_at is null\s+and r\.status <> 'full';/)
  })

  it("raises no_eligible_couriers before any UPDATE, and only when the sunset has not started", () => {
    const raise = body.indexOf("no_eligible_couriers")
    expect(raise).toBeGreaterThan(-1)
    expect(raise).toBeLessThan(body.indexOf("update public.courier_registry"))
    expect(body).toMatch(/if v_eligible = 0 then\s+if exists \(select 1 from public\.courier_registry r\s+where r\.operator_check_deadline is not null\) then\s+return query select 0, null::timestamptz;\s+return;\s+end if;\s+raise exception '[^']*no_eligible_couriers'\s+using errcode = '55000';/)
  })
})

describe("P18: privileges", () => {
  it("revokes both new functions from all four roles and grants them to nobody", () => {
    expect(p18).toContain("revoke all on function public.courier_record_operator_check(uuid, text)\n  from public, anon, authenticated, service_role;")
    expect(p18).toContain("revoke all on function public.courier_start_operator_check_sunset()\n  from public, anon, authenticated, service_role;")
    expect(p18).not.toMatch(/grant [^;]*courier_record_operator_check/)
    expect(p18).not.toMatch(/grant [^;]*courier_start_operator_check_sunset/)
  })

  it("keeps the bind service_role only, as P12", () => {
    expect(p18).toContain("grant execute on function public.courier_bind_piverify_session(uuid, text, text, text)\n  to service_role;")
  })

  it("restates the view's revoke from everyone and gyema_reader's SELECT, as P15", () => {
    expect(p18).toContain("revoke all on public.courier_registry_dispatch from public, anon, authenticated, service_role;")
    expect(p18).toContain("grant select on public.courier_registry_dispatch to gyema_reader;")
  })
})

// ---------------------------------------------------------------------------
// P18, the bind (10.4) and the view (10.8)
// ---------------------------------------------------------------------------

describe("P18: courier_bind_piverify_session", () => {
  const KEEP =
    "r.operator_checked_at is not null\n" +
    "                                         and r.status = 'buffer'\n" +
    "                                         and r.buffer_since = r.operator_checked_at\n" +
    "                                         and (r.operator_check_deadline is null\n" +
    "                                              or now() < r.operator_check_deadline)"

  it("keeps buffer_since and status for a checked courier in buffer through the check, before the deadline", () => {
    expect(bind18).toContain(`buffer_since            = case when ${KEEP}\n                                        then r.buffer_since else null end,`)
    expect(bind18).toContain(
      "status                  = case when coalesce(r.paused_reason, '') = 'operator'\n" +
        "                                        then r.status\n" +
        `                                        when ${KEEP}\n` +
        "                                        then r.status\n" +
        "                                        else 'registered' end,"
    )
  })

  it("is P12's function byte for byte outside the UPDATE's two changed assignments", () => {
    const head = (b: string) => b.slice(0, b.indexOf("         buffer_since"))
    const tail = (b: string) => b.slice(b.indexOf("         paused_reason"))
    expect(head(bind18)).toBe(head(bind12))
    expect(tail(bind18)).toBe(tail(bind12))
  })

  it("changes P12's UPDATE in buffer_since and status only", () => {
    expect(bind12).toContain("         buffer_since            = null,")
    expect(bind18).not.toContain("         buffer_since            = null,")
  })
})

describe("P18: the dispatch view", () => {
  const cols = (src: string) => {
    const view = src.slice(src.indexOf("create or replace view public.courier_registry_dispatch"))
    return view
      .slice(view.indexOf("select") + 6, view.indexOf("from public.courier_registry;"))
      .split(/,\s*\n/)
      .map((c) => c.trim())
  }

  it("keeps P15's nine columns in order and appends operator_checked_at and operator_check_deadline", () => {
    const p15 = cols(code(P15_PATH))
    expect(p15).toHaveLength(9)
    expect(cols(p18)).toEqual([...p15, "operator_checked_at", "operator_check_deadline"])
  })

  it("never carries operator_checked_by, and restates security_invoker = false", () => {
    expect(cols(p18)).not.toContain("operator_checked_by")
    expect(p18).toContain("create or replace view public.courier_registry_dispatch\n  with (security_invoker = false)")
  })
})

describe("P18 names no network, so it mirrors as bytes", () => {
  it("passes the CLAUDE.md scan, as do the probe files", () => {
    const scan = new RegExp(["pinet\\.com", "Test" + "net", "test" + "net", "88" + "41", "36" + "81"].join("|"))
    for (const f of [P18_PATH, "db/probes/2026-10-12_operator_check/fixture.sql", "db/probes/2026-10-12_operator_check/probes.sql", "db/probes/2026-10-12_operator_check/run.sh"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(scan)
    }
  })
})

// ---------------------------------------------------------------------------
// The ladder, option B (10.5)
// ---------------------------------------------------------------------------

describe("effectiveTier under option B", () => {
  const NOW = Date.parse("2026-10-12T12:00:00Z")
  const DAY = 24 * 60 * 60 * 1000
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const CHECKED = at(-10 * DAY)
  const checked = (extra: Record<string, unknown> = {}) => ({
    status: "buffer",
    buffer_since: CHECKED,
    operator_checked_at: CHECKED,
    operator_check_deadline: null,
    ...extra,
  })

  it("through the check with no deadline is buffer on day 31 and day 365", () => {
    for (const days of [31, 365]) {
      const t = at(-days * DAY)
      expect(effectiveTier(checked({ buffer_since: t, operator_checked_at: t }), NOW), `day ${days}`).toEqual({ tier: "buffer" })
    }
  })

  it("is buffer before the deadline, and none at and after it", () => {
    expect(effectiveTier(checked({ operator_check_deadline: at(1) }), NOW)).toEqual({ tier: "buffer" })
    expect(effectiveTier(checked({ operator_check_deadline: at(0) }), NOW)).toEqual({ tier: "none", reason: "courier_not_active" })
    expect(effectiveTier(checked({ operator_check_deadline: at(-1) }), NOW)).toEqual({ tier: "none", reason: "courier_not_active" })
  })

  it("a set deadline that does not parse fails closed; an empty one too", () => {
    for (const bad of ["not a time", ""]) {
      expect(effectiveTier(checked({ operator_check_deadline: bad }), NOW), bad).toEqual({ tier: "none", reason: "courier_not_active" })
    }
  })

  it("a buffer_since that is not the check's own falls back to the 30-day rule", () => {
    const old = at(-31 * DAY)
    expect(effectiveTier({ status: "buffer", buffer_since: old, operator_checked_at: at(-40 * DAY) }, NOW)).toEqual({
      tier: "none",
      reason: "courier_not_active",
    })
    expect(effectiveTier({ status: "buffer", buffer_since: at(-5 * DAY), operator_checked_at: at(-40 * DAY) }, NOW)).toEqual({
      tier: "buffer",
    })
  })

  it("compares the two stamps as the strings the database returned, to the microsecond", () => {
    const a = "2026-09-01T10:00:00.123456+00:00"
    const b = "2026-09-01T10:00:00.123457+00:00"
    expect(Date.parse(a)).toBe(Date.parse(b))
    expect(throughOperatorCheck({ status: "buffer", buffer_since: a, operator_checked_at: a })).toBe(true)
    expect(throughOperatorCheck({ status: "buffer", buffer_since: a, operator_checked_at: b })).toBe(false)
  })

  it("only a buffer row is through the check; a null or empty check never is", () => {
    for (const status of ["registered", "full", "paused"]) {
      expect(throughOperatorCheck({ status, buffer_since: CHECKED, operator_checked_at: CHECKED }), status).toBe(false)
    }
    expect(throughOperatorCheck({ status: "buffer", buffer_since: CHECKED, operator_checked_at: null })).toBe(false)
    expect(throughOperatorCheck({ status: "buffer", buffer_since: "", operator_checked_at: "" })).toBe(false)
    expect(throughOperatorCheck({ status: "buffer", buffer_since: null, operator_checked_at: null })).toBe(false)
  })

  it("a buffer row with no buffer_since still fails closed, checked or not", () => {
    expect(effectiveTier({ status: "buffer", buffer_since: null, operator_checked_at: CHECKED }, NOW)).toEqual({
      tier: "none",
      reason: "courier_not_active",
    })
  })

  it("the Pioneer route's row, with neither field, behaves as before", () => {
    expect(BUFFER_WINDOW_DAYS).toBe(30)
    expect(effectiveTier({ status: "buffer", buffer_since: at(-29 * DAY) }, NOW)).toEqual({ tier: "buffer" })
    expect(effectiveTier({ status: "buffer", buffer_since: at(-30 * DAY) }, NOW)).toEqual({ tier: "none", reason: "courier_not_active" })
    expect(effectiveTier({ status: "full", buffer_since: null }, NOW)).toEqual({ tier: "full" })
  })

  it("shredded still wins over a check", () => {
    expect(effectiveTier(checked({ shredded_at: at(-DAY) }), NOW)).toEqual({ tier: "none", reason: "unavailable" })
  })
})

// ---------------------------------------------------------------------------
// PIVERIFY_ENABLED (decision 10, 10.7)
// ---------------------------------------------------------------------------

describe("piverifyEnabled", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is true only for exactly true", () => {
    vi.stubEnv("PIVERIFY_ENABLED", "true")
    expect(piverifyEnabled()).toBe(true)
    for (const v of ["", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
      vi.stubEnv("PIVERIFY_ENABLED", v)
      expect(piverifyEnabled(), JSON.stringify(v)).toBe(false)
    }
  })

  it("is false when unset", () => {
    vi.stubEnv("PIVERIFY_ENABLED", undefined as unknown as string)
    delete process.env.PIVERIFY_ENABLED
    expect(piverifyEnabled()).toBe(false)
  })
})

function walk(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, keep))
    else if (keep(name)) out.push(p)
  }
  return out
}

const SOURCE = [
  ...walk("app", (n) => /\.(tsx?|mjs|js)$/.test(n)),
  ...walk("components", (n) => /\.(tsx?|mjs|js)$/.test(n)),
  ...walk("lib", (n) => /\.(tsx?|mjs|js)$/.test(n)),
  ...walk("scripts", (n) => /\.(tsx?|mjs|js)$/.test(n)),
  "middleware.ts",
  "next.config.mjs",
].filter((f) => existsSync(f))

describe("where PIVERIFY_ENABLED and operator_checked_by may appear", () => {
  it("PIVERIFY_ENABLED is read once, in lib/piverify.ts, and nothing reads it but through the helper", () => {
    const readers = SOURCE.filter((f) => /process\.env\.PIVERIFY_ENABLED|process\.env\[["']PIVERIFY_ENABLED/.test(readFileSync(f, "utf8")))
    expect(readers.map((f) => f.replace(/\\/g, "/"))).toEqual(["lib/piverify.ts"])
    expect(readFileSync("lib/piverify.ts", "utf8").match(/process\.env\.PIVERIFY_ENABLED/g)).toHaveLength(1)
  })

  // docs/ is left out: the notes state this very rule in words.
  it("no NEXT_PUBLIC_ form of it exists anywhere in the source, tests or migrations", () => {
    const name = "NEXT_PUBLIC_" + "PIVERIFY_ENABLED"
    const all = [...SOURCE, ...walk("tests", (n) => /\.ts$/.test(n)), ...walk("db", (n) => /\.(sql|sh)$/.test(n))]
    expect(all.filter((f) => readFileSync(f, "utf8").includes(name))).toEqual([])
  })

  it("the three routes and the panel use the helper", () => {
    for (const f of ["app/api/courier/kyc/start/route.ts", "app/api/courier/kyc/refresh/route.ts", "app/api/courier/me/route.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/import \{[^}]*\bpiverifyEnabled\b[^}]*\} from "@\/lib\/piverify"/)
    }
  })

  it("operator_checked_by is never selected outside SQL: only comments mention it in app, lib, components and scripts", () => {
    for (const f of SOURCE) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/)
      for (const [i, line] of lines.entries()) {
        if (!line.includes("operator_checked_by")) continue
        expect(line.trim(), `${f}:${i + 1}`).toMatch(/^(\/\/|\*|\/\*)/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The courier page (10.7)
// ---------------------------------------------------------------------------

describe("the courier page's item 10 decisions", () => {
  const base: CourierKycView = {
    status: "buffer",
    effectiveTier: "buffer",
    operatorChecked: true,
    operatorCheckDeadline: null,
    piverifyEnabled: false,
  }

  it("OPERATOR_CHECK_LINE shows while in buffer through the check; the deadline line joins it once a deadline is set", () => {
    expect(operatorCheckLines(base)).toEqual([OPERATOR_CHECK_LINE])
    expect(operatorCheckLines({ ...base, operatorCheckDeadline: "2026-11-11T09:30:00.123456+00:00" })).toEqual([
      OPERATOR_CHECK_LINE,
      "Complete your verification through PiVerify by 11 November 2026 to keep taking jobs.",
    ])
  })

  it("neither line shows once the ladder has stopped the courier, or for a courier not checked", () => {
    expect(operatorCheckLines({ ...base, effectiveTier: "none" })).toEqual([])
    expect(operatorCheckLines({ ...base, operatorChecked: false })).toEqual([])
  })

  it("the deadline is a date only, in Accra time, and an unparseable one shows no line", () => {
    expect(formatDeadlineDate("2026-11-11T23:59:00Z")).toBe("11 November 2026")
    expect(formatDeadlineDate("2026-11-12T00:00:00Z")).toBe("12 November 2026")
    expect(formatDeadlineDate("nope")).toBeNull()
    expect(formatDeadlineDate(null)).toBeNull()
    expect(operatorCheckLines({ ...base, operatorCheckDeadline: "nope" })).toEqual([OPERATOR_CHECK_LINE])
  })

  it("PIVERIFY_NOT_OPEN_LINE shows while PiVerify is off, for every courier who is not full", () => {
    for (const status of ["registered", "buffer", "paused"]) {
      expect(showPiverifyNotOpen({ ...base, status }), status).toBe(true)
    }
    expect(showPiverifyNotOpen({ ...base, status: "full" })).toBe(false)
    expect(showPiverifyNotOpen({ ...base, piverifyEnabled: true })).toBe(false)
  })

  it("the item 10 strings are as approved 12 Oct 2026, and none says verified", () => {
    expect(OPERATOR_CHECK_LINE).toBe(
      "You have starter access after an in-person check by Gyema. This is not identity verification. Full access needs verification through PiVerify."
    )
    expect(OPERATOR_CHECK_ENDED_LINE).toBe(
      "Starter access from the in-person check has ended. Jobs are paused until your verification through PiVerify is complete."
    )
    expect(PIVERIFY_NOT_OPEN_LINE).toBe("Verification through PiVerify is not open yet. Gyema will let you know when it opens.")
    expect(OPERATOR_CHECK_DEADLINE_TEMPLATE).toBe("Complete your verification through PiVerify by {date} to keep taking jobs.")
    for (const s of [OPERATOR_CHECK_LINE, OPERATOR_CHECK_ENDED_LINE, PIVERIFY_NOT_OPEN_LINE, OPERATOR_CHECK_DEADLINE_TEMPLATE]) {
      expect(s, s).not.toMatch(/\bverified\b/i)
      expect(s, s).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it("each item 10 string is marked approved in courier-view.ts", () => {
    const src = readFileSync("app/courier/courier-view.ts", "utf8")
    expect(src.match(/\/\*\* Copy approved 12 Oct 2026 \(item 10\)\./g)).toHaveLength(4)
  })
})

describe("the courier panel (text pins)", () => {
  const panel = readFileSync("app/courier/courier-panel.tsx", "utf8")

  it("shows the verification button only while PiVerify is on", () => {
    expect(panel).toContain("{courier.piverifyEnabled && courier.canStartKyc && !waiting && (")
  })

  it("starts no refresh poll while PiVerify is off, on load or on the waiting screen", () => {
    expect(panel).toContain('const unsettled = view.kind === "signed_in" && view.courier.piverifyEnabled && isUnsettled(view.courier)')
    expect(panel).toMatch(/const waiting =\s+view\.kind === "signed_in" && view\.courier\.piverifyEnabled && view\.courier\.piverifyStatus === "pending_review"/)
    // Both polls are gated by those two values and nothing else calls refresh.
    expect(panel.match(/\/api\/courier\/kyc\/refresh/g)).toHaveLength(2)
    expect(panel).toMatch(/if \(!unsettled \|\| polledOnLoad\.current\) return/)
    expect(panel).toMatch(/if \(!waiting\) return\s+const timer = setInterval/)
  })

  it("shows PIVERIFY_NOT_OPEN_LINE in the button's place, and maps piverify_not_enabled to it", () => {
    expect(panel).toContain("{showPiverifyNotOpen(courier) && (")
    expect(panel).toContain("piverify_not_enabled: PIVERIFY_NOT_OPEN_LINE,")
  })

  it("shows the operator-check lines, and OPERATOR_CHECK_ENDED_LINE as the lapsed line after the check", () => {
    expect(panel).toContain("{operatorCheckLines(courier).map((line) => (")
    expect(panel).toMatch(/\{courier\.operatorChecked\s+\? OPERATOR_CHECK_ENDED_LINE\s+: "Your verification has taken longer than 30 days\. Jobs are paused until it completes\."\}/)
  })

  it("no string on the courier page says verified, except the full courier's Account label", () => {
    const literals = [...panel.matchAll(/"([^"\n]*)"/g), ...panel.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1].trim())
    const saying = literals.filter((s) => /\bverified\b/i.test(s))
    expect([...new Set(saying)]).toEqual(["Verified courier"])
    expect(panel).toMatch(/full: "Verified courier"/)
  })
})
