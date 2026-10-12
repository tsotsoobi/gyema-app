-- ===========================================================================
-- 2026-10-12  courier_registry: operator-checked buffer for legacy couriers
-- ===========================================================================
--
-- Phase 1 item 10, P18, as designed in docs/anchoring-phase1-notes.md,
-- Item 10 (sections 10.2, 10.3, 10.4 and 10.6), with the founder decisions
-- of 12 Oct 2026 recorded there in 10.0 and 10.12.
--
-- WHY THIS EXISTS
--
-- PiVerify API access has never authenticated for Gyema's account, so no
-- legacy courier can reach pending_review, which is the only way the ladder
-- moves a legacy courier from registered to buffer. Founder decision 1: an
-- in-person operator check moves a legacy courier from registered to buffer
-- ONLY. Full still requires PiVerify approval (kyc_approved_at). A legacy
-- courier is never vouched to full.
--
-- THE OPERATOR CHECK IS NOT VERIFICATION. Anchoring and the trust bureau read
-- kyc_approved_at only. The check is never an attestor, never an anchor leaf,
-- never a trust bureau event, and never a reason to show "verified".
--
-- WHAT IT ADDS
--
--   courier_registry.operator_checked_at      timestamptz null
--   courier_registry.operator_checked_by      text null, 'founder' only
--   courier_registry.operator_check_deadline  timestamptz null, the sunset
--
--   courier_registry_operator_checked_legacy_only_check
--   courier_registry_operator_check_pair_check
--   courier_registry_operator_checked_by_check
--   courier_registry_operator_check_deadline_check
--
--   courier_record_operator_check(p_courier_id uuid, p_checked_by text)
--     owner only: legacy, registered -> buffer, recording when and who
--   courier_start_operator_check_sunset()
--     owner only: a 30-day deadline on every eligible checked row
--
-- WHAT IT REPLACES
--
--   courier_bind_piverify_session(uuid, text, text, text), from
--     2026-10-08_courier_piverify_bind.sql (P12). One change, in the UPDATE:
--     a courier in buffer through the check, before the sunset deadline,
--     keeps status buffer and buffer_since. Every other row is bound exactly
--     as P12 binds it. NEVER RE-RUN P12 AFTER THIS FILE: it restores the bind
--     that resets a checked courier to registered. Re-running this file
--     fixes it.
--
--   courier_registry_dispatch, from 2026-10-10_courier_registry_dispatch_view.sql
--     (P15). Columns 1 to 9 unchanged; operator_checked_at (10) and
--     operator_check_deadline (11) appended. Never operator_checked_by. P15's
--     own verification cell then reads false on its column count, as P2's
--     does after P9; catalog check 9 is the live truth.
--
-- DATA PROTECTION (notes 10.11). The check is sight only: the founder sees
-- the Ghana Card in person, and does not photograph, copy or forward it by
-- any means. Nothing about the card is stored: no number, no photo, no name,
-- no description. The three columns hold two times and a role label.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before
-- pasting. Run section 0 on its own first. Then run the whole file: section 1
-- stops it, before anything is written, if a prerequisite is missing. The
-- last statement is a read-only verification returning one cell.
-- all_present must read true.
--
-- ORDER. Needs P2, P9, P11, P12, P13, P15 and P17. Apply BEFORE the item 10
-- code deploys: the courier accept route and /api/courier/me name the new
-- columns, so until they exist every courier accept and every courier page
-- load answers 503. The dispatch reader from the item 10 commit requires
-- columns 10 and 11 of the view and refuses to run until this file is in.
--
-- SAFE TO RE-RUN. Columns with add column if not exists, each check added
-- only if absent by name, create or replace for the functions and the view,
-- and revokes and grants that are no-ops when already in place. Section 1
-- accepts the view in its P15 shape or the shape this file leaves.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Pre-flight, read only. Run on its own and record the result BEFORE the
--    file. Counts only, no row.
--
--     select class, status, count(*) as n
--       from public.courier_registry
--      group by class, status
--      order by class, status;
--
--     select string_agg(a.attname::text, ', ' order by a.attnum) as view_columns
--       from pg_attribute a
--      where a.attrelid = 'public.courier_registry_dispatch'::regclass
--        and a.attnum > 0 and not a.attisdropped;
--
--    Expect view_columns to be the nine P15 columns, ending
--    piverify_allowed_action, or on a re-run the eleven this file leaves.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Guard. Raises, and so stops the file before anything is written, unless
--    every prerequisite is in place and the view is in a known shape.
-- ---------------------------------------------------------------------------
do $$
declare
  v_live   text[];
  v_p15    text[] := array[
    'courier_ref', 'class', 'status', 'buffer_since', 'piverify_status',
    'piverify_status_at', 'paused_reason', 'shredded_at', 'piverify_allowed_action'];
  v_p18    text[] := v_p15 || array['operator_checked_at', 'operator_check_deadline'];
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'P18 guard: server is older than Postgres 15, security_invoker does not exist. Stop.';
  end if;

  if to_regclass('public.courier_registry') is null then
    raise exception 'P18 guard: public.courier_registry does not exist. Apply P2 first. Stop.';
  end if;

  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.courier_registry'::regclass
                    and attname = 'piverify_allowed_action' and not attisdropped) then
    raise exception 'P18 guard: courier_registry.piverify_allowed_action is missing. Apply P9 first. Stop.';
  end if;

  if to_regclass('public.courier_sessions') is null then
    raise exception 'P18 guard: public.courier_sessions does not exist. Apply P11 first. Stop.';
  end if;

  if to_regprocedure('public.courier_bind_piverify_session(uuid, text, text, text)') is null then
    raise exception 'P18 guard: courier_bind_piverify_session(uuid, text, text, text) is missing. Apply P12 first. Stop.';
  end if;

  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.courier_registry'::regclass
                    and attname = 'vouched_at' and not attisdropped) then
    raise exception 'P18 guard: courier_registry.vouched_at is missing. Apply P13 first. Stop.';
  end if;

  if to_regclass('public.courier_registry_dispatch') is null then
    raise exception 'P18 guard: view public.courier_registry_dispatch does not exist. Apply P15 first. Stop.';
  end if;

  if (select count(*) from pg_constraint
       where conrelid = 'public.courier_registry'::regclass
         and conname in ('courier_registry_full_needs_approval_check',
                         'courier_registry_buffer_needs_since_check')) <> 2 then
    raise exception 'P18 guard: the two P17 timing checks are not both present. Apply P17 first. Stop.';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'gyema_reader') then
    raise exception 'P18 guard: role gyema_reader does not exist on this project. Stop.';
  end if;

  select array_agg(a.attname::text order by a.attnum) into v_live
    from pg_attribute a
   where a.attrelid = 'public.courier_registry_dispatch'::regclass
     and a.attnum > 0 and not a.attisdropped;

  if v_live is distinct from v_p15 and v_live is distinct from v_p18 then
    raise exception 'P18 guard: the live courier_registry_dispatch columns are not the P15 shape. Live: %. Stop and bring it back.',
      array_to_string(v_live, ', ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The three columns (10.2)
--
-- Every existing row holds null in all three, which every check below
-- passes. The table-wide grant to service_role (P2 section 3) covers them;
-- the app never writes them.
-- ---------------------------------------------------------------------------
alter table public.courier_registry
  add column if not exists operator_checked_at timestamptz null;
alter table public.courier_registry
  add column if not exists operator_checked_by text null;
alter table public.courier_registry
  add column if not exists operator_check_deadline timestamptz null;

comment on column public.courier_registry.operator_checked_at is
  'When the founder checked this legacy courier in person (item 10, decision 1). Moves registered to buffer only, never to full. Not verification: anchoring and the trust bureau read kyc_approved_at only. Sight only; nothing about the card is stored.';
comment on column public.courier_registry.operator_checked_by is
  'Who did the in-person check, as a role label from a closed list (today founder only). Never a name.';
comment on column public.courier_registry.operator_check_deadline is
  'The sunset deadline for an operator-checked courier, set by courier_start_operator_check_sunset. Null until the sunset starts. From it, the ladder refuses the courier until PiVerify approves them.';


-- ---------------------------------------------------------------------------
-- 3. The four named checks, each added only if absent (10.2)
--
-- Guarded on pg_constraint by name, as P13 and P17 do. No check ties the new
-- columns to status: the founder sets status by hand (decision 7), and a
-- courier who was checked and later paused or approved keeps the record.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.courier_registry'::regclass
                    and conname = 'courier_registry_operator_checked_legacy_only_check') then
    alter table public.courier_registry
      add constraint courier_registry_operator_checked_legacy_only_check
      check (operator_checked_at is null or class = 'legacy');
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.courier_registry'::regclass
                    and conname = 'courier_registry_operator_check_pair_check') then
    alter table public.courier_registry
      add constraint courier_registry_operator_check_pair_check
      check ((operator_checked_at is null) = (operator_checked_by is null));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.courier_registry'::regclass
                    and conname = 'courier_registry_operator_checked_by_check') then
    alter table public.courier_registry
      add constraint courier_registry_operator_checked_by_check
      check (operator_checked_by is null or operator_checked_by in ('founder'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.courier_registry'::regclass
                    and conname = 'courier_registry_operator_check_deadline_check') then
    alter table public.courier_registry
      add constraint courier_registry_operator_check_deadline_check
      check (operator_check_deadline is null or operator_checked_at is not null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Functions
--
-- Both new functions are security definer with search_path pinned to public,
-- pg_temp, owner only (section 7). Both take the same transaction-level
-- advisory lock as their first statement, so a check and the sunset run one
-- after the other: a check cannot commit in the gap after the sunset has
-- picked its rows and land with no deadline. The key is a fixed literal,
-- 20261012, used by these two functions and nothing else.
-- ---------------------------------------------------------------------------

-- 4a. courier_record_operator_check (10.3)
--
-- IDENTITY WRITE and ATTESTATION WRITE: founder review required.
--
-- Owner only, run from the SQL editor. Takes the advisory lock, locks the
-- courier row, then checks, in this order, raising on each refusal so that a
-- refused call writes nothing:
--
--    1  p_checked_by not founder            22023  bad_checked_by
--    2  no such courier                     P0002  unknown_courier
--    3  shredded                            55000  shredded
--    4  not class legacy                    55000  not_legacy
--    5  already checked                     none   returns already_checked
--    6  the sunset has started              55000  sunset_started
--    7  status not registered               55000  not_registered
--    8  paused_reason set                   55000  paused
--    9  kyc_approved_at set                 55000  already_approved
--   10  current session rejected or failed  55000  piverify_refused
--   11  never redeemed a sign-in code       55000  never_signed_in
--
-- Guard 5 sits before 6 and 7 on purpose: a re-run on a checked courier
-- writes nothing and returns the stored values, whatever the status is now,
-- and never moves a clock. Guard 6 reads the sunset as started from the rows
-- (any operator_check_deadline set). Guard 11 counts any courier_sessions row,
-- live, expired or revoked: a session row exists only once a code is
-- redeemed (courier_sessions.code_id is not null). It reads the table and
-- locks nothing in it, keeping item 5's lock order (registry row first).
--
-- On success, one UPDATE: status buffer, buffer_since and operator_checked_at
-- both now() (the transaction start, so equal to the microsecond, which the
-- ladder's option B test relies on), operator_checked_by, updated_at.
--
-- The output columns share names with table columns, so every table
-- reference inside is qualified.
create or replace function public.courier_record_operator_check(
  p_courier_id  uuid,
  p_checked_by  text
)
returns table (courier_id uuid, outcome text, status text,
               buffer_since timestamptz, operator_checked_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_courier  public.courier_registry%rowtype;
  v_id       uuid;
  v_status   text;
  v_since    timestamptz;
  v_checked  timestamptz;
begin
  perform pg_advisory_xact_lock(20261012);

  select * into v_courier from public.courier_registry r
   where r.id = p_courier_id
     for update;

  if p_checked_by is null or p_checked_by not in ('founder') then
    raise exception 'courier_record_operator_check: checked_by must be founder: bad_checked_by'
      using errcode = '22023';
  end if;
  if v_courier.id is null then
    raise exception 'courier_record_operator_check: no courier %: unknown_courier', p_courier_id
      using errcode = 'P0002';
  end if;
  if v_courier.shredded_at is not null then
    raise exception 'courier_record_operator_check: courier % is shredded: shredded', p_courier_id
      using errcode = '55000';
  end if;
  if v_courier.class <> 'legacy' then
    raise exception 'courier_record_operator_check: courier % is a Pioneer; Pioneers are vouched, never checked: not_legacy', p_courier_id
      using errcode = '55000';
  end if;

  if v_courier.operator_checked_at is not null then
    return query select v_courier.id, 'already_checked'::text, v_courier.status,
                        v_courier.buffer_since, v_courier.operator_checked_at;
    return;
  end if;

  if exists (select 1 from public.courier_registry r
              where r.operator_check_deadline is not null) then
    raise exception 'courier_record_operator_check: the sunset has started, no new checks: sunset_started'
      using errcode = '55000';
  end if;
  if v_courier.status <> 'registered' then
    raise exception 'courier_record_operator_check: courier % is %, not registered: not_registered', p_courier_id, v_courier.status
      using errcode = '55000';
  end if;
  if v_courier.paused_reason is not null then
    raise exception 'courier_record_operator_check: courier % carries a pause: paused', p_courier_id
      using errcode = '55000';
  end if;
  if v_courier.kyc_approved_at is not null then
    raise exception 'courier_record_operator_check: courier % is already approved by PiVerify: already_approved', p_courier_id
      using errcode = '55000';
  end if;
  if v_courier.piverify_status in ('rejected', 'failed') then
    raise exception 'courier_record_operator_check: courier %''s current PiVerify session is %: piverify_refused', p_courier_id, v_courier.piverify_status
      using errcode = '55000';
  end if;
  if not exists (select 1 from public.courier_sessions s
                  where s.courier_id = v_courier.id) then
    raise exception 'courier_record_operator_check: courier % has never redeemed a sign-in code: never_signed_in', p_courier_id
      using errcode = '55000';
  end if;

  update public.courier_registry r
     set status              = 'buffer',
         buffer_since        = now(),
         operator_checked_at = now(),
         operator_checked_by = p_checked_by,
         updated_at          = now()
   where r.id = v_courier.id
  returning r.id, r.status, r.buffer_since, r.operator_checked_at
       into v_id, v_status, v_since, v_checked;

  return query select v_id, 'checked'::text, v_status, v_since, v_checked;
end;
$$;

comment on function public.courier_record_operator_check(uuid, text) is
  'Owner only. Records the founder''s in-person check of a registered legacy courier and moves them to buffer only (item 10). Not verification: anchoring and the trust bureau read kyc_approved_at only. See db/migrations/2026-10-12_courier_operator_check.sql.';


-- 4b. courier_start_operator_check_sunset (10.6)
--
-- IDENTITY WRITE: founder review required.
--
-- Owner only, no argument. Run once per network, on the day PiVerify
-- authenticates, after PIVERIFY_ENABLED=true is deployed. Takes the advisory
-- lock, then sets operator_check_deadline = now() + interval '30 days'
-- (decision 1) on every eligible row: checked, no deadline yet, not
-- shredded, not full. The 30 is written here and nowhere else; the ladder,
-- the page and the reader read the stored deadline.
--
-- With no eligible row: if the sunset has already started (some row has a
-- deadline) it returns 0 and writes nothing, so a re-run is harmless; if it
-- has not, it refuses with 55000 no_eligible_couriers, so a run either marks
-- the sunset or says it could not. The refusal comes before any UPDATE.
create or replace function public.courier_start_operator_check_sunset()
returns table (couriers_given_a_deadline integer, deadline timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deadline  timestamptz;
  v_eligible  integer;
  v_count     integer;
begin
  perform pg_advisory_xact_lock(20261012);

  v_deadline := now() + interval '30 days';

  select count(*) into v_eligible
    from public.courier_registry r
   where r.operator_checked_at is not null
     and r.operator_check_deadline is null
     and r.shredded_at is null
     and r.status <> 'full';

  if v_eligible = 0 then
    if exists (select 1 from public.courier_registry r
                where r.operator_check_deadline is not null) then
      return query select 0, null::timestamptz;
      return;
    end if;
    raise exception 'courier_start_operator_check_sunset: no checked courier is eligible for a deadline, so the sunset cannot be marked: no_eligible_couriers'
      using errcode = '55000';
  end if;

  update public.courier_registry r
     set operator_check_deadline = v_deadline,
         updated_at              = now()
   where r.operator_checked_at is not null
     and r.operator_check_deadline is null
     and r.shredded_at is null
     and r.status <> 'full';
  get diagnostics v_count = row_count;

  return query select v_count, v_deadline;
end;
$$;

comment on function public.courier_start_operator_check_sunset() is
  'Owner only. Starts the sunset for operator-checked couriers: a deadline 30 days from now on every checked, unshredded, not-full row without one (item 10, decision 1). See db/migrations/2026-10-12_courier_operator_check.sql.';


-- 4c. courier_bind_piverify_session, replaced (10.4)
--
-- ATTESTATION WRITE: founder review required.
--
-- P12's function, same signature, with one change in the UPDATE. A courier
-- in buffer through the operator check, that is
--
--   operator_checked_at is not null and status = 'buffer'
--   and buffer_since = operator_checked_at
--
-- keeps status buffer and buffer_since, while the sunset deadline has not
-- passed (operator_check_deadline is null or now() < operator_check_deadline).
-- Past the deadline the bind resets them to registered as it does everyone,
-- whether or not the founder's hand pause has landed. Every other row is
-- bound exactly as P12 binds it, the operator-pause rule included.
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
         -- P18: a courier in buffer through the operator check, before the
         -- sunset deadline, keeps buffer_since and status.
         buffer_since            = case when r.operator_checked_at is not null
                                         and r.status = 'buffer'
                                         and r.buffer_since = r.operator_checked_at
                                         and (r.operator_check_deadline is null
                                              or now() < r.operator_check_deadline)
                                        then r.buffer_since else null end,
         status                  = case when coalesce(r.paused_reason, '') = 'operator'
                                        then r.status
                                        when r.operator_checked_at is not null
                                         and r.status = 'buffer'
                                         and r.buffer_since = r.operator_checked_at
                                         and (r.operator_check_deadline is null
                                              or now() < r.operator_check_deadline)
                                        then r.status
                                        else 'registered' end,
         paused_reason           = case when coalesce(r.paused_reason, '') = 'operator'
                                        then r.paused_reason else null end,
         updated_at              = now()
   where r.id = v_courier.id;

  return query select 'bound'::text, p_new_session_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. courier_registry_dispatch, replaced (10.8)
--
-- Columns 1 to 9 are P15 section 2 verbatim, in order. Columns 10 and 11 are
-- the only additions: two times, no person. Never operator_checked_by.
-- ---------------------------------------------------------------------------
create or replace view public.courier_registry_dispatch
  with (security_invoker = false)
as
  select
    left(id::text, 8) as courier_ref,
    class,
    status,
    buffer_since,
    piverify_status,
    piverify_status_at,
    paused_reason,
    shredded_at,
    piverify_allowed_action,
    operator_checked_at,
    operator_check_deadline
  from public.courier_registry;

comment on view public.courier_registry_dispatch is
  'Dispatch reader view of courier_registry: the courier reference (first 8 characters of the id), the ladder columns, piverify_allowed_action, operator_checked_at and operator_check_deadline only. No pi_username, salt, session id, auth link, full id or operator_checked_by. gyema_reader SELECT only; nobody else, service_role included, because the view is automatically updatable. See db/migrations/2026-10-10_courier_registry_dispatch_view.sql and db/migrations/2026-10-12_courier_operator_check.sql.';


-- ---------------------------------------------------------------------------
-- 6. The view's privileges, repeated from P15 section 3
--
-- create or replace keeps grants, but the view is automatically updatable,
-- so the revoke from everyone and the one grant are restated here.
-- ---------------------------------------------------------------------------
revoke all on public.courier_registry_dispatch from public, anon, authenticated, service_role;
grant select on public.courier_registry_dispatch to gyema_reader;


-- ---------------------------------------------------------------------------
-- 7. Function privileges (CLAUDE.md invariant 2)
--
-- The two new functions: owner only, revoked from everyone, service_role
-- included, granted to no role. The owner keeps EXECUTE through ownership.
-- The bind: service_role only, restated from P12.
-- ---------------------------------------------------------------------------
revoke all on function public.courier_record_operator_check(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.courier_start_operator_check_sunset()
  from public, anon, authenticated, service_role;

revoke all on function public.courier_bind_piverify_session(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.courier_bind_piverify_session(uuid, text, text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 8. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- Anything false is a finding: stop and paste it back before going further.
-- Function grants are read from pg_proc.proacl, with a null ACL read as the
-- built in default, so a function nobody revoked shows PUBLIC rather than
-- nothing. View grants are read from pg_class.relacl the same way.
-- ---------------------------------------------------------------------------
with
col as (
  select a.attname::text as name, a.attnum,
         format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as nullable,
         pg_get_expr(d.adbin, d.adrelid) as default_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.courier_registry'::regclass
     and a.attnum > 0 and not a.attisdropped
),
expected_columns(name, data_type) as (
  values ('operator_checked_at', 'timestamp with time zone'),
         ('operator_checked_by', 'text'),
         ('operator_check_deadline', 'timestamp with time zone')
),
chk as (
  select k.conname, k.convalidated, pg_get_constraintdef(k.oid) as def
    from pg_constraint k
   where k.conrelid = 'public.courier_registry'::regclass
     and k.contype = 'c'
),
expected_checks(name, pattern) as (
  values ('courier_registry_operator_checked_legacy_only_check',
          'operator_checked_at IS NULL.*class = ''legacy''::text'),
         ('courier_registry_operator_check_pair_check',
          'operator_checked_at IS NULL.*=.*operator_checked_by IS NULL'),
         ('courier_registry_operator_checked_by_check',
          'operator_checked_by IS NULL.*operator_checked_by = .*''founder''::text'),
         ('courier_registry_operator_check_deadline_check',
          'operator_check_deadline IS NULL.*operator_checked_at IS NOT NULL')
),
-- kind: owner (no grantee at all) or service (service_role alone).
expected_functions(name, args, kind) as (
  values ('courier_record_operator_check', 'p_courier_id uuid, p_checked_by text', 'owner'),
         ('courier_start_operator_check_sunset', '', 'owner'),
         ('courier_bind_piverify_session',
          'p_courier_id uuid, p_expected_session_id text, p_new_session_id text, p_status text', 'service')
),
fn as (
  select e.name, e.args, e.kind, p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.prosrc
    from expected_functions e
    left join pg_namespace n on n.nspname = 'public'
    left join pg_proc p on p.pronamespace = n.oid and p.proname = e.name
                       and pg_get_function_identity_arguments(p.oid) = e.args
),
facl as (
  select f.name,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from fn f
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
   where f.oid is not null and a.grantee <> f.proowner
),
v as (
  select c.oid, c.reloptions, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'courier_registry_dispatch' and c.relkind = 'v'
),
vcols as (
  select a.attnum, a.attname::text as name
    from v
    join pg_attribute a on a.attrelid = v.oid
   where a.attnum > 0 and not a.attisdropped
),
vacl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from v
    cross join lateral aclexplode(coalesce(v.relacl, acldefault('r', v.relowner))) a
   where a.grantee <> v.relowner
),
expected_view(pos, name) as (
  values (1, 'courier_ref'), (2, 'class'), (3, 'status'), (4, 'buffer_since'),
         (5, 'piverify_status'), (6, 'piverify_status_at'), (7, 'paused_reason'), (8, 'shredded_at'),
         (9, 'piverify_allowed_action'), (10, 'operator_checked_at'), (11, 'operator_check_deadline')
),
rows as (
  select 'column courier_registry.' || e.name || ', ' || e.data_type || ', nullable, no default' as object,
         coalesce((select c.data_type = e.data_type and c.nullable and c.default_expr is null
                     from col c where c.name = e.name), false) as present,
         (select c.data_type from col c where c.name = e.name) as detail
    from expected_columns e
  union all
  select 'courier_registry carries twenty columns',
         (select count(*) from col) = 20,
         (select count(*)::text from col)
  union all
  select 'constraint ' || e.name || ', validated, as designed',
         coalesce((select k.convalidated and k.def ~ e.pattern from chk k where k.conname = e.name), false),
         (select k.def from chk k where k.conname = e.name)
    from expected_checks e
  union all
  select 'courier_registry carries nineteen constraints (fifteen after P17, plus these four)',
         (select count(*) from pg_constraint
           where conrelid = 'public.courier_registry'::regclass) = 19,
         (select count(*)::text from pg_constraint
           where conrelid = 'public.courier_registry'::regclass)
  union all
  select 'function ' || f.name || '(' || f.args || ')', f.oid is not null, null
    from fn f
  union all
  select f.name || ' has exactly one signature',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f.name) = 1,
         (select string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f.name)
    from fn f
  union all
  select f.name || ' is security definer', coalesce(f.prosecdef, false), null
    from fn f
  union all
  select f.name || ' pins search_path',
         coalesce(array_to_string(f.proconfig, ',') like '%search_path%', false),
         array_to_string(f.proconfig, ',')
    from fn f
  union all
  select f.name || ': EXECUTE for no role but the owner',
         f.oid is not null and not exists (select 1 from facl where facl.name = f.name),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee)
            from facl where facl.name = f.name)
    from fn f where f.kind = 'owner'
  union all
  select 'service_role cannot execute ' || f.name,
         f.oid is not null
         and not has_function_privilege('service_role', f.oid, 'EXECUTE')
         and not exists (select 1 from facl where facl.name = f.name
                          and grantee in ('service_role', 'PUBLIC') and privilege_type = 'EXECUTE'),
         'has_function_privilege: '
         || coalesce(case when f.oid is null then null
                          else has_function_privilege('service_role', f.oid, 'EXECUTE')::text end, 'n/a')
    from fn f where f.kind = 'owner'
  union all
  select f.name || ': EXECUTE for service_role only',
         f.oid is not null
         and not exists (select 1 from facl where facl.name = f.name and grantee <> 'service_role')
         and exists (select 1 from facl where facl.name = f.name
                      and grantee = 'service_role' and privilege_type = 'EXECUTE'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee)
            from facl where facl.name = f.name)
    from fn f where f.kind = 'service'
  union all
  select 'courier_bind_piverify_session keeps buffer for a checked courier before the deadline',
         coalesce((select prosrc ~ 'r\.buffer_since = r\.operator_checked_at'
                          and prosrc ~ 'now\(\) < r\.operator_check_deadline'
                     from fn where name = 'courier_bind_piverify_session'), false),
         null
  union all
  select 'both new functions take advisory lock 20261012',
         coalesce((select bool_and(prosrc ~ 'pg_advisory_xact_lock\(20261012\)')
                     from fn where name in ('courier_record_operator_check',
                                            'courier_start_operator_check_sunset')), false),
         null
  union all
  select 'view public.courier_registry_dispatch, security_invoker false',
         coalesce((select 'security_invoker=false' = any(reloptions) from v), false),
         (select array_to_string(reloptions, ',') from v)
  union all
  select 'courier_registry_dispatch: exactly 11 columns, by name, in order',
         (select count(*) from vcols) = 11
         and not exists (select 1 from expected_view e left join vcols c on c.attnum = e.pos
                          where c.name is distinct from e.name),
         (select string_agg(attnum || ':' || name, ', ' order by attnum) from vcols)
  union all
  select 'courier_registry_dispatch carries no operator_checked_by, pi_username, commitment_salt, piverify_session_id, auth_user_id or id',
         exists (select 1 from v)
         and not exists (select 1 from vcols where name in ('operator_checked_by', 'pi_username', 'commitment_salt',
                                                            'piverify_session_id', 'auth_user_id', 'id')),
         null
  union all
  select 'courier_registry_dispatch: gyema_reader holds exactly SELECT, nobody else holds anything',
         exists (select 1 from v)
         and coalesce((select array_agg(privilege_type order by privilege_type) from vacl where grantee = 'gyema_reader')
                      = array['SELECT']::text[], false)
         and not exists (select 1 from vacl where grantee <> 'gyema_reader'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type) from vacl)
  union all
  select 'no operator-checked row is a Pioneer, or lacks its who',
         not exists (select 1 from public.courier_registry r
                      where r.operator_checked_at is not null
                        and (r.class <> 'legacy' or r.operator_checked_by is null)),
         null
)
select jsonb_pretty(jsonb_build_object(
  'courier_operator_check_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as courier_operator_check_verification;
