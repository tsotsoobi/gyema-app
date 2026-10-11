-- ===========================================================================
-- 2026-10-08  PiVerify resubmission and appeal: a rejection that offers a
--             further action is not final
-- ===========================================================================
--
-- WHAT THIS IS
--
-- A fix to Phase 1 item 3, in its own file because
-- 2026-10-08_piverify_webhook.sql is already applied and is not edited.
--
-- That file treats rejected as terminal. PiVerify's documentation says
-- otherwise: a rejected session can carry allowed_action, RESUBMIT or APPEAL,
-- and when it does the courier goes back through the hosted flow ON THE SAME
-- SESSION, which can then move to started, pending_review and approved
-- again. Under the old function every one of those events read not_forward,
-- and the courier stayed paused for good. A rejection with no allowed_action
-- is final, and stays final here.
--
-- WHAT THIS DOES
--
--   1. courier_registry.piverify_allowed_action: the allowed_action of the
--      courier's current rejection, as the re-fetched session reports it.
--      Null unless piverify_status is rejected, which a check enforces.
--   2. piverify_events.allowed_action: what the re-fetched session said, per
--      event, for the record. Nothing decides on it.
--   3. courier_apply_kyc_status gains a sixth argument, p_allowed_action.
--      The five-argument version is DROPPED, not left beside it: a
--      create or replace with a new argument list makes a second function,
--      and the old one would still accept calls that ignore allowed_action.
--
-- THE RULES, all of the old ones kept, with one addition
--
--   A courier whose piverify_status is rejected AND whose stored
--   piverify_allowed_action is not null is REOPENED: on the bound session,
--   started, pending_review, approved and failed apply, as does a further
--   rejected that carries a different allowed_action (null makes it final).
--   created does not apply: a session never goes back to created. Everything
--   else is as before:
--
--   - one event id is processed once
--   - forward only, outside a reopened rejection
--   - approval recorded once per courier: kyc_approved_at still stops
--     everything, and the unique index on piverify_events still backs it up
--   - the session must be the one bound to the courier PiVerify names
--   - an operator pause is never lifted
--   - a full courier is never demoted (it holds kyc_approved_at)
--
-- STATUS DURING A RESUBMISSION, a choice for review: the ladder is unchanged.
-- A rejected courier is paused with reason rejected, and stays paused, with
-- that reason, through started and pending_review. Approval takes them to
-- full and clears the reason, as it does for a timeout pause. They do not
-- return to buffer while the resubmission is reviewed.
--
-- One correction the reopen needs: the old function wrote p_status into
-- paused_reason whenever the courier ended up paused. A paused courier
-- receiving started is now the normal resubmission path, and that line would
-- have written 'started', which the paused_reason check refuses. A reason is
-- now written only for rejected and failed.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Requires 2026-10-08_courier_registry.sql
-- and 2026-10-08_piverify_webhook.sql first; without them it errors at the
-- first statement that needs them. Apply it BEFORE the webhook code deploys: the route
-- calls the six-argument function, and until it exists every signed webhook
-- answers 500. Run the whole file; its last statement is a read-only
-- verification.
--
-- DO NOT RE-RUN 2026-10-08_piverify_webhook.sql AFTER THIS FILE. It would
-- create the five-argument function again beside this one. The verification
-- below and catalog check 9 both count the signatures and read false if that
-- happens; the fix is to run this file again.
--
-- IDEMPOTENT. add column if not exists, constraints added only when their
-- name is absent, drop function if exists, create or replace, and revokes and
-- grants that are no-ops when already in place.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Both tables' existing grants are table-wide (service_role SELECT, INSERT,
-- UPDATE on courier_registry; SELECT on piverify_events), so the new columns
-- need no grant of their own.
-- ---------------------------------------------------------------------------
alter table public.courier_registry
  add column if not exists piverify_allowed_action text null;

