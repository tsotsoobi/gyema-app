import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// The two webhook guards that live only in the database function, pinned as
// text (pre-push check, 11 Oct 2026). Before this file, replacing the rank
// comparison with `if false`, or deleting the event id's ON CONFLICT clause,
// left every test green.
//
// The live function is the six-argument courier_apply_kyc_status in
// db/migrations/2026-10-08_piverify_resubmission.sql (P9), which replaces the
// five-argument one from 2026-10-08_piverify_webhook.sql (P5). piverify_events
// and its primary key come from P5.
//
// Behaviour was probed against a throwaway postgres:17-alpine when each file
// was written; these pins stop a later edit from quietly removing either guard.

function code(path: string): string {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}

const resubmission = code("db/migrations/2026-10-08_piverify_resubmission.sql")
const webhook = code("db/migrations/2026-10-08_piverify_webhook.sql")

// The body of the six-argument function, from its CREATE to the closing $$.
const start = resubmission.indexOf("create or replace function public.courier_apply_kyc_status(")
const body = resubmission.slice(start, resubmission.indexOf("$$;", start) + 3)

const FORWARD_CHECK =
  /if v_new_rank <= v_cur_rank\s+or v_courier\.kyc_approved_at is not null\s+or \(v_reopened and p_status = 'rejected'\s+and v_action is not distinct from v_courier\.piverify_allowed_action\) then\s+update public\.piverify_events set outcome = 'not_forward', courier_id = v_courier\.id,\s+piverify_status = p_status\s+where event_id = p_event_id;\s+return query select 'not_forward'::text, v_courier\.status;\s+return;\s+end if;/

const DUPLICATE_GUARD =
  /insert into public\.piverify_events \(event_id, event_type, session_id, outcome, allowed_action\)\s+values \(p_event_id, p_event_type, p_session_id, 'pending', v_action\)\s+on conflict \(event_id\) do nothing\s+returning event_id into v_inserted;\s+if v_inserted is null then\s+return query select 'duplicate'::text, v_courier\.status;\s+return;\s+end if;/

describe("the live webhook function", () => {
  it("is the six-argument courier_apply_kyc_status, found in full", () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/p_status\s+text,\s+p_allowed_action\s+text\s+\)/)
    expect(body.endsWith("$$;")).toBe(true)
  })
})

describe("forward only", () => {
  it("ranks the incoming status created 0, started 1, pending_review 2, terminal 3", () => {
    expect(body).toMatch(
      /v_new_rank := case p_status when 'created' then 0 when 'started' then 1\s+when 'pending_review' then 2 else 3 end;/
    )
  })

  it("ranks the stored status the same way, with an unknown one below created", () => {
    expect(body).toMatch(
      /else case v_courier\.piverify_status\s+when 'created' then 0 when 'started' then 1\s+when 'pending_review' then 2\s+when 'approved' then 3 when 'rejected' then 3 when 'failed' then 3\s+else -1 end/
    )
  })

  it("refuses v_new_rank <= v_cur_rank, or any move after approval, as not_forward and returns before writing", () => {
    expect(body).toMatch(FORWARD_CHECK)
  })

  it("checks forward only before the function writes any courier row", () => {
    const check = body.search(FORWARD_CHECK)
    const firstRegistryWrite = body.indexOf("update public.courier_registry")
    expect(check).toBeGreaterThan(-1)
    expect(firstRegistryWrite).toBeGreaterThan(check)
  })

  it("has one exception: a rejection that carried RESUBMIT or APPEAL reopens to the rank of created", () => {
    expect(body).toMatch(
      /v_reopened := v_courier\.piverify_status = 'rejected'\s+and v_courier\.piverify_allowed_action is not null;/
    )
    expect(body).toMatch(/v_cur_rank := case\s+when v_reopened then 0\s+else case v_courier\.piverify_status/)
    // No other assignment of either rank, so nothing else can lower the bar.
    expect(body.match(/v_cur_rank :=/g) ?? []).toHaveLength(1)
    expect(body.match(/v_new_rank :=/g) ?? []).toHaveLength(1)
    expect(body.match(/v_reopened :=/g) ?? []).toHaveLength(1)
    // allowed_action is stored only for a rejection, and only RESUBMIT or APPEAL get in.
    expect(body).toContain("v_action := case when p_status = 'rejected' then p_allowed_action end;")
    expect(body).toMatch(/p_allowed_action not in \('RESUBMIT', 'APPEAL'\) then\s+raise exception/)
  })
})

describe("one event id, once", () => {
  it("records the event id with ON CONFLICT DO NOTHING and returns duplicate on a repeat", () => {
    expect(body).toMatch(DUPLICATE_GUARD)
  })

  it("records the event id before anything else is decided", () => {
    const guard = body.search(DUPLICATE_GUARD)
    expect(guard).toBeGreaterThan(-1)
    expect(body.search(FORWARD_CHECK)).toBeGreaterThan(guard)
    expect(body.indexOf("update public.courier_registry")).toBeGreaterThan(guard)
    expect(body.indexOf("'unknown_courier'")).toBeGreaterThan(guard)
  })

  it("piverify_events keeps its primary key on event_id", () => {
    expect(webhook).toMatch(/constraint piverify_events_pkey\s+primary key \(event_id\),/)
  })

  it("neither migration drops the table or its primary key", () => {
    for (const sql of [webhook, resubmission]) {
      expect(sql).not.toMatch(/drop table[^;]*piverify_events/i)
      expect(sql).not.toMatch(/drop constraint[^;]*piverify_events_pkey/i)
    }
  })
})
