-- ===========================================================================
-- 2026-10-09  Dispatch Reader: assigned_courier_id and declared_value_cedis
--             on guest_jobs_dispatch
-- ===========================================================================
--
-- EXTENDS db/migrations/2026-09-15_dispatch_view_remit_cedis.sql. Nothing
-- else changes. The role, its session bounds, the masking function,
-- listings_dispatch, the revokes and the grant all stand as they are.
--
-- Phase 1 item 6, part (a), P14, as approved 9 Oct 2026 and amended 10 Oct
-- 2026 by item 7 (docs/anchoring-phase1-notes.md, 6.1, 6.6 and 7.7 decision 3).
--
-- WHY THIS EXISTS
--
-- 1. assigned_courier_id (column 24). A legacy courier's claim leaves
--    assigned_courier null and writes assigned_courier_id instead (P13). The
--    reader's remit sections are keyed on assigned_courier is not null, so
--    without this column every legacy job would be invisible to remit
--    tracking, not just to display. The matching reader change treats a job
--    as assigned when either column is set, and shows a legacy courier as the
--    courier reference, the first 8 characters of the id.
--
-- 2. declared_value_cedis (column 25). Decision 6: shown to the sender and
--    the operator, never to any courier. The dispatch reader is the
--    operator's surface, and gyema_reader is the operator's role, not a
--    courier's. This is the only place outside the send form and the create
--    route that carries it.
--
-- WHAT IT EXPOSES, AND WHAT IT DOES NOT
--
-- gyema_reader holds SELECT on the whole view, not per column, so both
-- columns are readable by the role the moment the replace lands. That is the
-- intent for both. assigned_courier_id is an internal id: the registry it
-- points at is still unreachable to gyema_reader (P15 gives a masked view of
-- it, carrying only the first 8 characters of the id).
--
-- WHY CREATE OR REPLACE, AND THE TWO CONSTRAINTS IT CARRIES
--
-- As in 2026-09-15: CREATE OR REPLACE VIEW keeps ownership and grants, so the
-- 2026-09-07 section 5a revokes and the gyema_reader grant stand without
-- being repeated. The new query must produce the existing 23 columns with the
-- same names, order and types, and may only append. And WITH ( ... ) is
-- replaced, not merged, so security_invoker = false is restated.
--
-- PREREQUISITES. P12b (2026-10-10_guest_jobs_declared_value.sql) and P13
-- (2026-10-09_guest_jobs_courier_assignment.sql): the view selects both
-- columns. Section 1 stops the file, before the replace, if either is
-- missing or if the live view is not the 2026-09-15 shape.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run the section 0 pre-flight first, then
-- the whole file. Its last statement is a read-only verification returning
-- one cell. all_present must read true.
--
-- ORDER AGAINST THE SCRIPT. Apply this file BEFORE running a
-- scripts/dispatch-reader.mjs that lists either new column as required. The
-- reader as it stands ignores extra columns, so this file is safe to apply
-- first. The new reader refuses to run, with a preflight failure naming the
-- column, against a view without them.
--
-- SAFE TO RE-RUN. Section 1 accepts the 25-column shape this file leaves, and
-- a second run replaces the view with the identical definition.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Pre-flight, read only. Run each and record the result BEFORE the file.
--
-- (a) The LIVE definition. Expect exactly the 23 columns of 2026-09-15
--     section 1, in that order, ending with remit_cedis, the two phones
--     through mask_phone_head_only, order by created_at desc, limit 2000. If
--     the live view differs in anything but whitespace, stop: do not edit
--     section 2 to match, bring the difference back as a decision. Section 1
--     checks the column names mechanically; this read is for everything else.
--
--     select pg_get_viewdef('public.guest_jobs_dispatch'::regclass, true);
--
-- (b) Owner, options and grants. Record all three; the verification expects
--     them unchanged. Expect reloptions {security_invoker=false}, and grants
--     gyema_reader SELECT only, postgres and service_role the full owner set
--     (2026-09-15 pre-flight (e)). Anything for anon, authenticated or PUBLIC
--     is a finding: stop.
--
--     select pg_get_userbyid(c.relowner) as owner, c.reloptions
--       from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relname = 'guest_jobs_dispatch';
--
--     select case when a.grantee = 0 then 'PUBLIC'
--                 else pg_get_userbyid(a.grantee) end as grantee,
--            a.privilege_type
--       from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--       cross join lateral aclexplode(c.relacl) a
--      where n.nspname = 'public' and c.relname = 'guest_jobs_dispatch'
--      order by grantee, a.privilege_type;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Guard. Raises, and so stops the file before the replace, unless:
--
--   - the server is Postgres 15 or later (security_invoker exists);
--   - guest_jobs carries both new columns (P12b and P13 applied);
--   - the live view's columns are exactly the 23 of 2026-09-15, or exactly
--     the 25 this file leaves (a re-run).
-- ---------------------------------------------------------------------------
do $$
declare
  v_live      text[];
  v_before    text[] := array[
    'tracking_id', 'status', 'created_at', 'updated_at', 'phone_verified',
    'verified_at', 'pickup_area', 'dropoff_area', 'package_size', 'when_pref',
    'scheduled_date', 'quote_cedis', 'payment_type', 'sender_phone_masked',
    'recipient_phone_masked', 'assigned_courier', 'pickup_confirmed_at',
    'pickup_confirmed_by', 'delivery_confirmed_at', 'delivery_confirmed_by',
    'delivery_code_attempts', 'remit_paid_at', 'remit_cedis'];
  v_after     text[] := v_before || array['assigned_courier_id', 'declared_value_cedis'];
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'P14 guard: server is older than Postgres 15, security_invoker does not exist. Stop.';
  end if;

  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.guest_jobs'::regclass
                    and attname = 'assigned_courier_id' and not attisdropped) then
    raise exception 'P14 guard: guest_jobs.assigned_courier_id is missing. Apply P13 first. Stop.';
  end if;

  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.guest_jobs'::regclass
                    and attname = 'declared_value_cedis' and not attisdropped) then
    raise exception 'P14 guard: guest_jobs.declared_value_cedis is missing. Apply P12b first. Stop.';
  end if;

  select array_agg(a.attname::text order by a.attnum) into v_live
    from pg_attribute a
   where a.attrelid = 'public.guest_jobs_dispatch'::regclass
     and a.attnum > 0 and not a.attisdropped;

  if v_live is distinct from v_before and v_live is distinct from v_after then
    raise exception 'P14 guard: the live guest_jobs_dispatch columns are not the 2026-09-15 shape. Live: %. Stop and bring it back.',
      array_to_string(v_live, ', ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The replace
--
-- Columns 1 to 23 are 2026-09-15 section 1 verbatim, in order. Columns 24 and
-- 25 are the only additions. The ORDER BY and LIMIT are unchanged, so the row
-- cap still means the most recent 2000 rows.
-- ---------------------------------------------------------------------------
create or replace view public.guest_jobs_dispatch
  with (security_invoker = false)
as
  select
    tracking_id,
    status,
    created_at,
    updated_at,
    phone_verified,
    verified_at,
    pickup_area,
    dropoff_area,
    package_size,
    when_pref,
    scheduled_date,
    quote_cedis,
    payment_type,
    public.mask_phone_head_only(sender_phone)    as sender_phone_masked,
    public.mask_phone_head_only(recipient_phone) as recipient_phone_masked,
    assigned_courier,
    pickup_confirmed_at,
    pickup_confirmed_by,
    delivery_confirmed_at,
    delivery_confirmed_by,
    delivery_code_attempts,
    remit_paid_at,
    remit_cedis,
    assigned_courier_id,
    declared_value_cedis
  from public.guest_jobs
  order by created_at desc
  limit 2000;

comment on view public.guest_jobs_dispatch is
  'Dispatch reader view of guest_jobs. Phones are head masked and the raw columns are unreachable through it. Of the remit settlement columns it carries remit_paid_at and remit_cedis only. Carries assigned_courier_id (legacy and Pioneer claims) and declared_value_cedis (operator only, never a courier). Capped at the most recent 2000 rows.';


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- Compare the grants row against pre-flight 0(b): the replace keeps them.
-- ---------------------------------------------------------------------------
with
v as (
  select c.oid, c.reloptions, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'guest_jobs_dispatch' and c.relkind = 'v'
),
cols as (
  select a.attnum, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as data_type
    from v
    join pg_attribute a on a.attrelid = v.oid
   where a.attnum > 0 and not a.attisdropped
),
acl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from v
    cross join lateral aclexplode(coalesce(v.relacl, acldefault('r', v.relowner))) a
   where a.grantee <> v.relowner
),
expected(pos, name) as (
  values (1, 'tracking_id'), (2, 'status'), (3, 'created_at'), (4, 'updated_at'),
         (5, 'phone_verified'), (6, 'verified_at'), (7, 'pickup_area'), (8, 'dropoff_area'),
         (9, 'package_size'), (10, 'when_pref'), (11, 'scheduled_date'), (12, 'quote_cedis'),
         (13, 'payment_type'), (14, 'sender_phone_masked'), (15, 'recipient_phone_masked'),
         (16, 'assigned_courier'), (17, 'pickup_confirmed_at'), (18, 'pickup_confirmed_by'),
         (19, 'delivery_confirmed_at'), (20, 'delivery_confirmed_by'),
         (21, 'delivery_code_attempts'), (22, 'remit_paid_at'), (23, 'remit_cedis'),
         (24, 'assigned_courier_id'), (25, 'declared_value_cedis')
),
rows as (
  select 'view public.guest_jobs_dispatch' as object, exists (select 1 from v) as present, null::text as detail
  union all
  select 'exactly 25 columns',
         (select count(*) from cols) = 25,
         (select count(*)::text from cols)
  union all
  select 'columns 1 to 25 by name, in order',
         not exists (select 1 from expected e left join cols c on c.attnum = e.pos
                      where c.name is distinct from e.name),
         (select string_agg(e.pos || ':' || coalesce(c.name, '(missing)'), ', ' order by e.pos)
            from expected e left join cols c on c.attnum = e.pos
           where c.name is distinct from e.name)
  union all
  select 'column 24 assigned_courier_id is uuid',
         coalesce((select data_type = 'uuid' from cols where attnum = 24 and name = 'assigned_courier_id'), false),
         null
  union all
  select 'column 25 declared_value_cedis is integer',
         coalesce((select data_type = 'integer' from cols where attnum = 25 and name = 'declared_value_cedis'), false),
         null
  union all
  select 'no raw phone and no other remit column',
         not exists (select 1 from cols where name in ('sender_phone', 'recipient_phone', 'remit_pi',
                                                       'remit_rate', 'remit_method', 'remit_ref')),
         null
  union all
  select 'security_invoker = false is set',
         coalesce((select 'security_invoker=false' = any(reloptions) from v), false),
         (select array_to_string(reloptions, ',') from v)
  union all
  select 'gyema_reader holds exactly SELECT',
         coalesce((select array_agg(privilege_type order by privilege_type) from acl where grantee = 'gyema_reader')
                  = array['SELECT']::text[], false),
         (select string_agg(privilege_type, ', ' order by privilege_type) from acl where grantee = 'gyema_reader')
  union all
  select 'anon, authenticated and PUBLIC hold nothing',
         exists (select 1 from v)
         and not exists (select 1 from acl where grantee in ('anon', 'authenticated', 'PUBLIC')),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
            from acl where grantee in ('anon', 'authenticated', 'PUBLIC'))
)
select jsonb_pretty(jsonb_build_object(
  'dispatch_view_courier_id_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'grants', (select jsonb_agg(jsonb_build_object('grantee', grantee, 'privilege', privilege_type)
                                order by grantee, privilege_type) from acl),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as dispatch_view_courier_id_verification;

-- ROLLBACK, if this file needs undoing. CREATE OR REPLACE cannot remove a
-- column, so the undo is a drop and a recreate: re-run 2026-09-07 sections 5
-- (guest_jobs_dispatch only), 5a, 6 and the guest_jobs_dispatch grant in 7,
-- then 2026-09-15 section 1, then that file's section 2 checks. A reader that
-- lists the new columns as required then fails its preflight, loudly, until
-- it is reverted too.
