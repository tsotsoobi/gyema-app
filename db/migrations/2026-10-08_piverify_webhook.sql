-- ===========================================================================
-- 2026-10-08  PiVerify webhook: processed events, and the one write path for
--             KYC status onto courier_registry
-- ===========================================================================
--
-- WHAT THIS IS
--
-- Phase 1 item 3. The PiVerify webhook (app/api/kyc/webhook/route.ts) used to
-- write whatever status the payload carried straight onto a row. Its
-- signature has no timestamp, so a captured request replays and verifies, and
-- nothing ordered the writes, so a replayed "started" could overwrite
-- "approved". This file gives the route one place to write instead, which
-- decides everything under a row lock in a single transaction:
--
--   public.piverify_events          every event id the webhook has
--                                   processed, and what came of it
--   public.courier_apply_kyc_status the only path from a PiVerify status to
--                                   courier_registry
--
-- WHAT THE ROUTE PASSES AND WHERE IT COMES FROM
--
-- The route checks the HMAC, reads the event id, type and session id from the
-- payload, then re-fetches the session from PiVerify. It passes the
-- RE-FETCHED status and external_user_id here, never the payload's. A replay
-- of an old event therefore carries no power: at most it reports what
-- PiVerify says now, and its event id is already stored.
--
-- THE RULES, all inside courier_apply_kyc_status
--
--   1. One event id is processed once. A second arrival returns duplicate and
--      changes nothing.
--   2. Forward only. created 0, started 1, pending_review 2, then approved,
--      rejected and failed at 3, terminal. A status at or below the courier's
--      current rank is not_forward and changes nothing.
--   3. The courier is the one PiVerify names (external_user_id is the
--      courier_registry id Gyema supplied at session creation), and the
--      session must be the one bound to that courier. This webhook never binds
--      a session: whatever creates the session writes piverify_session_id.
--   4. Approval is recorded once per courier. A courier already holding
--      kyc_approved_at gets not_forward for any further event, from any
--      session. A unique index on piverify_events backs this up.
--   5. A pause the operator set by hand (paused_reason = 'operator') is never
--      lifted by a webhook. The session's facts (piverify_status,
--      kyc_approved_at, buffer_since) are still recorded on that row; only
--      status is left alone.
--
-- OUTCOMES
--
--   Stored on piverify_events, and the route answers 200:
--     applied, not_forward, unknown_courier, stale_session,
--     external_user_mismatch, shredded
--   Returned but NOT stored:
--     duplicate          the event id is already stored; 200
--     session_not_bound  the courier exists but has no session bound yet.
--                        PiVerify can fire before the app's write lands, so
--                        the event is left unrecorded and the route answers
--                        503, and PiVerify retries.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Requires 2026-10-08_courier_registry.sql
-- first. Run the whole file; its last statement is a read-only verification.
--
-- IDEMPOTENT. if not exists on the table and index, create or replace on the
-- function, and revokes and grants that are no-ops when already in place.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Processed events
--
-- No personal data: an event id, its type, a session id, a courier id and a
-- status. received_at is when this webhook first saw the event.
--
-- outcome 'pending' exists only inside the transaction that inserts the row:
-- courier_apply_kyc_status inserts the event id first, so a concurrent copy
-- of the same event waits on the primary key, and replaces 'pending' before
-- it returns. A committed 'pending' row would mean the function changed
-- without this file; section 4 counts them.
-- ---------------------------------------------------------------------------
create table if not exists public.piverify_events (
  event_id         text        not null,
  event_type       text        not null,
  session_id       text        not null,
  courier_id       uuid        null,
  piverify_status  text        null,
  outcome          text        not null,
  received_at      timestamptz not null default now(),

  constraint piverify_events_pkey
    primary key (event_id),

  constraint piverify_events_courier_id_fkey
    foreign key (courier_id) references public.courier_registry (id),

  constraint piverify_events_lengths_check
    check (length(event_id) between 1 and 128
           and length(event_type) between 1 and 64
           and length(session_id) between 1 and 128),

  constraint piverify_events_status_check
    check (piverify_status is null
           or piverify_status in ('created', 'started', 'pending_review',
                                  'approved', 'rejected', 'failed')),

  constraint piverify_events_outcome_check
    check (outcome in ('pending', 'applied', 'not_forward', 'unknown_courier',
                       'stale_session', 'external_user_mismatch', 'shredded'))
);

comment on table public.piverify_events is
  'Every PiVerify webhook event id processed, with its outcome. Written only by courier_apply_kyc_status. service_role reads; nothing else.';

-- Approval is applied at most once per courier, whatever the function does.
create unique index if not exists piverify_events_one_approval_per_courier
  on public.piverify_events (courier_id)
  where outcome = 'applied' and piverify_status = 'approved';


