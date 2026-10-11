-- ===========================================================================
-- 2026-10-11  courier_registry timing checks
-- ===========================================================================
--
-- Two named checks on public.courier_registry:
--
--   courier_registry_full_needs_approval_check
--     status <> 'full' or kyc_approved_at is not null or vouched_at is not null
--     A full courier reached full through PiVerify or through the founder's
--     vouch (item 6, decision A), and the row says which.
--
--   courier_registry_buffer_needs_since_check
--     status <> 'buffer' or buffer_since is not null
--     A buffer courier carries the start of its 30-day clock; without it the
--     ladder (lib/courier-ladder.ts) cannot compute the pause.
--
-- THIS REVERSES A RECORDED DECISION (founder decision, 11 Oct 2026). The
-- applied 2026-10-08_courier_registry.sql (P2) made these two rules
-- deliberately NOT checks, so a hand fix of status for the 30-day pause
-- (decision 7) could never be blocked, and catalog check 14 counted breaks
-- instead. P2 is not edited. Neither check touches a pause: a hand write of
-- status = 'paused' is unconstrained by both. What they refuse is a hand
-- write of 'full' with neither stamp, or of 'buffer' with no clock.
--
-- EVERY WRITER, read 11 Oct 2026, and each passes:
--   courier_register_legacy   inserts status 'registered'.
--   courier_register_pioneer  inserts status 'full' with vouched_at now().
--   courier_apply_kyc_status  sets 'buffer' and buffer_since, or 'full' and
--                             kyc_approved_at, in the same UPDATE.
--   courier_bind_piverify_session  sets buffer_since null and status
--                             'registered', EXCEPT under an operator pause,
--                             where it keeps the status. A row with
--                             paused_reason 'operator' and status 'buffer'
--                             would now make bind fail with 23514 rather
--                             than write a buffer row with no clock. The
--                             hand-run pre-flight counts such rows.
--   No app route or lib writes courier_registry.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, Testnet
-- first and Mainnet only on a go-ahead, once P2 and P13 are applied there.
-- Confirm the project breadcrumb before pasting. Run section 0 on its own
-- first. Then run the whole file: section 1 stops it, before anything is
-- written, if courier_registry or its vouched_at column is missing, or if any
-- row breaks either rule. The last statement is a read-only verification
-- returning one cell. all_present must read true.
--
-- ORDER. Needs P2 (the table) and P13 (vouched_at). No code change goes with
-- it.
--
-- SAFE TO RE-RUN. Each check is added only if absent by name. A second run
-- changes nothing.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Pre-flight, read only. Run on its own and record the result BEFORE the
--    file. Counts only, no row. breaks_full and breaks_buffer must be 0, or
--    stop. buffer_under_operator_pause is information: a non-zero count is a
--    row bind would now refuse to rebind; read it before applying.
--
--     select
--       count(*) filter (where status = 'full' and kyc_approved_at is null
--                          and vouched_at is null)                as breaks_full,
--       count(*) filter (where status = 'buffer' and buffer_since is null)
--                                                                 as breaks_buffer,
--       count(*) filter (where status = 'buffer'
--                          and paused_reason = 'operator')        as buffer_under_operator_pause,
--       count(*)                                                  as total_rows
--     from public.courier_registry;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Guard. Raises, and so stops the file before either check is added,
--    unless courier_registry and vouched_at exist and no row breaks either
--    rule. Counts only in the message.
-- ---------------------------------------------------------------------------
do $$
declare
  v_full   bigint;
  v_buffer bigint;
begin
  if to_regclass('public.courier_registry') is null then
    raise exception 'P17 guard: public.courier_registry does not exist. Apply P2 first. Stop.';
  end if;

  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.courier_registry'::regclass
                    and attname = 'vouched_at' and not attisdropped) then
    raise exception 'P17 guard: courier_registry.vouched_at is missing. Apply P13 first. Stop.';
  end if;

  -- Dynamic, so the file parses on a project without vouched_at and the
  -- message above is what the founder sees, never a bare 42703.
  execute 'select count(*) from public.courier_registry
            where status = ''full'' and kyc_approved_at is null and vouched_at is null'
     into v_full;
  select count(*) into v_buffer
    from public.courier_registry
   where status = 'buffer' and buffer_since is null;

  if v_full > 0 or v_buffer > 0 then
    raise exception 'P17 guard: % full row(s) with neither kyc_approved_at nor vouched_at, % buffer row(s) with no buffer_since. Stop.',
      v_full, v_buffer;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The two named checks, each added only if absent
--
-- Guarded on pg_constraint by name. Adding each validates every existing
-- row, which section 1 has just confirmed.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.courier_registry'::regclass
       and conname = 'courier_registry_full_needs_approval_check'
  ) then
    alter table public.courier_registry
      add constraint courier_registry_full_needs_approval_check
      check (status <> 'full' or kyc_approved_at is not null or vouched_at is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.courier_registry'::regclass
       and conname = 'courier_registry_buffer_needs_since_check'
  ) then
    alter table public.courier_registry
      add constraint courier_registry_buffer_needs_since_check
      check (status <> 'buffer' or buffer_since is not null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- ---------------------------------------------------------------------------
with
chk as (
  select c.conname, c.convalidated, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
   where c.conrelid = 'public.courier_registry'::regclass
     and c.contype = 'c'
     and c.conname in ('courier_registry_full_needs_approval_check',
                       'courier_registry_buffer_needs_since_check')
),
rows as (
  select 'constraint courier_registry_full_needs_approval_check, validated' as object,
         coalesce((select convalidated from chk
                    where conname = 'courier_registry_full_needs_approval_check'), false) as present
  union all
  select 'courier_registry_full_needs_approval_check: not full, or kyc_approved_at or vouched_at set',
         coalesce((select def ~ 'status <> ''full''::text'
                          and def ~ 'kyc_approved_at IS NOT NULL'
                          and def ~ 'vouched_at IS NOT NULL'
                     from chk where conname = 'courier_registry_full_needs_approval_check'), false)
  union all
  select 'constraint courier_registry_buffer_needs_since_check, validated',
         coalesce((select convalidated from chk
                    where conname = 'courier_registry_buffer_needs_since_check'), false)
  union all
  select 'courier_registry_buffer_needs_since_check: not buffer, or buffer_since set',
         coalesce((select def ~ 'status <> ''buffer''::text'
                          and def ~ 'buffer_since IS NOT NULL'
                     from chk where conname = 'courier_registry_buffer_needs_since_check'), false)
  union all
  select 'courier_registry carries fifteen constraints (thirteen after P13, plus these two)',
         (select count(*) from pg_constraint
           where conrelid = 'public.courier_registry'::regclass) = 15
  union all
  select 'no full row lacks both kyc_approved_at and vouched_at',
         not exists (select 1 from public.courier_registry
                      where status = 'full' and kyc_approved_at is null and vouched_at is null)
  union all
  select 'no buffer row lacks buffer_since',
         not exists (select 1 from public.courier_registry
                      where status = 'buffer' and buffer_since is null)
)
select jsonb_pretty(jsonb_build_object(
  'courier_registry_timing_checks_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'check_definitions', (select jsonb_object_agg(conname, def) from chk),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present)) from rows)
  )
)) as courier_registry_timing_checks_verification;
