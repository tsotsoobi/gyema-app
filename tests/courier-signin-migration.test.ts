import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// db/migrations/2026-10-08_courier_signin.sql and
// db/migrations/2026-10-08_courier_piverify_bind.sql, read as text.
//
// No test here touches a database. Both files were run against a throwaway
// postgres 17 when they were written, with the behaviour probes recorded in
// the commit. These tests hold the statements that keep the founder functions
// owner only and the app functions service_role only, so a later edit cannot
// quietly drop one.

const signin = readFileSync("db/migrations/2026-10-08_courier_signin.sql", "utf8")
const bind = readFileSync("db/migrations/2026-10-08_courier_piverify_bind.sql", "utf8")
const catalog = readFileSync("docs/catalog-checks.sql", "utf8")

/** A file with its comment lines removed: the statements it actually runs. */
function statementsOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}

const signinSql = statementsOf(signin)
const bindSql = statementsOf(bind)

const OWNER_ONLY = [
  "public.courier_register_legacy()",
  "public.courier_issue_signin_code(uuid)",
  "public.courier_revoke_sessions(uuid)",
]
const SERVICE_ROLE = [
  "public.courier_redeem_signin_code(bytea, bytea)",
  "public.courier_session_resolve(bytea)",
  "public.courier_end_session(bytea)",
]
const BIND = "public.courier_bind_piverify_session(uuid, text, text, text)"