-- ---------------------------------------------------------------------------
-- 2. The one write path
--
-- ATTESTATION WRITE: founder review required.
--
-- security definer, search_path pinned, EXECUTE for service_role alone
-- (section 3). It trusts p_status and p_external_user_id completely, which is
-- safe only because the one caller that can reach it is the webhook route,
-- and the route takes both from the session it re-fetched from PiVerify.
-- ---------------------------------------------------------------------------
create or replace function public.courier_apply_kyc_status(
  p_event_id          text,
  p_event_type        text,
  p_session_id        text,
  p_external_user_id  text,
  p_status            text
)
returns table (outcome text, courier_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_courier      public.courier_registry%rowtype;
  v_courier_id   uuid;
  v_inserted     text;
  v_new_rank     integer;
  v_cur_rank     integer;
  v_status       text;
begin
  -- The route validates all of these. Repeated here because this is the
  -- function that writes, and a bad value must never reach a row.
  if p_status is null or p_status not in ('created', 'started', 'pending_review',
                                          'approved', 'rejected', 'failed') then
    raise exception 'courier_apply_kyc_status: unknown status %', p_status;
  end if;
  if coalesce(p_event_id, '') = '' or coalesce(p_session_id, '') = ''
     or coalesce(p_event_type, '') = '' then
    raise exception 'courier_apply_kyc_status: event id, type and session id are required';
  end if;

  -- Rule 3, first half: the courier PiVerify names, locked for the rest of
  -- this transaction so two events for one courier apply one after the other.
  if p_external_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_courier_id := p_external_user_id::uuid;
    select * into v_courier from public.courier_registry
     where id = v_courier_id
       for update;
  end if;

  -- Rule 1. Insert the event id before anything else is decided. A replay
  -- conflicts here and leaves.
  insert into public.piverify_events (event_id, event_type, session_id, outcome)
  values (p_event_id, p_event_type, p_session_id, 'pending')
  on conflict (event_id) do nothing
  returning event_id into v_inserted;

  if v_inserted is null then
    return query select 'duplicate'::text, v_courier.status;
    return;
  end if;

  if v_courier.id is null then
    update public.piverify_events set outcome = 'unknown_courier', piverify_status = p_status
     where event_id = p_event_id;
    return query select 'unknown_courier'::text, null::text;
    return;
  end if;

  if v_courier.shredded_at is not null then
    update public.piverify_events set outcome = 'shredded', courier_id = v_courier.id,
           piverify_status = p_status
     where event_id = p_event_id;
    return query select 'shredded'::text, v_courier.status;
    return;
  end if;

  -- Rule 3, second half. The session is bound to someone else: PiVerify's
  -- external_user_id and Gyema's binding disagree.
  if exists (select 1 from public.courier_registry r
              where r.piverify_session_id = p_session_id and r.id <> v_courier.id) then
    update public.piverify_events set outcome = 'external_user_mismatch',
           courier_id = v_courier.id, piverify_status = p_status
     where event_id = p_event_id;
    return query select 'external_user_mismatch'::text, v_courier.status;
    return;
  end if;

  -- Not bound yet: leave no trace, so PiVerify's retry is processed.
  if v_courier.piverify_session_id is null then
    delete from public.piverify_events where event_id = p_event_id;
    return query select 'session_not_bound'::text, v_courier.status;
    return;
  end if;

  -- Bound to a different, later session: this event is about an old one.
  if v_courier.piverify_session_id <> p_session_id then
    update public.piverify_events set outcome = 'stale_session', courier_id = v_courier.id,
           piverify_status = p_status
     where event_id = p_event_id;
    return query select 'stale_session'::text, v_courier.status;
    return;
  end if;

  -- Rules 2 and 4.
  v_new_rank := case p_status when 'created' then 0 when 'started' then 1
                              when 'pending_review' then 2 else 3 end;
  v_cur_rank := case v_courier.piverify_status
                  when 'created' then 0 when 'started' then 1
                  when 'pending_review' then 2
                  when 'approved' then 3 when 'rejected' then 3 when 'failed' then 3
                  else -1 end;

  if v_new_rank <= v_cur_rank or v_courier.kyc_approved_at is not null then
    update public.piverify_events set outcome = 'not_forward', courier_id = v_courier.id,
           piverify_status = p_status
     where event_id = p_event_id;
    return query select 'not_forward'::text, v_courier.status;
    return;
  end if;

  -- The ladder. Rule 5: an operator pause keeps its status.
  v_status := v_courier.status;
  if coalesce(v_courier.paused_reason, '') <> 'operator' then
    if p_status = 'pending_review' and v_courier.status = 'registered' then
      v_status := 'buffer';
    elsif p_status = 'approved' then
      v_status := 'full';
    elsif p_status in ('rejected', 'failed') then
      v_status := 'paused';
    end if;
  end if;

  update public.courier_registry
     set piverify_status    = p_status,
         piverify_status_at = now(),
         buffer_since       = case when p_status = 'pending_review'
                                   then coalesce(buffer_since, now()) else buffer_since end,
         kyc_approved_at    = case when p_status = 'approved'
                                   then coalesce(kyc_approved_at, now()) else kyc_approved_at end,
         status             = v_status,
         -- A KYC result replaces a timeout reason; an operator reason stands.
         paused_reason      = case when coalesce(paused_reason, '') = 'operator'
                                   then paused_reason
                                   when v_status = 'paused' then p_status
                                   when v_status = 'full' then null
                                   else paused_reason end,
         updated_at         = now()
   where id = v_courier.id;

  update public.piverify_events set outcome = 'applied', courier_id = v_courier.id,
         piverify_status = p_status
   where event_id = p_event_id;

  return query select 'applied'::text, v_status;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Lock both to service_role (CLAUDE.md invariant 2)
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and PostgREST exposes
-- public functions to anon and authenticated. Without the revoke, anyone with
-- the anon key could post a status for any courier. ALTER DEFAULT PRIVILEGES
-- cannot prevent that for functions (grant baseline, section 1a), so it is
-- revoked here, the same day the function is written.
--
-- service_role reads piverify_events and writes nothing to it directly: only
-- the function writes, as its owner.
-- ---------------------------------------------------------------------------
alter table public.piverify_events enable row level security;

revoke all on table public.piverify_events from public, anon, authenticated;
revoke all on table public.piverify_events from service_role;
grant select on table public.piverify_events to service_role;

revoke all on function public.courier_apply_kyc_status(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.courier_apply_kyc_status(text, text, text, text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 4. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row should read present true. Grants and EXECUTE are
-- read from the catalog ACLs, the source catalog checks 3b and 7 trust.
-- ---------------------------------------------------------------------------
with
t as (
  select c.oid, c.relrowsecurity, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'piverify_events' and c.relkind = 'r'
),
tacl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from t
    cross join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
   where a.grantee <> t.relowner
),
f as (
  select p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'courier_apply_kyc_status'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_event_id text, p_event_type text, p_session_id text, p_external_user_id text, p_status text'
),
facl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from f
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
   where a.grantee <> f.proowner
),
expected_constraints(name) as (
  values ('piverify_events_pkey'), ('piverify_events_courier_id_fkey'),
         ('piverify_events_lengths_check'), ('piverify_events_status_check'),
         ('piverify_events_outcome_check')
),
rows as (
  select 'table public.piverify_events' as object, exists (select 1 from t) as present, null::text as detail
  union all
  select 'row level security enabled on piverify_events', coalesce((select relrowsecurity from t), false), null
  union all
  select 'no policies on piverify_events',
         not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'piverify_events'),
         null
  union all
  select 'constraint ' || e.name,
         exists (select 1 from pg_constraint k where k.conrelid = (select oid from t) and k.conname = e.name),
         (select pg_get_constraintdef(k.oid) from pg_constraint k
           where k.conrelid = (select oid from t) and k.conname = e.name)
    from expected_constraints e
  union all
  select 'index piverify_events_one_approval_per_courier',
         exists (select 1 from pg_indexes i where i.schemaname = 'public'
                  and i.indexname = 'piverify_events_one_approval_per_courier'),
         (select i.indexdef from pg_indexes i where i.schemaname = 'public'
           and i.indexname = 'piverify_events_one_approval_per_courier')
  union all
  select 'piverify_events: anon, authenticated, PUBLIC and gyema_reader hold nothing',
         not exists (select 1 from tacl where grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader')),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
            from tacl where grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader'))
  union all
  select 'piverify_events: service_role holds exactly SELECT',
         coalesce((select array_agg(privilege_type order by privilege_type) from tacl where grantee = 'service_role')
                  = array['SELECT']::text[], false),
         (select string_agg(privilege_type, ', ' order by privilege_type) from tacl where grantee = 'service_role')
  union all
  select 'function courier_apply_kyc_status(text x5)', exists (select 1 from f), null
  union all
  select 'courier_apply_kyc_status is security definer', coalesce((select prosecdef from f), false), null
  union all
  select 'courier_apply_kyc_status pins search_path',
         coalesce((select array_to_string(proconfig, ',') like '%search_path%' from f), false),
         (select array_to_string(proconfig, ',') from f)
  union all
  select 'courier_apply_kyc_status: EXECUTE for service_role only',
         exists (select 1 from f)
         and not exists (select 1 from facl where grantee <> 'service_role')
         and exists (select 1 from facl where grantee = 'service_role' and privilege_type = 'EXECUTE'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee) from facl)
  union all
  select 'no event left pending',
         not exists (select 1 from public.piverify_events where outcome = 'pending'),
         null
)
select jsonb_pretty(jsonb_build_object(
  'piverify_webhook_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as piverify_webhook_verification;