alter table public.piverify_events
  add column if not exists allowed_action text null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.courier_registry'::regclass
                    and conname = 'courier_registry_piverify_allowed_action_check') then
    alter table public.courier_registry
      add constraint courier_registry_piverify_allowed_action_check
      check (piverify_allowed_action is null
             or (piverify_allowed_action in ('RESUBMIT', 'APPEAL')
                 and piverify_status = 'rejected'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.piverify_events'::regclass
                    and conname = 'piverify_events_allowed_action_check') then
    alter table public.piverify_events
      add constraint piverify_events_allowed_action_check
      check (allowed_action is null or allowed_action in ('RESUBMIT', 'APPEAL'));
  end if;
end $$;

comment on column public.courier_registry.piverify_allowed_action is
  'RESUBMIT or APPEAL while the current rejection allows one; null otherwise, and a rejection with null here is final. Written only by courier_apply_kyc_status.';


-- ---------------------------------------------------------------------------
-- 2. The one write path, replacing the five-argument version
--
-- ATTESTATION WRITE: founder review required.
--
-- security definer, search_path pinned, EXECUTE for service_role alone
-- (section 3). It trusts its status, external_user_id and allowed_action
-- completely, which is safe only because the one caller that can reach it is
-- the webhook route, and the route takes all three from the session it
-- re-fetched from PiVerify.
-- ---------------------------------------------------------------------------
drop function if exists public.courier_apply_kyc_status(text, text, text, text, text);

create or replace function public.courier_apply_kyc_status(
  p_event_id          text,
  p_event_type        text,
  p_session_id        text,
  p_external_user_id  text,
  p_status            text,
  p_allowed_action    text
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
  v_action       text;
  v_reopened     boolean;
begin
  -- The route validates all of these. Repeated here because this is the
  -- function that writes, and a bad value must never reach a row.
  if p_status is null or p_status not in ('created', 'started', 'pending_review',
                                          'approved', 'rejected', 'failed') then
    raise exception 'courier_apply_kyc_status: unknown status %', p_status;
  end if;
  if p_allowed_action is not null and p_allowed_action not in ('RESUBMIT', 'APPEAL') then
    raise exception 'courier_apply_kyc_status: unknown allowed_action %', p_allowed_action;
  end if;
  if coalesce(p_event_id, '') = '' or coalesce(p_session_id, '') = ''
     or coalesce(p_event_type, '') = '' then
    raise exception 'courier_apply_kyc_status: event id, type and session id are required';
  end if;

  -- allowed_action belongs to a rejection. On any other status it is dropped,
  -- so a stray value can neither be stored nor fail the check.
  v_action := case when p_status = 'rejected' then p_allowed_action end;

  -- The courier PiVerify names, locked for the rest of this transaction so
  -- two events for one courier apply one after the other.
  if p_external_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_courier_id := p_external_user_id::uuid;
    select * into v_courier from public.courier_registry
     where id = v_courier_id
       for update;
  end if;

  -- One event id, once. Inserted before anything else is decided; a replay
  -- conflicts here and leaves.
  insert into public.piverify_events (event_id, event_type, session_id, outcome, allowed_action)
  values (p_event_id, p_event_type, p_session_id, 'pending', v_action)
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

  -- The session is bound to someone else: PiVerify's external_user_id and
  -- Gyema's binding disagree.
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

  -- Forward only, approval once, and the one exception: a rejection that
  -- offered RESUBMIT or APPEAL reopens the session. Its rank drops to that of
  -- created, so started and everything after it are forward again.
  v_reopened := v_courier.piverify_status = 'rejected'
                and v_courier.piverify_allowed_action is not null;

  v_new_rank := case p_status when 'created' then 0 when 'started' then 1
                              when 'pending_review' then 2 else 3 end;
  v_cur_rank := case
                  when v_reopened then 0
                  else case v_courier.piverify_status
                         when 'created' then 0 when 'started' then 1
                         when 'pending_review' then 2
                         when 'approved' then 3 when 'rejected' then 3 when 'failed' then 3
                         else -1 end
                end;

  if v_new_rank <= v_cur_rank
     or v_courier.kyc_approved_at is not null
     -- A reopened rejection reported again with the same allowed_action is
     -- the same fact, not a move.
     or (v_reopened and p_status = 'rejected'
         and v_action is not distinct from v_courier.piverify_allowed_action) then
    update public.piverify_events set outcome = 'not_forward', courier_id = v_courier.id,
           piverify_status = p_status
     where event_id = p_event_id;
    return query select 'not_forward'::text, v_courier.status;
    return;
  end if;

  -- The ladder, unchanged. An operator pause keeps its status.
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
     set piverify_status         = p_status,
         piverify_allowed_action = v_action,
         piverify_status_at      = now(),
         buffer_since            = case when p_status = 'pending_review'
                                        then coalesce(buffer_since, now()) else buffer_since end,
         kyc_approved_at         = case when p_status = 'approved'
                                        then coalesce(kyc_approved_at, now()) else kyc_approved_at end,
         status                  = v_status,
         -- A KYC result replaces a timeout reason; an operator reason stands.
         -- A resubmission in progress keeps the reason it was paused for.
         paused_reason           = case when coalesce(paused_reason, '') = 'operator'
                                        then paused_reason
                                        when v_status = 'paused' and p_status in ('rejected', 'failed')
                                        then p_status
                                        when v_status = 'full' then null
                                        else paused_reason end,
         updated_at              = now()
   where id = v_courier.id;

  update public.piverify_events set outcome = 'applied', courier_id = v_courier.id,
         piverify_status = p_status
   where event_id = p_event_id;

  return query select 'applied'::text, v_status;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Lock it to service_role (CLAUDE.md invariant 2)
--
-- A new function is executable by PUBLIC until revoked, whatever the default
-- privileges say (2026-10-08_default_function_privileges.sql), so it is
-- revoked here, in the same file that creates it.
-- ---------------------------------------------------------------------------
revoke all on function public.courier_apply_kyc_status(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.courier_apply_kyc_status(text, text, text, text, text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 4. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row should read present true.
-- ---------------------------------------------------------------------------
with
f as (
  select p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'courier_apply_kyc_status'
),
f6 as (
  select * from f
   where args = 'p_event_id text, p_event_type text, p_session_id text, p_external_user_id text, '
                || 'p_status text, p_allowed_action text'
),
facl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from f6
    cross join lateral aclexplode(coalesce(f6.proacl, acldefault('f', f6.proowner))) a
   where a.grantee <> f6.proowner
),
cols as (
  select c.table_name, c.column_name, c.data_type, c.is_nullable
    from information_schema.columns c
   where c.table_schema = 'public'
     and ((c.table_name = 'courier_registry' and c.column_name = 'piverify_allowed_action')
          or (c.table_name = 'piverify_events' and c.column_name = 'allowed_action'))
),
rows as (
  select 'column courier_registry.piverify_allowed_action, text, nullable' as object,
         exists (select 1 from cols where table_name = 'courier_registry'
                  and data_type = 'text' and is_nullable = 'YES') as present,
         null::text as detail
  union all
  select 'column piverify_events.allowed_action, text, nullable',
         exists (select 1 from cols where table_name = 'piverify_events'
                  and data_type = 'text' and is_nullable = 'YES'),
         null
  union all
  select 'constraint courier_registry_piverify_allowed_action_check',
         exists (select 1 from pg_constraint where conrelid = 'public.courier_registry'::regclass
                  and conname = 'courier_registry_piverify_allowed_action_check'),
         (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.courier_registry'::regclass
           and conname = 'courier_registry_piverify_allowed_action_check')
  union all
  select 'constraint piverify_events_allowed_action_check',
         exists (select 1 from pg_constraint where conrelid = 'public.piverify_events'::regclass
                  and conname = 'piverify_events_allowed_action_check'),
         (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.piverify_events'::regclass
           and conname = 'piverify_events_allowed_action_check')
  union all
  select 'function courier_apply_kyc_status(text x6)', exists (select 1 from f6), null
  union all
  select 'courier_apply_kyc_status has exactly one signature, the six-argument one',
         (select count(*) from f) = 1 and exists (select 1 from f6),
         (select string_agg(args, ' | ') from f)
  union all
  select 'courier_apply_kyc_status is security definer', coalesce((select prosecdef from f6), false), null
  union all
  select 'courier_apply_kyc_status pins search_path',
         coalesce((select array_to_string(proconfig, ',') like '%search_path%' from f6), false),
         (select array_to_string(proconfig, ',') from f6)
  union all
  select 'courier_apply_kyc_status: EXECUTE for service_role only',
         exists (select 1 from f6)
         and not exists (select 1 from facl where grantee <> 'service_role')
         and exists (select 1 from facl where grantee = 'service_role' and privilege_type = 'EXECUTE'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee) from facl)
  union all
  select 'no event left pending',
         not exists (select 1 from public.piverify_events where outcome = 'pending'),
         null
)
select jsonb_pretty(jsonb_build_object(
  'piverify_resubmission_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as piverify_resubmission_verification;