describe("courier sign-in migration", () => {
  it("creates both tables idempotently, with RLS on and no policy", () => {
    for (const t of ["courier_signin_codes", "courier_sessions"]) {
      expect(signinSql).toContain(`create table if not exists public.${t} (`)
      expect(signinSql).toContain(`alter table public.${t} enable row level security;`)
      expect(signinSql).toContain(`revoke all on table public.${t} from public, anon, authenticated;`)
      expect(signinSql).toContain(`revoke all on table public.${t} from service_role;`)
      expect(signinSql).toContain(`grant select on table public.${t} to service_role;`)
    }
    expect(signinSql).not.toMatch(/create policy/i)
    expect(signinSql).not.toMatch(/grant (insert|update|delete|all)[^;]*on table/i)
  })

  it("stores no IP, user agent, phone or name", () => {
    expect(signinSql).not.toMatch(/\b(ip|ip_address|user_agent|phone|name)\s+(text|inet)/i)
  })

  it("keeps one live code per courier", () => {
    expect(signinSql).toMatch(
      /create unique index if not exists courier_signin_codes_one_live_per_courier\s+on public\.courier_signin_codes \(courier_id\)\s+where consumed_at is null and revoked_at is null;/
    )
  })

  it("makes every function security definer with search_path pinned", () => {
    expect(signinSql.match(/create or replace function/g) ?? []).toHaveLength(6)
    expect(signinSql.match(/security definer\s+set search_path = public, pg_temp/g) ?? []).toHaveLength(6)
  })

  it("revokes the founder functions from everyone, service_role included, and grants them to nobody", () => {
    for (const fn of OWNER_ONLY) {
      expect(signinSql).toContain(`revoke all on function ${fn}\n  from public, anon, authenticated, service_role;`)
      expect(signinSql).not.toContain(`grant execute on function ${fn}`)
    }
  })

  it("revokes the app functions from public, anon and authenticated, and grants them to service_role alone", () => {
    for (const fn of SERVICE_ROLE) {
      expect(signinSql).toContain(`revoke all on function ${fn}\n  from public, anon, authenticated;`)
      expect(signinSql).toContain(`grant execute on function ${fn}\n  to service_role;`)
    }
    expect(signinSql.match(/grant execute on function/g) ?? []).toHaveLength(3)
  })

  it("marks every writing function for founder review", () => {
    // Six function markers, plus the one in the header that names the rule.
    expect(signin.match(/^-- IDENTITY WRITE: founder review required/gm) ?? []).toHaveLength(7)
    const fns = signin.split("create or replace function").slice(1)
    const blocks = signin.split("create or replace function").slice(0, -1)
    expect(fns).toHaveLength(6)
    for (const before of blocks) {
      const lastMarker = before.lastIndexOf("-- IDENTITY WRITE: founder review required")
      expect(lastMarker).toBeGreaterThan(before.lastIndexOf("$$;"))
    }
  })

  it("issues codes from the Crockford alphabet, skipping the version and variant bytes", () => {
    expect(signinSql).toContain("c_alphabet  constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';")
    expect(signinSql).toContain("foreach v_i in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11] loop")
    expect(signinSql).toContain("get_byte(v_bytes, v_i) & 31")
    expect(signinSql).toContain("v_expires := now() + interval '15 minutes';")
  })

  it("hashes the normalised code and never stores it", () => {
    expect(signinSql).toContain("sha256(convert_to(translate(upper(v_code), 'OIL- ', '011'), 'UTF8'))")
    expect(signinSql).toMatch(
      /insert into public\.courier_signin_codes \(courier_id, code_hash, expires_at\)\s+values \(v_courier\.id,\s+sha256\(convert_to\(translate\(upper\(v_code\)/
    )
  })

  it("salts from core Postgres, without pgcrypto", () => {
    expect(signinSql).toContain("sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()))")
    expect(signinSql).not.toMatch(/gen_random_bytes|pgcrypto|extensions\./)
  })

  it("redeems with the courier id from the code row, and one session per courier", () => {
    expect(signinSql).toContain(
      "create or replace function public.courier_redeem_signin_code(p_code_hash bytea, p_token_hash bytea)"
    )
    expect(signinSql).toContain("set revoked_at = now(), revoked_reason = 'replaced'")
    expect(signinSql).toContain("v_expires := now() + interval '90 days';")
    for (const outcome of ["ok", "no_match", "expired", "unavailable"]) {
      expect(signinSql).toContain(`'${outcome}'::text`)
    }
  })

  it("resolves only live, unexpired, non-idle sessions of unshredded legacy couriers", () => {
    expect(signinSql).toMatch(
      /and s\.revoked_at is null\s+and s\.expires_at > now\(\)\s+and s\.last_seen_at > now\(\) - interval '30 days'\s+and r\.shredded_at is null\s+and r\.class = 'legacy';/
    )
    expect(signinSql).toContain("if v_last_seen_at < now() - interval '1 hour' then")
  })

  it("ends with the read-only verification", () => {
    expect(signinSql.trimEnd().endsWith(") as courier_signin_verification;")).toBe(true)
    expect(signinSql).toContain("'service_role cannot execute ' || f.name")
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(signin).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("courier PiVerify bind migration", () => {
  it("is security definer with search_path pinned, service_role only, marked for founder review", () => {
    expect(bindSql).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(bindSql).toContain(`revoke all on function ${BIND}\n  from public, anon, authenticated;`)
    expect(bindSql).toContain(`grant execute on function ${BIND}\n  to service_role;`)
    expect(bindSql.match(/grant execute on function/g) ?? []).toHaveLength(1)
    expect(bind).toContain("-- ATTESTATION WRITE: founder review required.")
  })

  it("refuses in the approved order", () => {
    const order = ["shredded", "already_full", "conflict", "session_live", "session_taken", "bad_status", "bound"]
    const at = order.map((o) => bindSql.indexOf(`'${o}'::text`))
    for (const i of at) expect(i).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it("resets buffer_since and clears the allowed action on success, keeping an operator pause", () => {
    expect(bindSql).toContain("buffer_since            = null,")
    expect(bindSql).toContain("piverify_allowed_action = null,")
    expect(bindSql).toContain("piverify_status         = 'created',")
    expect(bindSql.match(/when coalesce\(r\.paused_reason, ''\) = 'operator'/g) ?? []).toHaveLength(2)
  })

  it("checks the session id shape it will bind", () => {
    expect(bindSql).toContain("p_new_session_id !~ '^[A-Za-z0-9_-]{1,64}$'")
  })

  it("records the 10-minute idempotency key in its header", () => {
    expect(bind).toContain("floor(unix seconds / 600)")
  })

  it("ends with the read-only verification", () => {
    expect(bindSql.trimEnd().endsWith(") as courier_piverify_bind_verification;")).toBe(true)
  })

  it("names no network, so it mirrors between repositories as bytes", () => {
    expect(bind).not.toMatch(/pinet\.com|Testnet|testnet|8841|3681/)
  })
})

describe("catalog checks for courier sign-in", () => {
  it("lists all seven new functions in check 7", () => {
    for (const fn of [...OWNER_ONLY, ...SERVICE_ROLE, BIND]) {
      const name = fn.replace(/^public\./, "").replace(/\(.*$/, "")
      expect(catalog).toContain(`        '${name}',`)
    }
  })

  it("has a service_role cannot execute row in check 9 for each founder function, guarded for absence", () => {
    for (const fn of OWNER_ONLY) {
      const name = fn.replace(/^public\./, "").replace(/\(.*$/, "")
      expect(catalog).toContain(`'service_role cannot execute ${name}'`)
      expect(catalog).toContain(`case when to_regprocedure('${fn}') is null then false`)
      expect(catalog).toContain(`else not has_function_privilege('service_role', '${fn}', 'EXECUTE') end`)
    }
  })

  it("adds check 15 to the document and its expectations", () => {
    expect(catalog).toContain("check_15_courier_signin as (")
    expect(catalog).toContain("'check_15_courier_signin',        (select v from check_15_courier_signin)")
    expect(catalog).toMatch(/'check_15_courier_signin',\r?\n\s+'Before 2026-10-08_courier_signin\.sql is applied/)
  })
})
