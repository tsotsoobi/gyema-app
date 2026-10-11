-- ===========================================================================
-- 2026-10-08  courier_bind_piverify_session: bind a new PiVerify session
-- ===========================================================================
--
-- WHAT THIS IS
--
-- Phase 1 item 5, part (a), as approved 8 Oct 2026
-- (docs/anchoring-phase1-notes.md, item 5, sections 5.4 and 5.5). Its own
-- file because binding is a KYC concern, not a sign-in one.
--
-- POST /api/courier/kyc/start (item 5 part (b)) creates a PiVerify session
-- for the signed-in courier, then calls this function to bind it to their
-- courier_registry row. Binding is what lets courier_apply_kyc_status
-- (2026-10-08_piverify_resubmission.sql) apply that session's events, so it
-- moves the ladder: a courier whose last session was rejected for good or
-- failed goes back to registered (founder decision 11).
--
-- THE IDEMPOTENCY KEY HAS NO SQL FOOTPRINT, and is recorded here so the
-- create and the bind are read together. The route creates with
--
--   gyema_ + the first 32 hex characters of
--   sha256(courier_id + ":" + (bound session id or "none") + ":"
--          + floor(unix seconds / 600))
--
-- 38 characters (founder decision, 8 Oct 2026, 5.4). A double tap inside the
-- same 10 minutes gets the same session back from PiVerify; a retry after a
-- 502 in a later 10-minute window gets a new key, as PiVerify requires. Two
-- requests racing past each other both reach this function with the same
-- expected session; the second reads conflict and the route returns the
-- session that won, never its own. A duplicate across a window boundary is
-- an unbound session that costs nothing until pending_review, and whose
-- events read stale_session.
--
-- THE RULES, under the courier row lock, checked in this order:
--
--   shredded        the courier is shredded
--   already_full    kyc_approved_at is set (founder decision, item 3)
--   conflict        the bound session is no longer the one the route read
--   session_live    the bound session is still live: created, started,
--                   pending_review, or a rejection carrying an
--                   allowed_action (a reopened rejection continues on the
--                   same session)
--   session_taken   the new session id is already bound to a courier
--   bad_status      the new session is not created; anything else at
--                   creation is refused, so a change on PiVerify's side
--                   shows up rather than being absorbed
--   bound           success
--
-- On success it sets piverify_session_id, piverify_status = created,
-- piverify_allowed_action = null (the check on rejected requires it),
-- piverify_status_at = now(), buffer_since = null, status = registered and
-- paused_reason = null, and updated_at = now(). An operator pause stands, as
-- everywhere else: status and paused_reason are then left as they are.
--
-- buffer_since IS RESET ON PURPOSE. courier_apply_kyc_status writes
-- coalesce(buffer_since, now()) on pending_review, so without the reset a new
-- session's 30-day clock would start from the old one.
--
-- current_session_id is returned with every outcome: the session bound to
-- the courier once the call ends. On conflict the route takes the hosted URL
-- from it.
--
-- A webhook for the new session that lands before the bind reads
-- session_not_bound, gets a 503 and is retried (item 3, as built).
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Requires 2026-10-08_courier_registry.sql
-- (P2) AND 2026-10-08_piverify_resubmission.sql (P9), which adds the
-- piverify_allowed_action column this function writes. Apply it BEFORE the
-- item 5 code deploys. Run the whole file; its last statement is a read-only
-- verification.
--
-- IDEMPOTENT. create or replace, and revokes and grants that are no-ops when
-- already in place.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The function
--
-- ATTESTATION WRITE: founder review required.
--
-- security definer, search_path pinned, EXECUTE for service_role alone
-- (section 2). p_courier_id comes from resolveCourier, which derived it from
-- the session cookie; no route takes it from the request (invariant 1, the
-- proposed wording in 5.3). p_expected_session_id is the session id the
-- route read from the row, or null for none.
-- ---------------------------------------------------------------------------
create or replace function public.courier_bind_piverify_session(
  p_courier_id           uuid,
  p_expected_session_id  text,
  p_new_session_id       text,
  p_status               text
)
returns table (outcome text, current_session_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_courier  public.courier_registry%rowtype;
begin
  -- The route checks the shape before it calls. Repeated here because this
  -- is the function that writes, and a bad value must never reach a row.
  -- No ':' is allowed, so a poll event id built from it cannot be ambiguous.
  if p_new_session_id is null or p_new_session_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'courier_bind_piverify_session: malformed session id';
  end if;
  if p_status is null or p_status not in ('created', 'started', 'pending_review',
                                          'approved', 'rejected', 'failed') then
    raise exception 'courier_bind_piverify_session: unknown status %', p_status;
  end if;

  select * into v_courier from public.courier_registry r
   where r.id = p_courier_id
     for update;

  if v_courier.id is null then
    raise exception 'courier_bind_piverify_session: no courier %', p_courier_id;
  end if;

  if v_courier.shredded_at is not null then
    return query select 'shredded'::text, v_courier.piverify_session_id;
    return;
  end if;

  if v_courier.kyc_approved_at is not null then
    return query select 'already_full'::text, v_courier.piverify_session_id;
    return;
  end if;

  if v_courier.piverify_session_id is distinct from p_expected_session_id then
    return query select 'conflict'::text, v_courier.piverify_session_id;
    return;
  end if;

  if v_courier.piverify_session_id is not null
     and (v_courier.piverify_status in ('created', 'started', 'pending_review')
          or (v_courier.piverify_status = 'rejected'
              and v_courier.piverify_allowed_action is not null)) then
    return query select 'session_live'::text, v_courier.piverify_session_id;
    return;
  end if;

  if exists (select 1 from public.courier_registry r
              where r.piverify_session_id = p_new_session_id) then
    return query select 'session_taken'::text, v_courier.piverify_session_id;
    return;
  end if;

  if p_status <> 'created' then
    return query select 'bad_status'::text, v_courier.piverify_session_id;
    return;
  end if;

  update public.courier_registry r
     set piverify_session_id     = p_new_session_id,
         piverify_status         = 'created',
         piverify_allowed_action = null,
         piverify_status_at      = now(),
         buffer_since            = null,
         status                  = case when coalesce(r.paused_reason, '') = 'operator'
                                        then r.status else 'registered' end,
         paused_reason           = case when coalesce(r.paused_reason, '') = 'operator'
                                        then r.paused_reason else null end,
         updated_at              = now()
   where r.id = v_courier.id;

  return query select 'bound'::text, p_new_session_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Lock it to service_role (CLAUDE.md invariant 2)
--
-- A new function is executable by PUBLIC until revoked, whatever the default
-- privileges say, so it is revoked here, in the same file that creates it.
-- ---------------------------------------------------------------------------
revoke all on function public.courier_bind_piverify_session(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.courier_bind_piverify_session(uuid, text, text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row should read present true.
-- ---------------------------------------------------------------------------
with
f as (
  select p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'courier_bind_piverify_session'
),
f4 as (
  select * from f
   where args = 'p_courier_id uuid, p_expected_session_id text, p_new_session_id text, p_status text'
),
facl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from f4
    cross join lateral aclexplode(coalesce(f4.proacl, acldefault('f', f4.proowner))) a
   where a.grantee <> f4.proowner
),
rows as (
  select 'column courier_registry.piverify_allowed_action (needs P9)' as object,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'courier_registry'
                    and column_name = 'piverify_allowed_action') as present,
         null::text as detail
  union all
  select 'function courier_bind_piverify_session(uuid, text, text, text)', exists (select 1 from f4), null
  union all
  select 'courier_bind_piverify_session has exactly one signature',
         (select count(*) from f) = 1 and exists (select 1 from f4),
         (select string_agg(args, ' | ') from f)
  union all
  select 'courier_bind_piverify_session is security definer', coalesce((select prosecdef from f4), false), null
  union all
  select 'courier_bind_piverify_session pins search_path',
         coalesce((select array_to_string(proconfig, ',') like '%search_path%' from f4), false),
         (select array_to_string(proconfig, ',') from f4)
  union all
  select 'courier_bind_piverify_session: EXECUTE for service_role only',
         exists (select 1 from f4)
         and not exists (select 1 from facl where grantee <> 'service_role')
         and exists (select 1 from facl where grantee = 'service_role' and privilege_type = 'EXECUTE'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee) from facl)
)
select jsonb_pretty(jsonb_build_object(
  'courier_piverify_bind_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as courier_piverify_bind_verification;
