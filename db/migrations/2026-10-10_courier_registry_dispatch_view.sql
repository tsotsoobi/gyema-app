-- ===========================================================================
-- 2026-10-10  Dispatch Reader: courier_registry_dispatch, a masked view of
--             the courier registry
-- ===========================================================================
--
-- Phase 1 item 6, part (a), P15, as approved 9 Oct 2026
-- (docs/anchoring-phase1-notes.md, 6.6, and 6.10 decision 6: P15 ships in
-- item 6, since the 30-day rule ships there).
--
-- WHY THIS EXISTS
--
-- Decision 7: the 30-day buffer pause is computed on read for enforcement,
-- and the dispatch reader lists overdue buffer couriers so the founder sets
-- the stored status by hand. The reader runs as gyema_reader, which holds
-- nothing on courier_registry (2026-10-08_courier_registry.sql section 3)
-- and keeps holding nothing. This view is what it reads instead. The reader
-- lists, from it:
--
--   - buffer couriers at or past 30 days from buffer_since (decision 7)
--   - couriers whose PiVerify session is unsettled and whose
--     piverify_status_at is over 24 hours old (item 5, 5.4), so the founder
--     can nudge them
--
-- WHAT IT CARRIES, AND WHAT IT DOES NOT
--
--   courier_ref         the first 8 characters of the id, the same courier
--                       reference the courier page shows the courier and the
--                       founder notes at onboarding (5.1). A lookup aid,
--                       never a credential: no route accepts it.
--   class, status, buffer_since, piverify_status, piverify_status_at,
--   paused_reason, shredded_at
--   piverify_allowed_action
--                       RESUBMIT, APPEAL or null (P9's check holds it to
--                       those, and to a rejected session). A rejected
--                       session is unsettled only while it is not null,
--                       as isUnsettled in app/courier/courier-panel.tsx
--                       reads it. Appended last, 11 Oct 2026, before any
--                       network applied this file, so the first eight keep
--                       their positions.
--
-- No pi_username, no commitment_salt, no piverify_session_id, no
-- auth_user_id, no full id. Nothing here names a person.
--
-- WHO HOLDS IT: gyema_reader SELECT, and nobody else, service_role included.
--
-- This differs, on purpose, from the two other dispatch views, where
-- service_role keeps Supabase's default full set (2026-09-15 pre-flight (e)).
-- Those views carry ORDER BY and LIMIT, which makes them not automatically
-- updatable. This one is a plain projection of one table, which Postgres
-- makes automatically updatable for its plain columns, and a view with
-- security_invoker off acts on the base table with its OWNER's rights. A
-- role holding DELETE on this view could therefore delete courier_registry
-- rows, which the registry deliberately gives no role (P2 section 3: no
-- DELETE path), and could UPDATE status through it. So every privilege is
-- revoked from service_role as well as from public, anon and authenticated,
-- and gyema_reader receives SELECT alone. gyema_reader's sessions are read
-- only besides (2026-09-07 section 2).
--
-- security_invoker = false, stated explicitly, as on the other two views:
-- gyema_reader reads the view with the owner's rights because it holds no
-- grant on the base table. On a server older than Postgres 15 the option does
-- not exist and section 1 stops the file.
--
-- PREREQUISITES. P2 (2026-10-08_courier_registry.sql) for the table, P9
-- (2026-10-08_piverify_resubmission.sql) for piverify_allowed_action, and the
-- gyema_reader role (2026-09-07_dispatch_reader_masked_view.sql section 1).
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run the whole file; its last statement
-- is a read-only verification returning one cell. all_present must read true.
--
-- ORDER AGAINST THE SCRIPT. Apply this file BEFORE running a
-- scripts/dispatch-reader.mjs that reads courier_registry_dispatch. Nothing
-- in the app reads the view.
--
-- SAFE TO RE-RUN. create or replace with the identical definition, then
-- revokes and a grant that are no-ops when already in place. A second run
-- changes nothing.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Guard. Raises, and so stops the file before anything is created, unless
--    the server is Postgres 15 or later and gyema_reader exists.
-- ---------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'P15 guard: server is older than Postgres 15, security_invoker does not exist. Stop.';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gyema_reader') then
    raise exception 'P15 guard: role gyema_reader does not exist on this project. Stop.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The view
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
    piverify_allowed_action
  from public.courier_registry;

comment on view public.courier_registry_dispatch is
  'Dispatch reader view of courier_registry: the courier reference (first 8 characters of the id), the ladder columns and piverify_allowed_action only. No pi_username, salt, session id, auth link or full id. gyema_reader SELECT only; nobody else, service_role included, because the view is automatically updatable. See db/migrations/2026-10-10_courier_registry_dispatch_view.sql.';


-- ---------------------------------------------------------------------------
-- 3. Privileges, in the same file and immediately after the create
--
-- A view created after the grant baseline is born with whatever the default
-- privileges for role postgres give: on these projects, service_role's full
-- set (2026-09-07 section 5a records the earlier finding for anon and
-- authenticated). Revoked here from everyone, then SELECT to gyema_reader.
-- ---------------------------------------------------------------------------
revoke all on public.courier_registry_dispatch from public, anon, authenticated, service_role;
grant select on public.courier_registry_dispatch to gyema_reader;


-- ---------------------------------------------------------------------------
-- 4. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- Grants are read from pg_class.relacl, where no role membership filtering
-- applies, the same source catalog check 3b trusts.
-- ---------------------------------------------------------------------------
with
v as (
  select c.oid, c.reloptions, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'courier_registry_dispatch' and c.relkind = 'v'
),
cols as (
  select a.attnum, a.attname::text as name
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
reg as (
  select c.oid, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'courier_registry' and c.relkind = 'r'
),
expected(pos, name) as (
  values (1, 'courier_ref'), (2, 'class'), (3, 'status'), (4, 'buffer_since'),
         (5, 'piverify_status'), (6, 'piverify_status_at'), (7, 'paused_reason'), (8, 'shredded_at'),
         (9, 'piverify_allowed_action')
),
rows as (
  select 'view public.courier_registry_dispatch' as object, exists (select 1 from v) as present, null::text as detail
  union all
  select 'exactly 9 columns, by name, in order',
         (select count(*) from cols) = 9
         and not exists (select 1 from expected e left join cols c on c.attnum = e.pos
                          where c.name is distinct from e.name),
         (select string_agg(attnum || ':' || name, ', ' order by attnum) from cols)
  union all
  select 'no pi_username, commitment_salt, piverify_session_id, auth_user_id or id',
         exists (select 1 from v)
         and not exists (select 1 from cols where name in ('pi_username', 'commitment_salt',
                                                           'piverify_session_id', 'auth_user_id', 'id')),
         null
  union all
  select 'courier_ref is the first 8 characters of the id',
         coalesce(pg_get_viewdef((select oid from v), true) ~ '"?left"?\(\(?id\)?::text, 8\) AS courier_ref', false),
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
  select 'nobody but gyema_reader holds anything, service_role included',
         exists (select 1 from v)
         and not exists (select 1 from acl where grantee <> 'gyema_reader'),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
            from acl where grantee <> 'gyema_reader')
  union all
  select 'gyema_reader still holds nothing on courier_registry itself',
         exists (select 1 from reg)
         and not exists (
           select 1 from reg
           cross join lateral aclexplode(coalesce(reg.relacl, acldefault('r', reg.relowner))) a
           where a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'gyema_reader'),
         null
)
select jsonb_pretty(jsonb_build_object(
  'courier_registry_dispatch_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as courier_registry_dispatch_verification;
