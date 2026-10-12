-- ===========================================================================
-- Gyema catalog checks: one statement, one jsonb document, one Run per network
-- ===========================================================================
--
-- READ ONLY. This is a single SELECT against catalog views. It creates,
-- alters, drops, grants and revokes nothing, and it reads no row of user data:
-- no listing, no guest job, no phone number, no delivery code, no name. The
-- only user-data-adjacent number in the output is the planner's row estimate
-- per table, which needs no scan.
--
-- HOW TO RUN IT
--
-- Select the whole file and Run, once per project. The Supabase SQL editor
-- returns only the last statement's result, which is why everything is one
-- statement returning one column of pretty-printed jsonb. Copy that one cell.
--
-- Confirm the project breadcrumb in the dashboard before running, per
-- CLAUDE.md. Then paste the result back labelled TESTNET or MAINNET. The
-- document carries current_database() and a timestamp so a mislabelled paste
-- is still identifiable.
--
-- Nothing in the output is a secret. Policy bodies and function ACLs are code
-- and privilege metadata, not data.
--
-- WHAT IT IS FOR
--
-- docs/security-inventory.md could not answer the database half of Phase 0.
-- The migrations in db/migrations say what was intended; the catalog says what
-- is deployed, and the two projects are known to disagree already. CLAUDE.md
-- invariant 8 makes the same point: verify DDL from catalog state, never from a
-- Success banner.
--
-- The document has an "expected" key at the top level holding the expectation
-- for every check, so a result that differs is visible without going back to
-- this file.
--
-- THE UNREFERENCED TABLE
--
-- check 1 on the first network showed a2u_payments, couriers and
-- legacy_couriers. Nothing in this repository references any of them: no
-- route, no lib, no migration in db/migrations. couriers and legacy_couriers
-- are dropped by db/migrations/2026-10-08_drop_orphan_courier_tables.sql,
-- replaced by courier_registry, and check 9 now confirms they are gone.
-- a2u_payments remains, named explicitly in every per-table check, and check
-- 13 exists for it, because an unreferenced table is the case where nobody
-- notices RLS is off. It matches the unmerged remote branch feat/a2u-payout,
-- so it may be a table that was created for work that never shipped.
--
-- ===========================================================================

with
-- CHECK 1. Row level security, per table, every table in public.
check_01_rls as (
  select coalesce(jsonb_agg(x order by x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'table_name', c.relname,
      'referenced_by_repo', (c.relname in ('listings', 'guest_jobs', 'pioneers', 'auth_events',
                                           'courier_registry', 'piverify_events',
                                           'courier_signin_codes', 'courier_sessions')),
      'rls_enabled', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'policy_count', (select count(*) from pg_policies p
                        where p.schemaname = 'public' and p.tablename = c.relname)
    ) as x
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ) s
),

-- CHECK 2. Every policy body. listings SELECT and DELETE sort first.
check_02_policies as (
  select coalesce(jsonb_agg(x order by ord, tbl, cmd_, pol), '[]'::jsonb) as v
  from (
    select
      case when tablename = 'listings' and cmd = 'SELECT' then 0
           when tablename = 'listings' and cmd = 'DELETE' then 1
           when tablename = 'listings' then 2
           when tablename = 'a2u_payments' then 3
           else 4 end as ord,
      tablename as tbl, cmd as cmd_, policyname as pol,
      jsonb_build_object(
        'table_name', tablename,
        'policy_name', policyname,
        'cmd', cmd,
        'permissive', permissive,
        'roles', to_jsonb(roles),
        'using_expression', qual,
        'with_check_expression', with_check
      ) as x
    from pg_policies
    where schemaname = 'public'
  ) s
),

-- CHECK 3. Table wide grants to the roles that matter.
check_03_table_grants as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privileges', to_jsonb(array_agg(distinct privilege_type order by privilege_type))
    ) as x
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name
  ) s
),

-- CHECK 4. Column level grants, collapsed to one row per grantee, table and
-- privilege with the column list. This is where S-1 lives.
check_04_column_grants as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name', x->>'privilege'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privilege', privilege_type,
      'column_count', count(*),
      'columns', to_jsonb(array_agg(column_name order by column_name))
    ) as x
    from information_schema.column_privileges
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated', 'gyema_reader')
    group by grantee, table_name, privilege_type
  ) s
),

-- CHECK 3b and 4b. The same two grant questions read from pg_class.relacl and
-- pg_attribute.attacl instead of information_schema.
--
-- information_schema.role_table_grants and column_privileges only show
-- privileges granted to roles the current user belongs to. In Supabase the
-- SQL editor runs as postgres, which is a member of anon, authenticated and
-- service_role, so checks 3 and 4 should be complete. Should is not a word to
-- rest a privilege audit on: these two read the ACLs straight from the catalog,
-- where no role membership filtering applies. If 3 and 3b disagree, believe 3b.
check_03b_table_grants_catalog as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privileges', to_jsonb(array_agg(distinct privilege_type order by privilege_type))
    ) as x
    from (
      select
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        c.relname as table_name,
        a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relkind in ('r', 'v')
    ) g
    where grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name
  ) s
),

check_04b_column_grants_catalog as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name', x->>'privilege'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privilege', privilege_type,
      'column_count', count(*),
      'columns', to_jsonb(array_agg(column_name order by column_name))
    ) as x
    from (
      select
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        c.relname as table_name,
        att.attname as column_name,
        a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
      cross join lateral aclexplode(att.attacl) a
      where n.nspname = 'public' and c.relkind in ('r', 'v') and att.attacl is not null
    ) g
    where grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name, privilege_type
  ) s
),

-- CHECK 5. Does anything pin posted_by_id to the session on insert. S-15.
check_05_listings_insert_policy as (
  select coalesce(jsonb_agg(x), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'policy_name', policyname,
      'roles', to_jsonb(roles),
      'with_check_expression', with_check,
      'mentions_posted_by_id', coalesce(with_check ilike '%posted_by_id%', false),
      'mentions_auth_uid', coalesce(with_check ilike '%auth.uid%' or with_check ilike '%auth.jwt%', false)
    ) as x
    from pg_policies
    where schemaname = 'public' and tablename = 'listings' and cmd = 'INSERT'
  ) s
),

-- CHECK 6. Every function in public, with security definer, volatility,
-- search_path and owner.
check_06_functions as (
  select coalesce(jsonb_agg(x order by secdef desc, nm), '[]'::jsonb) as v
  from (
    select p.prosecdef as secdef, p.proname as nm,
      jsonb_build_object(
        'function_name', p.proname,
        'arguments', pg_get_function_identity_arguments(p.oid),
        'security_definer', p.prosecdef,
        'volatility', case p.provolatile when 'i' then 'immutable'
                                          when 's' then 'stable'
                                          else 'volatile' end,
        'settings', to_jsonb(p.proconfig),
        'search_path_pinned', (p.proconfig is not null
                               and array_to_string(p.proconfig, ',') like '%search_path%'),
        'owner', pg_get_userbyid(p.proowner)
      ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ) s
),

-- CHECK 7. EXECUTE grants on the functions the migrations create.
check_07_function_acls as (
  select coalesce(jsonb_agg(x order by x->>'function_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'function_name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef,
      'acl', case when p.proacl is null
                  then to_jsonb('(null: EXECUTE to PUBLIC)'::text)
                  else to_jsonb(p.proacl::text[]) end,
      'anon_or_authenticated_can_execute',
        coalesce(array_to_string(p.proacl, ',') like '%anon=X%'
              or array_to_string(p.proacl, ',') like '%authenticated=X%'
              or p.proacl is null, false)
    ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'courier_apply_kyc_status',
        'courier_bind_piverify_session',
        'courier_end_session',
        'courier_find_pioneer',
        'courier_issue_signin_code',
        'courier_record_operator_check',
        'courier_redeem_signin_code',
        'courier_register_legacy',
        'courier_register_pioneer',
        'courier_revoke_sessions',
        'courier_session_resolve',
        'courier_start_operator_check_sunset',
        'guest_bump_delivery_code_attempts',
        'guest_bump_last4_attempts',
        'guest_stamp_delivery',
        'listing_confirm_completion',
        'listing_counterpart_contact',
        'mask_phone_head_only'
      )
  ) s
),

-- CHECK 8. Is anything at the database layer bounding the last-4 guard. S-2.
check_08_guard_columns as (
  select coalesce(jsonb_agg(x order by x->>'column_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'column_default', column_default,
      'is_nullable', is_nullable
    ) as x
    from information_schema.columns
    where table_schema = 'public' and table_name = 'guest_jobs'
      and (column_name like '%attempt%'
        or column_name like '%lock%'
        or column_name like '%guard%'
        or column_name in ('phone_verified', 'verified_at', 'delivery_code_hash'))
  ) s
),

-- CHECK 9. Did each migration file's objects land.
check_09_migration_objects as (
  select coalesce(jsonb_agg(x order by x->>'migration', x->>'object'), '[]'::jsonb) as v
  from (
    select jsonb_build_object('migration', m, 'object', o, 'present', present) as x
    from (
      values
        ('2026-08-13', 'column guest_jobs.delivery_code_hash',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='delivery_code_hash')),
        ('2026-08-13', 'column guest_jobs.delivery_code_attempts',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='delivery_code_attempts')),
        ('2026-08-13', 'function guest_bump_delivery_code_attempts',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_bump_delivery_code_attempts')),
        ('2026-08-13', 'function guest_stamp_delivery',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_stamp_delivery')),
        ('2026-08-14', 'function listing_confirm_completion',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='listing_confirm_completion')),
        ('2026-08-14', 'listings UPDATE policy for the two parties (renamed listings_update_parties by the identity migration)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='listings'
                     and (policyname = 'listings_update_parties'
                       or policyname ilike '%matched parties%'))),
        ('2026-08-18', 'role gyema_reader',
          exists (select 1 from pg_roles where rolname='gyema_reader')),
        ('2026-08-18', 'policy gyema_reader_select on guest_jobs (superseded)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='guest_jobs'
                     and policyname='gyema_reader_select')),
        ('2026-08-18', 'policy gyema_reader_select on listings (superseded)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='listings'
                     and policyname='gyema_reader_select')),
        ('2026-09-07', 'function mask_phone_head_only',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='mask_phone_head_only')),
        ('2026-09-07', 'view guest_jobs_dispatch',
          exists (select 1 from information_schema.views
                   where table_schema='public' and table_name='guest_jobs_dispatch')),
        ('2026-09-07', 'view listings_dispatch',
          exists (select 1 from information_schema.views
                   where table_schema='public' and table_name='listings_dispatch')),
        ('2026-09-07', 'gyema_reader holds nothing on base table guest_jobs',
          not exists (select 1 from information_schema.role_table_grants
                       where grantee='gyema_reader' and table_name='guest_jobs')),
        ('2026-09-07', 'gyema_reader holds nothing on base table listings',
          not exists (select 1 from information_schema.role_table_grants
                       where grantee='gyema_reader' and table_name='listings')),
        ('2026-09-07', 'neither dispatch view is readable by anon or authenticated',
          not exists (select 1 from information_schema.role_table_grants
                       where table_schema='public'
                         and table_name in ('guest_jobs_dispatch','listings_dispatch')
                         and grantee in ('anon','authenticated','PUBLIC'))),
        ('2026-09-07 identity', 'the four listings policies reading app_metadata',
          (select count(*) = 4 from pg_policies
            where schemaname='public' and tablename='listings'
              and policyname in ('listings_select_public','listings_insert_own',
                                 'listings_update_parties','listings_delete_poster'))),
        ('2026-09-07 identity', 'no policy in public references user_metadata',
          not exists (select 1 from pg_policies
                       where schemaname='public'
                         and (coalesce(qual,'') like '%user_metadata%'
                           or coalesce(with_check,'') like '%user_metadata%'))),
        ('2026-09-07 last4', 'column guest_jobs.last4_attempts',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='last4_attempts')),
        ('2026-09-07 last4', 'function guest_bump_last4_attempts',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_bump_last4_attempts')),
        ('2026-09-07 baseline', 'default privileges for role postgres deny anon and authenticated on new tables',
          not exists (
            select 1 from pg_default_acl d
            join pg_namespace n on n.oid = d.defaclnamespace
            where n.nspname = 'public' and d.defaclobjtype = 'r'
              and d.defaclrole = 'postgres'::regrole
              and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)=')),
        ('2026-10-08 function defaults', 'default privileges for role postgres grant anon and authenticated nothing on new functions',
          not exists (
            select 1 from pg_default_acl d
            join pg_namespace n on n.oid = d.defaclnamespace
            where n.nspname = 'public' and d.defaclobjtype = 'f'
              and d.defaclrole = 'postgres'::regrole
              and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)=')),
        ('2026-10-08 orphan drop', 'table couriers is gone',
          to_regclass('public.couriers') is null),
        ('2026-10-08 orphan drop', 'table legacy_couriers is gone',
          to_regclass('public.legacy_couriers') is null),
        ('2026-10-08 courier registry', 'table courier_registry',
          to_regclass('public.courier_registry') is not null),
        ('2026-10-08 courier registry', 'row level security enabled on courier_registry',
          coalesce((select c.relrowsecurity from pg_class c
                     where c.oid = to_regclass('public.courier_registry')), false)),
        ('2026-10-08 courier registry', 'unique index courier_registry_pi_username_lower_key',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='courier_registry_pi_username_lower_key')),
        ('2026-10-08 courier registry', 'unique index courier_registry_auth_user_key',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='courier_registry_auth_user_key')),
        ('2026-10-08 courier registry', 'unique index courier_registry_piverify_session_key',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='courier_registry_piverify_session_key')),
        ('2026-10-08 courier registry', 'anon, authenticated, PUBLIC and gyema_reader hold nothing on courier_registry',
          to_regclass('public.courier_registry') is not null
          and not exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = to_regclass('public.courier_registry')
              and (a.grantee = 0
                   or pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'gyema_reader')))),
        ('2026-10-08 courier registry', 'service_role holds exactly INSERT, SELECT, UPDATE on courier_registry',
          coalesce((
            select array_agg(a.privilege_type::text order by a.privilege_type)
              from pg_class c
              cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             where c.oid = to_regclass('public.courier_registry')
               and a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
          ) = array['INSERT', 'SELECT', 'UPDATE']::text[], false)),
        ('2026-10-08 piverify webhook', 'table piverify_events',
          to_regclass('public.piverify_events') is not null),
        ('2026-10-08 piverify webhook', 'row level security enabled on piverify_events',
          coalesce((select c.relrowsecurity from pg_class c
                     where c.oid = to_regclass('public.piverify_events')), false)),
        ('2026-10-08 piverify webhook', 'unique index piverify_events_one_approval_per_courier',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='piverify_events_one_approval_per_courier')),
        ('2026-10-08 piverify webhook', 'piverify_events: service_role holds exactly SELECT, nobody else holds anything',
          to_regclass('public.piverify_events') is not null
          and not exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = to_regclass('public.piverify_events')
              and a.grantee <> c.relowner
              and not (a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                       and a.privilege_type = 'SELECT'))
          and exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = to_regclass('public.piverify_events')
              and a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
              and a.privilege_type = 'SELECT')),
        ('2026-10-08 piverify webhook', 'function courier_apply_kyc_status, security definer, search_path pinned',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='courier_apply_kyc_status'
                     and p.prosecdef
                     and array_to_string(p.proconfig, ',') like '%search_path%')),
        ('2026-10-08 piverify webhook', 'courier_apply_kyc_status: EXECUTE for service_role only',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='courier_apply_kyc_status')
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public' and p.proname = 'courier_apply_kyc_status'
              and a.grantee <> p.proowner
              and (a.grantee = 0 or pg_get_userbyid(a.grantee) <> 'service_role'))),
        ('2026-10-08 piverify resubmission', 'column courier_registry.piverify_allowed_action',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry'
                     and column_name='piverify_allowed_action')),
        ('2026-10-08 piverify resubmission', 'constraint courier_registry_piverify_allowed_action_check',
          exists (select 1 from pg_constraint
                   where conrelid = to_regclass('public.courier_registry')
                     and conname = 'courier_registry_piverify_allowed_action_check')),
        ('2026-10-08 piverify resubmission', 'courier_apply_kyc_status has exactly one signature, the six-argument one',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='courier_apply_kyc_status') = 1
          and exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='courier_apply_kyc_status'
                         and pg_get_function_identity_arguments(p.oid)
                             = 'p_event_id text, p_event_type text, p_session_id text, p_external_user_id text, '
                               || 'p_status text, p_allowed_action text')),
        ('2026-10-08 courier signin', 'table courier_signin_codes',
          to_regclass('public.courier_signin_codes') is not null),
        ('2026-10-08 courier signin', 'table courier_sessions',
          to_regclass('public.courier_sessions') is not null),
        ('2026-10-08 courier signin', 'row level security enabled on courier_signin_codes and courier_sessions',
          coalesce((select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c
                     where c.oid in (to_regclass('public.courier_signin_codes'),
                                     to_regclass('public.courier_sessions'))), false)),
        ('2026-10-08 courier signin', 'unique index courier_signin_codes_one_live_per_courier',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='courier_signin_codes_one_live_per_courier')),
        ('2026-10-08 courier signin', 'courier_signin_codes and courier_sessions: service_role holds exactly SELECT, nobody else holds anything',
          to_regclass('public.courier_signin_codes') is not null
          and to_regclass('public.courier_sessions') is not null
          and not exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid in (to_regclass('public.courier_signin_codes'), to_regclass('public.courier_sessions'))
              and a.grantee <> c.relowner
              and not (a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                       and a.privilege_type = 'SELECT'))
          and (select count(*) from pg_class c
               cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               where c.oid in (to_regclass('public.courier_signin_codes'), to_regclass('public.courier_sessions'))
                 and a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                 and a.privilege_type = 'SELECT') = 2),
        ('2026-10-08 courier signin', 'six functions, one signature each, security definer, search_path pinned',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public'
              and p.proname in ('courier_register_legacy', 'courier_issue_signin_code',
                                'courier_revoke_sessions', 'courier_redeem_signin_code',
                                'courier_session_resolve', 'courier_end_session')
              and p.prosecdef
              and array_to_string(p.proconfig, ',') like '%search_path%') = 6
          and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public'
                  and p.proname in ('courier_register_legacy', 'courier_issue_signin_code',
                                    'courier_revoke_sessions', 'courier_redeem_signin_code',
                                    'courier_session_resolve', 'courier_end_session')) = 6),
        ('2026-10-08 courier signin', 'courier_register_legacy, courier_issue_signin_code, courier_revoke_sessions: EXECUTE for no role but the owner',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public'
              and p.proname in ('courier_register_legacy', 'courier_issue_signin_code', 'courier_revoke_sessions')) = 3
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public'
              and p.proname in ('courier_register_legacy', 'courier_issue_signin_code', 'courier_revoke_sessions')
              and a.grantee <> p.proowner)),
        ('2026-10-08 courier signin', 'service_role cannot execute courier_register_legacy',
          case when to_regprocedure('public.courier_register_legacy()') is null then false
               else not has_function_privilege('service_role', 'public.courier_register_legacy()', 'EXECUTE') end),
        ('2026-10-08 courier signin', 'service_role cannot execute courier_issue_signin_code',
          case when to_regprocedure('public.courier_issue_signin_code(uuid)') is null then false
               else not has_function_privilege('service_role', 'public.courier_issue_signin_code(uuid)', 'EXECUTE') end),
        ('2026-10-08 courier signin', 'service_role cannot execute courier_revoke_sessions',
          case when to_regprocedure('public.courier_revoke_sessions(uuid)') is null then false
               else not has_function_privilege('service_role', 'public.courier_revoke_sessions(uuid)', 'EXECUTE') end),
        ('2026-10-08 courier signin', 'courier_redeem_signin_code, courier_session_resolve, courier_end_session: EXECUTE for service_role only',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public'
              and p.proname in ('courier_redeem_signin_code', 'courier_session_resolve', 'courier_end_session')
              and exists (select 1 from aclexplode(p.proacl) a
                           where a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                             and a.privilege_type = 'EXECUTE')) = 3
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public'
              and p.proname in ('courier_redeem_signin_code', 'courier_session_resolve', 'courier_end_session')
              and a.grantee <> p.proowner
              and (a.grantee = 0 or pg_get_userbyid(a.grantee) <> 'service_role'))),
        ('2026-10-08 courier piverify bind', 'function courier_bind_piverify_session, one signature, security definer, search_path pinned',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='courier_bind_piverify_session') = 1
          and exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='courier_bind_piverify_session'
                         and pg_get_function_identity_arguments(p.oid)
                             = 'p_courier_id uuid, p_expected_session_id text, p_new_session_id text, p_status text'
                         and p.prosecdef
                         and array_to_string(p.proconfig, ',') like '%search_path%')),
        ('2026-10-08 courier piverify bind', 'courier_bind_piverify_session: EXECUTE for service_role only',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='courier_bind_piverify_session'
                     and exists (select 1 from aclexplode(p.proacl) a
                                  where a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                                    and a.privilege_type = 'EXECUTE'))
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public' and p.proname = 'courier_bind_piverify_session'
              and a.grantee <> p.proowner
              and (a.grantee = 0 or pg_get_userbyid(a.grantee) <> 'service_role'))),
        ('2026-10-10 declared value', 'column guest_jobs.declared_value_cedis, integer, nullable',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='declared_value_cedis'
                     and data_type='integer' and is_nullable='YES')),
        ('2026-10-10 declared value', 'constraint guest_jobs_declared_value_cedis_check, validated',
          exists (select 1 from pg_constraint
                   where conrelid = to_regclass('public.guest_jobs')
                     and conname = 'guest_jobs_declared_value_cedis_check'
                     and contype = 'c' and convalidated)),
        ('2026-10-10 declared value', 'anon, authenticated and gyema_reader hold no privilege on guest_jobs.declared_value_cedis',
          -- CASE, not AND: has_column_privilege raises on a column that does not
          -- exist, and CASE is what guarantees it is not reached before the file.
          case when not exists (select 1 from information_schema.columns
                                 where table_schema='public' and table_name='guest_jobs'
                                   and column_name='declared_value_cedis') then false
               else not exists (
                 select 1 from pg_roles r
                 cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as pv(privilege)
                 where r.rolname in ('anon', 'authenticated', 'gyema_reader')
                   and has_column_privilege(r.oid, to_regclass('public.guest_jobs'), 'declared_value_cedis', pv.privilege))
          end),
        ('2026-10-09 courier assignment', 'column guest_jobs.assigned_courier_id, uuid, nullable',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='assigned_courier_id'
                     and data_type='uuid' and is_nullable='YES')),
        ('2026-10-09 courier assignment', 'constraint guest_jobs_assigned_courier_id_fkey, foreign key to courier_registry, validated',
          exists (select 1 from pg_constraint
                   where conrelid = to_regclass('public.guest_jobs')
                     and conname = 'guest_jobs_assigned_courier_id_fkey'
                     and contype = 'f' and convalidated
                     and confrelid = to_regclass('public.courier_registry'))),
        ('2026-10-09 courier assignment', 'index guest_jobs_assigned_courier_id_idx',
          exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='guest_jobs_assigned_courier_id_idx')),
        ('2026-10-09 courier assignment', 'anon, authenticated and gyema_reader hold no privilege on guest_jobs.assigned_courier_id',
          -- CASE, not AND, as for declared_value_cedis above.
          case when not exists (select 1 from information_schema.columns
                                 where table_schema='public' and table_name='guest_jobs'
                                   and column_name='assigned_courier_id') then false
               else not exists (
                 select 1 from pg_roles r
                 cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as pv(privilege)
                 where r.rolname in ('anon', 'authenticated', 'gyema_reader')
                   and has_column_privilege(r.oid, to_regclass('public.guest_jobs'), 'assigned_courier_id', pv.privilege))
          end),
        ('2026-10-09 courier assignment', 'column courier_registry.vouched_at, timestamptz, nullable',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry'
                     and column_name='vouched_at'
                     and data_type='timestamp with time zone' and is_nullable='YES')),
        ('2026-10-09 courier assignment', 'constraint courier_registry_vouched_pioneer_only_check, validated',
          exists (select 1 from pg_constraint
                   where conrelid = to_regclass('public.courier_registry')
                     and conname = 'courier_registry_vouched_pioneer_only_check'
                     and contype = 'c' and convalidated)),
        ('2026-10-09 courier assignment', 'courier_register_pioneer and courier_find_pioneer, one signature each, security definer, search_path pinned',
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public'
              and ((p.proname = 'courier_register_pioneer'
                    and pg_get_function_identity_arguments(p.oid) = 'p_pi_username text')
                or (p.proname = 'courier_find_pioneer'
                    and pg_get_function_identity_arguments(p.oid) = 'p_pi_username text'))
              and p.prosecdef
              and array_to_string(p.proconfig, ',') like '%search_path%') = 2
          and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public'
                  and p.proname in ('courier_register_pioneer', 'courier_find_pioneer')) = 2),
        ('2026-10-09 courier assignment', 'courier_register_pioneer: EXECUTE for no role but the owner',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='courier_register_pioneer')
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public' and p.proname = 'courier_register_pioneer'
              and a.grantee <> p.proowner)),
        ('2026-10-09 courier assignment', 'service_role cannot execute courier_register_pioneer',
          case when to_regprocedure('public.courier_register_pioneer(text)') is null then false
               else not has_function_privilege('service_role', 'public.courier_register_pioneer(text)', 'EXECUTE') end),
        ('2026-10-09 courier assignment', 'courier_find_pioneer: EXECUTE for service_role only',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='courier_find_pioneer'
                     and exists (select 1 from aclexplode(p.proacl) a
                                  where a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'service_role'
                                    and a.privilege_type = 'EXECUTE'))
          and not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public' and p.proname = 'courier_find_pioneer'
              and a.grantee <> p.proowner
              and (a.grantee = 0 or pg_get_userbyid(a.grantee) <> 'service_role'))),
        ('2026-10-09 dispatch view courier id', 'guest_jobs_dispatch column 24 is assigned_courier_id',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs_dispatch'
                     and column_name='assigned_courier_id' and ordinal_position=24)),
        ('2026-10-09 dispatch view courier id', 'guest_jobs_dispatch column 25 is declared_value_cedis, the last column',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs_dispatch'
                     and column_name='declared_value_cedis' and ordinal_position=25)
          and (select count(*) from information_schema.columns
                where table_schema='public' and table_name='guest_jobs_dispatch') = 25),
        ('2026-10-10 courier registry dispatch', 'view courier_registry_dispatch, security_invoker false',
          exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname='public' and c.relname='courier_registry_dispatch' and c.relkind='v'
                     and 'security_invoker=false' = any(c.reloptions))),
        -- Amended 12 Oct 2026 (item 10): P18 appends columns 10 and 11, so this
        -- row no longer says "the last of 9". The 2026-10-12 rows check the rest.
        ('2026-10-10 courier registry dispatch', 'courier_registry_dispatch column 9 is piverify_allowed_action',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry_dispatch'
                     and column_name='piverify_allowed_action' and ordinal_position=9)),
        ('2026-10-10 courier registry dispatch', 'courier_registry_dispatch carries no pi_username, commitment_salt, piverify_session_id, auth_user_id or id',
          to_regclass('public.courier_registry_dispatch') is not null
          and not exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='courier_registry_dispatch'
                             and column_name in ('pi_username', 'commitment_salt', 'piverify_session_id',
                                                 'auth_user_id', 'id'))),
        ('2026-10-10 courier registry dispatch', 'courier_registry_dispatch: gyema_reader holds exactly SELECT, nobody else holds anything',
          to_regclass('public.courier_registry_dispatch') is not null
          and not exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = to_regclass('public.courier_registry_dispatch')
              and a.grantee <> c.relowner
              and not (a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'gyema_reader'
                       and a.privilege_type = 'SELECT'))
          and exists (
            select 1 from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = to_regclass('public.courier_registry_dispatch')
              and a.grantee <> 0 and pg_get_userbyid(a.grantee) = 'gyema_reader'
              and a.privilege_type = 'SELECT')),
        ('2026-10-11 guest status check', 'constraint guest_jobs_status_check, validated, exactly the seven values',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.guest_jobs')
                     and k.conname = 'guest_jobs_status_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ '''posted'''
                     and pg_get_constraintdef(k.oid) ~ '''pending_quote'''
                     and pg_get_constraintdef(k.oid) ~ '''accepted'''
                     and pg_get_constraintdef(k.oid) ~ '''in_transit'''
                     and pg_get_constraintdef(k.oid) ~ '''delivered'''
                     and pg_get_constraintdef(k.oid) ~ '''cancelled'''
                     and pg_get_constraintdef(k.oid) ~ '''expired'''
                     and (select count(*) from regexp_matches(pg_get_constraintdef(k.oid), '''[a-z_]+''', 'g')) = 7)),
        ('2026-10-11 registry timing checks', 'constraint courier_registry_full_needs_approval_check, validated',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_full_needs_approval_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ 'kyc_approved_at IS NOT NULL'
                     and pg_get_constraintdef(k.oid) ~ 'vouched_at IS NOT NULL')),
        ('2026-10-11 registry timing checks', 'constraint courier_registry_buffer_needs_since_check, validated',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_buffer_needs_since_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ 'buffer_since IS NOT NULL')),
        ('2026-10-12 operator check', 'column courier_registry.operator_checked_at, timestamptz',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry'
                     and column_name='operator_checked_at' and data_type='timestamp with time zone'
                     and is_nullable='YES')),
        ('2026-10-12 operator check', 'column courier_registry.operator_checked_by, text',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry'
                     and column_name='operator_checked_by' and data_type='text'
                     and is_nullable='YES')),
        ('2026-10-12 operator check', 'column courier_registry.operator_check_deadline, timestamptz',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry'
                     and column_name='operator_check_deadline' and data_type='timestamp with time zone'
                     and is_nullable='YES')),
        ('2026-10-12 operator check', 'constraint courier_registry_operator_checked_legacy_only_check, validated',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_operator_checked_legacy_only_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ 'class = ''legacy''::text')),
        ('2026-10-12 operator check', 'constraint courier_registry_operator_check_pair_check, validated',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_operator_check_pair_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ 'operator_checked_by IS NULL')),
        ('2026-10-12 operator check', 'constraint courier_registry_operator_checked_by_check, validated, founder only',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_operator_checked_by_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ '''founder''::text'
                     and (select count(*) from regexp_matches(pg_get_constraintdef(k.oid), '''[a-z_]+''', 'g')) = 1)),
        ('2026-10-12 operator check', 'constraint courier_registry_operator_check_deadline_check, validated',
          exists (select 1 from pg_constraint k
                   where k.conrelid = to_regclass('public.courier_registry')
                     and k.conname = 'courier_registry_operator_check_deadline_check'
                     and k.contype = 'c' and k.convalidated
                     and pg_get_constraintdef(k.oid) ~ 'operator_check_deadline IS NULL')),
        ('2026-10-12 operator check', 'function courier_record_operator_check(uuid, text), security definer, search_path pinned',
          exists (select 1 from pg_proc p
                   where p.oid = to_regprocedure('public.courier_record_operator_check(uuid, text)')
                     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%')),
        ('2026-10-12 operator check', 'function courier_start_operator_check_sunset(), security definer, search_path pinned',
          exists (select 1 from pg_proc p
                   where p.oid = to_regprocedure('public.courier_start_operator_check_sunset()')
                     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%')),
        ('2026-10-12 operator check', 'service_role cannot execute courier_record_operator_check',
          case when to_regprocedure('public.courier_record_operator_check(uuid, text)') is null then false
               else not has_function_privilege('service_role', 'public.courier_record_operator_check(uuid, text)', 'EXECUTE')
                    and not exists (
                      select 1 from pg_proc p
                      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where p.oid = to_regprocedure('public.courier_record_operator_check(uuid, text)')
                        and a.grantee <> p.proowner) end),
        ('2026-10-12 operator check', 'service_role cannot execute courier_start_operator_check_sunset',
          case when to_regprocedure('public.courier_start_operator_check_sunset()') is null then false
               else not has_function_privilege('service_role', 'public.courier_start_operator_check_sunset()', 'EXECUTE')
                    and not exists (
                      select 1 from pg_proc p
                      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where p.oid = to_regprocedure('public.courier_start_operator_check_sunset()')
                        and a.grantee <> p.proowner) end),
        ('2026-10-12 operator check', 'courier_bind_piverify_session keeps buffer for a checked courier before the deadline',
          exists (select 1 from pg_proc p
                   where p.oid = to_regprocedure('public.courier_bind_piverify_session(uuid, text, text, text)')
                     and p.prosrc ~ 'r\.buffer_since = r\.operator_checked_at'
                     and p.prosrc ~ 'now\(\) < r\.operator_check_deadline')),
        ('2026-10-12 operator check', 'courier_registry_dispatch column 10 is operator_checked_at',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry_dispatch'
                     and column_name='operator_checked_at' and ordinal_position=10)),
        ('2026-10-12 operator check', 'courier_registry_dispatch column 11 is operator_check_deadline, the last of 11 columns',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='courier_registry_dispatch'
                     and column_name='operator_check_deadline' and ordinal_position=11)
          and (select count(*) from information_schema.columns
                where table_schema='public' and table_name='courier_registry_dispatch') = 11),
        ('2026-10-12 operator check', 'courier_registry_dispatch carries no operator_checked_by',
          to_regclass('public.courier_registry_dispatch') is not null
          and not exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='courier_registry_dispatch'
                             and column_name='operator_checked_by'))
    ) as t(m, o, present)
  ) s
),

-- CHECK 10. The reader role's session bounds.
check_10_reader_role as (
  select coalesce(jsonb_agg(x), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'rolname', rolname,
      'can_login', rolcanlogin,
      'superuser', rolsuper,
      'createdb', rolcreatedb,
      'createrole', rolcreaterole,
      'inherit', rolinherit,
      'settings', to_jsonb(rolconfig)
    ) as x
    from pg_roles where rolname = 'gyema_reader'
  ) s
),

-- CHECK 11. Table and view inventory, for drift between the two networks.
check_11_inventory as (
  select coalesce(jsonb_agg(x order by x->>'kind', x->>'name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'name', c.relname,
      'kind', case c.relkind when 'r' then 'table' when 'v' then 'view' else c.relkind::text end,
      'approx_rows', c.reltuples::bigint,
      'column_count', (select count(*) from information_schema.columns col
                        where col.table_schema = 'public' and col.table_name = c.relname),
      'referenced_by_repo', (c.relname in (
        'listings', 'guest_jobs', 'pioneers', 'auth_events',
        'guest_jobs_dispatch', 'listings_dispatch', 'courier_registry', 'piverify_events',
        'courier_signin_codes', 'courier_sessions', 'courier_registry_dispatch'))
    ) as x
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
  ) s
),

-- CHECK 12. Any security definer function in public that PUBLIC, anon or
-- authenticated can execute. Read from the ACL with aclexplode, so a function
-- granted to anon AND service_role is listed too: the earlier text match
-- skipped any ACL that also named service_role. A null proacl means the
-- built in default, EXECUTE to PUBLIC.
check_12_public_execute as (
  select coalesce(jsonb_agg(x order by x->>'function_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'function_name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid),
      'owner', pg_get_userbyid(p.proowner),
      'executable_by', (
        select to_jsonb(array_agg(distinct g order by g))
          from (
            select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
              from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             where a.privilege_type = 'EXECUTE'
               and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
          ) e),
      'acl', case when p.proacl is null
                  then to_jsonb('(null: EXECUTE to PUBLIC)'::text)
                  else to_jsonb(p.proacl::text[]) end
    ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.privilege_type = 'EXECUTE'
           and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated')))
  ) s
),

-- CHECK 12b. Default privileges: what a NEWLY created object starts with.
--
-- Section 1 of the grant baseline revokes from the objects that exist when it
-- runs, and says nothing about the next one. This is the rule for the objects
-- created afterwards. The two dispatch views were born with Supabase's
-- defaults on them because a later migration creates them, which is the
-- 7 September finding.
check_12b_default_privileges as (
  select coalesce(jsonb_agg(x order by x->>'creating_role', x->>'object_type'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'creating_role', pg_get_userbyid(d.defaclrole),
      'schema', n.nspname,
      'object_type', case d.defaclobjtype when 'r' then 'tables'
                                          when 'S' then 'sequences'
                                          when 'f' then 'functions'
                                          when 'T' then 'types'
                                          else d.defaclobjtype::text end,
      'default_acl', to_jsonb(d.defaclacl::text[]),
      'grants_anon_or_authenticated',
        coalesce(array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)=', false),
      'grants_public',
        coalesce(array_to_string(d.defaclacl, ',') ~ '(^|,)=', false)
    ) as x
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public'
  ) s
),

-- CHECK 13. The table this repository never references. Column names
-- and types only, never a value, so a PII-shaped column is visible without
-- reading anyone's data.
check_13_unreferenced_tables as (
  select coalesce(jsonb_agg(x order by x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'table_name', t.name,
      'exists', (c.oid is not null),
      'rls_enabled', c.relrowsecurity,
      'policy_count', (select count(*) from pg_policies p
                        where p.schemaname = 'public' and p.tablename = t.name),
      'approx_rows', c.reltuples::bigint,
      'grants', coalesce((
        select jsonb_agg(distinct jsonb_build_object('grantee', g.grantee, 'privilege', g.privilege_type))
        from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = t.name
          and g.grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
      ), '[]'::jsonb),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object('name', col.column_name, 'type', col.data_type)
                         order by col.ordinal_position)
        from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = t.name
      ), '[]'::jsonb),
      'pii_shaped_columns', coalesce((
        select jsonb_agg(col.column_name order by col.column_name)
        from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = t.name
          and (col.column_name ilike '%phone%'
            or col.column_name ilike '%whatsapp%'
            or col.column_name ilike '%email%'
            or col.column_name ilike '%name%'
            or col.column_name ilike '%address%'
            or col.column_name ilike '%wallet%'
            or col.column_name ilike '%uid%')
      ), '[]'::jsonb)
    ) as x
    from (values ('a2u_payments')) as t(name)
    left join pg_namespace n on n.nspname = 'public'
    left join pg_class c on c.relname = t.name and c.relnamespace = n.oid and c.relkind = 'r'
  ) s
),

-- CHECK 14. The courier registry's shape, by name. Columns, every constraint
-- with its definition, every index with its definition, and three counts of
-- rows breaking the timing rules. Amended 11 Oct 2026: the full and buffer
-- rules become checks in 2026-10-11_courier_registry_timing_checks.sql (P17),
-- so after it those two counts can only read zero; paused stays a count. The
-- counts are aggregates: no value from any row is returned. query_to_xml runs
-- the counts only once the table is known to exist, so this check reads
-- exists false, rather than failing, before the migration is applied.
check_14_courier_registry as (
  select case when to_regclass('public.courier_registry') is null
              then jsonb_build_object('exists', false)
              else jsonb_build_object(
    'exists', true,
    'rls_enabled', (select c.relrowsecurity from pg_class c
                     where c.oid = to_regclass('public.courier_registry')),
    'policy_count', (select count(*) from pg_policies
                      where schemaname = 'public' and tablename = 'courier_registry'),
    'columns', (
      select jsonb_agg(jsonb_build_object(
               'name', col.column_name, 'type', col.data_type,
               'nullable', col.is_nullable = 'YES', 'default', col.column_default)
             order by col.ordinal_position)
        from information_schema.columns col
       where col.table_schema = 'public' and col.table_name = 'courier_registry'),
    'constraints', (
      select jsonb_agg(jsonb_build_object('name', k.conname, 'definition', pg_get_constraintdef(k.oid))
             order by k.conname)
        from pg_constraint k
       where k.conrelid = to_regclass('public.courier_registry')),
    'indexes', (
      select jsonb_agg(jsonb_build_object('name', i.indexname, 'definition', i.indexdef)
             order by i.indexname)
        from pg_indexes i
       where i.schemaname = 'public' and i.tablename = 'courier_registry'),
    'timing_rule_breaks', jsonb_build_object(
      -- Amended 9 Oct 2026, item 6: full means kyc_approved_at OR vouched_at.
      -- Before 2026-10-09_guest_jobs_courier_assignment.sql there is no
      -- vouched_at, so the clause naming it is added only once the column
      -- exists, and the count reads kyc_approved_at alone until then.
      'full_without_kyc_approved_at_or_vouched_at',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from public.courier_registry where status = ''full'' and kyc_approved_at is null'
          || case when exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'courier_registry'
                                  and column_name = 'vouched_at')
                  then ' and vouched_at is null' else '' end,
          false, true, '')))[1]::text::bigint,
      'vouched_at_column_exists',
        exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'courier_registry'
                   and column_name = 'vouched_at'),
      'buffer_without_buffer_since',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from public.courier_registry where status = ''buffer'' and buffer_since is null',
          false, true, '')))[1]::text::bigint,
      'paused_without_reason',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from public.courier_registry where status = ''paused'' and paused_reason is null',
          false, true, '')))[1]::text::bigint,
      -- Added 12 Oct 2026, item 10 (P18). Null before
      -- 2026-10-12_courier_operator_check.sql adds the columns.
      'operator_checked_buffer_past_deadline',
        case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'courier_registry'
                             and column_name = 'operator_check_deadline')
             then (xpath('/row/n/text()', query_to_xml(
               'select count(*) as n from public.courier_registry where status = ''buffer'' '
               || 'and operator_checked_at is not null and buffer_since = operator_checked_at '
               || 'and operator_check_deadline <= now() and shredded_at is null',
               false, true, '')))[1]::text::bigint end,
      'operator_checked_not_legacy',
        case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'courier_registry'
                             and column_name = 'operator_checked_at')
             then (xpath('/row/n/text()', query_to_xml(
               'select count(*) as n from public.courier_registry where operator_checked_at is not null '
               || 'and class <> ''legacy''',
               false, true, '')))[1]::text::bigint end)
  ) end as v
),

-- CHECK 15. Courier sign-in: courier_signin_codes and courier_sessions by
-- name, and three counts. Aggregates only: no hash, id or time from any row
-- is returned. Reads exists false, rather than failing, before
-- 2026-10-08_courier_signin.sql is applied, the same way check 14 does.
check_15_courier_signin as (
  select case when to_regclass('public.courier_signin_codes') is null
                or to_regclass('public.courier_sessions') is null
              then jsonb_build_object(
                'exists', false,
                'courier_signin_codes_exists', to_regclass('public.courier_signin_codes') is not null,
                'courier_sessions_exists', to_regclass('public.courier_sessions') is not null)
              else jsonb_build_object(
    'exists', true,
    'tables', (
      select jsonb_agg(jsonb_build_object(
               'table_name', c.relname,
               'rls_enabled', c.relrowsecurity,
               'policy_count', (select count(*) from pg_policies p
                                 where p.schemaname = 'public' and p.tablename = c.relname),
               'columns', (
                 select jsonb_agg(jsonb_build_object(
                          'name', col.column_name, 'type', col.data_type,
                          'nullable', col.is_nullable = 'YES', 'default', col.column_default)
                        order by col.ordinal_position)
                   from information_schema.columns col
                  where col.table_schema = 'public' and col.table_name = c.relname),
               'constraints', (
                 select jsonb_agg(jsonb_build_object('name', k.conname, 'definition', pg_get_constraintdef(k.oid))
                        order by k.conname)
                   from pg_constraint k
                  where k.conrelid = c.oid),
               'indexes', (
                 select jsonb_agg(jsonb_build_object('name', i.indexname, 'definition', i.indexdef)
                        order by i.indexname)
                   from pg_indexes i
                  where i.schemaname = 'public' and i.tablename = c.relname))
             order by c.relname)
        from pg_class c
       where c.oid in (to_regclass('public.courier_signin_codes'), to_regclass('public.courier_sessions'))),
    'counts', jsonb_build_object(
      'codes_live',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from public.courier_signin_codes '
          || 'where consumed_at is null and revoked_at is null and expires_at > now()',
          false, true, '')))[1]::text::bigint,
      'codes_unconsumed_past_expiry',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from public.courier_signin_codes '
          || 'where consumed_at is null and revoked_at is null and expires_at <= now()',
          false, true, '')))[1]::text::bigint,
      'couriers_with_more_than_one_unrevoked_session',
        (xpath('/row/n/text()', query_to_xml(
          'select count(*) as n from (select courier_id from public.courier_sessions '
          || 'where revoked_at is null group by courier_id having count(*) > 1) m',
          false, true, '')))[1]::text::bigint)
  ) end as v
),

-- CHECK 16. guest_jobs.declared_value_cedis: three counts. Aggregates only, no
-- value or row is returned. The column is read through query_to_xml so this
-- reads exists false, rather than failing to parse, before
-- 2026-10-10_guest_jobs_declared_value.sql is applied.
check_16_guest_declared_value as (
  select case when not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'guest_jobs'
                                  and column_name = 'declared_value_cedis')
              then jsonb_build_object('exists', false)
              else jsonb_build_object(
    'exists', true,
    'rows_with_value',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs where declared_value_cedis is not null',
        false, true, '')))[1]::text::bigint,
    'rows_without_value',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs where declared_value_cedis is null',
        false, true, '')))[1]::text::bigint,
    'null_rows_posted_after_first_valued_row',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs where declared_value_cedis is null '
        || 'and created_at > (select min(created_at) from public.guest_jobs '
        || 'where declared_value_cedis is not null)',
        false, true, '')))[1]::text::bigint)
  end as v
),

-- CHECK 17. guest_jobs.assigned_courier_id: three counts. Aggregates only, no
-- value or row is returned. Read through query_to_xml, guarded on the column,
-- so this reads exists false, rather than failing to parse, before
-- 2026-10-09_guest_jobs_courier_assignment.sql is applied.
check_17_courier_assignment as (
  select case when not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'guest_jobs'
                                  and column_name = 'assigned_courier_id')
              then jsonb_build_object('exists', false)
              else jsonb_build_object(
    'exists', true,
    'rows_with_assigned_courier_id',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs where assigned_courier_id is not null',
        false, true, '')))[1]::text::bigint,
    'unassigned_rows_past_posting',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs '
        || 'where assigned_courier is null and assigned_courier_id is null '
        || 'and status is distinct from ''posted'' and status is distinct from ''pending_quote'' '
        || 'and status is distinct from ''expired''',
        false, true, '')))[1]::text::bigint,
    'legacy_claims_with_assigned_courier_set',
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.guest_jobs g '
        || 'join public.courier_registry r on r.id = g.assigned_courier_id '
        || 'where r.class = ''legacy'' and g.assigned_courier is not null',
        false, true, '')))[1]::text::bigint)
  end as v
)

select jsonb_pretty(jsonb_build_object(
  'gyema_catalog_checks', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'server_version', current_setting('server_version'),
    'network_label', 'FILL THIS IN: TESTNET or MAINNET'
  ),

  -- Expectations for every check, so a differing result is visible here rather
  -- than by going back to the file that produced it.
  'expected', jsonb_build_object(
    'check_01_rls',
      'One row per table in public. rls_enabled true on listings, guest_jobs, pioneers, auth_events, '
      || 'and courier_registry once applied. '
      || 'For a2u_payments the expectation is unknown, and rls_enabled false on it is a finding: an '
      || 'unreferenced table is exactly where nobody notices RLS is off. couriers and legacy_couriers should '
      || 'not appear once 2026-10-08_drop_orphan_courier_tables.sql is applied. '
      || 'rls_forced false everywhere.',
    'check_02_policies',
      'listings SELECT qual is expected to be literally true, which is what makes every column of every '
      || 'listing readable with the anon key (finding S-1). listings DELETE body is unknown to me and matters: '
      || 'a permissive DELETE cannot be undone from the app. listings UPDATE is expected to admit poster or '
      || 'matched party. guest_jobs is expected to have no policy admitting anon or authenticated. '
      || 'gyema_reader_select is expected absent once 2026-09-07 is applied. Policies on a2u_payments, the '
      || 'one unreferenced table: unknown, read them.',
    'check_03_table_grants',
      'Read the two dispatch views here as well. Each must show exactly two grantees from this list: '
      || 'gyema_reader with SELECT only, and service_role with the full set (DELETE, INSERT, MAINTAIN from '
      || 'Postgres 17, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE). service_role is correct there, not a '
      || 'finding: the grant baseline revokes the Supabase default privileges from anon and authenticated only, '
      || 'and the views are created after it. Corrected 15 September, when this line still said gyema_reader '
      || 'and nothing else; confirmed for guest_jobs_dispatch on Testnet that day. The owner, postgres, is '
      || 'outside this check filter and does not appear. Any row for anon, authenticated or PUBLIC on either '
      || 'view is a finding: they are created after the grant baseline runs, so on 7 September '
      || 'they were found on Testnet holding Supabase default grants for anon and authenticated. '
      || 'listings to anon with SELECT. authenticated with SELECT, INSERT, DELETE but NOT UPDATE, because the '
      || '2026-08-14 migration dropped the table wide UPDATE and re-granted per column. guest_jobs expected to '
      || 'show nothing for anon or authenticated: the guest rail is service_role only, and any row there is a '
      || 'finding. gyema_reader expected on the two dispatch views only. courier_registry, once applied: '
      || 'service_role with SELECT, INSERT, UPDATE and nothing else, and no row for anon, authenticated or '
      || 'gyema_reader. courier_registry_dispatch, once 2026-10-10_courier_registry_dispatch_view.sql is '
      || 'applied: gyema_reader with SELECT and NO OTHER ROW, service_role included. That differs from the two '
      || 'older dispatch views on purpose: this view is automatically updatable, so a DELETE or UPDATE grant on '
      || 'it would act on courier_registry with the owner''s rights.',
    'check_04_column_grants',
      'Two things. First, the authenticated UPDATE column list on listings should NOT contain status, '
      || 'sender_confirmed, traveller_confirmed or completed_at: those are attestation columns and belong to '
      || 'the RPC. Second, whatsapp and matched_with_whatsapp: if anon can read them here, or reads them '
      || 'through a table wide grant in check 03 with no column restriction, S-1 is confirmed. gyema_reader '
      || 'expected to have zero rows for sender_phone and recipient_phone.',
    'check_03b_and_04b_catalog_grants',
      'The same two questions read from pg_class.relacl and pg_attribute.attacl, where no role membership '
      || 'filtering applies. These are the authoritative answers. If 03 and 03b disagree, or 04 and 04b '
      || 'disagree, believe the catalog ones and tell me, because the disagreement itself is worth knowing.',
    'check_05_listings_insert_policy',
      'One INSERT policy on listings. If mentions_posted_by_id and mentions_auth_uid are both false then the '
      || 'poster identity on a listing is whatever the client typed, and S-15 is confirmed rather than '
      || 'theoretical.',
    'check_06_functions',
      'Expect guest_bump_delivery_code_attempts, guest_stamp_delivery and listing_confirm_completion, and '
      || 'courier_apply_kyc_status once 2026-10-08 piverify webhook is applied, and the six courier sign-in '
      || 'functions and courier_bind_piverify_session once those files are applied, and courier_register_pioneer '
      || 'and courier_find_pioneer once 2026-10-09_guest_jobs_courier_assignment.sql is applied, as '
      || 'security definer with search_path_pinned true, and mask_phone_head_only as NOT security definer, '
      || 'immutable, search_path_pinned true. A security definer function with search_path_pinned false is a '
      || 'finding: it runs as its owner with whatever search_path the caller set.',
    'check_07_function_acls',
      'For the security definer functions, courier_apply_kyc_status included once applied, expect '
      || 'service_role and nothing else, so '
      || 'anon_or_authenticated_can_execute is false on every row. A true is the most serious single result '
      || 'this document can carry: it means a stamp can be written straight from the anon key without a route. '
      || 'Once 2026-10-08_courier_signin.sql is applied: courier_register_legacy, courier_issue_signin_code and '
      || 'courier_revoke_sessions carry the owner alone, acl {postgres=X/postgres} and no service_role entry, '
      || 'because they are founder-only and run from the SQL editor; courier_redeem_signin_code, '
      || 'courier_session_resolve and courier_end_session carry service_role and the owner. Once '
      || '2026-10-08_courier_piverify_bind.sql is applied: courier_bind_piverify_session, service_role and the owner. '
      || 'Once 2026-10-09_guest_jobs_courier_assignment.sql is applied: courier_register_pioneer carries the owner '
      || 'alone, acl {postgres=X/postgres}, founder-only like courier_register_legacy; courier_find_pioneer '
      || 'carries service_role and the owner. Once 2026-10-12_courier_operator_check.sql is applied: '
      || 'courier_record_operator_check and courier_start_operator_check_sunset carry the owner alone, acl '
      || '{postgres=X/postgres}, founder-only; courier_bind_piverify_session still service_role and the owner.',
    'check_08_guard_columns',
      'delivery_code_attempts present with default 0, and NO equivalent counter for the sender side last-4 '
      || 'guard. That absence is S-2, recorded from the catalog rather than inferred from reading routes.',
    'check_09_migration_objects',
      'TESTNET before 2026-09-07 is applied: everything present except the four 2026-09-07 rows. MAINNET '
      || 'today: the 2026-08-13 and 2026-08-14 rows present, the 2026-08-18 role absent, which is the drift. '
      || 'BOTH after 2026-09-07: every 2026-09-07 row present and both gyema_reader_select rows false. '
      || 'The seven 2026-10-08 courier registry rows read false until that file is applied, and true after. '
      || 'The six 2026-10-08 piverify webhook rows likewise, for the file that follows it. The 2026-10-08 '
      || 'function defaults row reads false until 2026-10-08_default_function_privileges.sql is applied on a '
      || 'project whose postgres functions default still grants anon or authenticated. The two 2026-10-08 '
      || 'orphan drop rows read false where the table still exists, and true once '
      || '2026-10-08_drop_orphan_courier_tables.sql is applied (legacy_couriers reads true already on the '
      || 'network that never had it). The three 2026-10-08 piverify resubmission rows read false until '
      || '2026-10-08_piverify_resubmission.sql is applied, and true after. The signature row reads false again '
      || 'if 2026-10-08_piverify_webhook.sql is ever re-run after it, because that re-creates the five-argument '
      || 'function beside the six-argument one; running the resubmission file again fixes it. The ten '
      || '2026-10-08 courier signin rows read false until 2026-10-08_courier_signin.sql is applied, and true '
      || 'after; three of them are service_role cannot execute rows, one per founder-only function, true only '
      || 'when has_function_privilege says service_role cannot. The two 2026-10-08 courier piverify bind rows '
      || 'read false until 2026-10-08_courier_piverify_bind.sql is applied, and true after. The three '
      || '2026-10-10 declared value rows read false until 2026-10-10_guest_jobs_declared_value.sql is applied, '
      || 'and true after. The ten 2026-10-09 courier assignment rows read false until '
      || '2026-10-09_guest_jobs_courier_assignment.sql is applied, and true after; one is a service_role cannot '
      || 'execute row for courier_register_pioneer. The two 2026-10-09 dispatch view courier id rows read false '
      || 'until 2026-10-09_dispatch_view_courier_id.sql is applied, and true after. The four 2026-10-10 courier '
      || 'registry dispatch rows read false until 2026-10-10_courier_registry_dispatch_view.sql is applied, and '
      || 'true after. The 2026-10-11 guest status check row reads true on both networks already: the constraint '
      || 'was added by hand before db/migrations existed and found by catalog read on 11 Oct 2026, seven values, '
      || 'pending_quote among them; 2026-10-11_guest_jobs_status_check.sql records it and is a no-op there. '
      || 'The two 2026-10-11 registry timing checks rows read false until '
      || '2026-10-11_courier_registry_timing_checks.sql is applied, and true after (Testnet, 11 Oct 2026). '
      || 'The fifteen 2026-10-12 operator check rows read false until 2026-10-12_courier_operator_check.sql '
      || 'is applied, and true after; two are service_role cannot execute rows, one per founder-only function. '
      || 'The bind row reads false again if 2026-10-08_courier_piverify_bind.sql is ever re-run after it: never '
      || 're-run P12 after P18; running P18 again fixes it.',
    'check_10_reader_role',
      'After 2026-09-07: settings carry default_transaction_read_only=on, statement_timeout=10s, '
      || 'idle_in_transaction_session_timeout=30s, lock_timeout=5s. superuser, createdb, createrole and '
      || 'inherit all false. can_login true where the role is in use.',
    'check_11_inventory',
      'The same name list on both networks. Row counts will differ and that is fine; the list should not. '
      || 'A name on one network and not the other is drift that nothing in db/migrations accounts for. '
      || 'approx_rows of -1 means the table has never been analysed, not that it is empty. '
      || 'referenced_by_repo false marks a table no route, lib or migration in this repository mentions.',
    'check_12_public_execute',
      'Exactly one row: listing_counterpart_contact, executable_by ["authenticated"]. It is granted to '
      || 'authenticated on purpose and checks the caller itself (grant baseline section 3, identity migration). '
      || 'Any other row, or PUBLIC or anon on that one, is a finding: a security definer function PUBLIC, anon or '
      || 'authenticated can execute is reachable through PostgREST with a public key, whoever wrote it and '
      || 'whenever. Extended 8 October from PUBLIC only; the earlier text match also missed any ACL that named '
      || 'service_role alongside anon. Still exactly that one row after the courier sign-in, piverify bind, '
      || 'courier assignment and operator check files: each revokes its own functions from PUBLIC, anon and '
      || 'authenticated.',
    'check_12b_default_privileges',
      'One row per creating role and object type with default privileges in schema public. For the postgres '
      || 'rows: grants_anon_or_authenticated false on tables and sequences. CORRECTED 8 October: there IS a '
      || 'postgres functions row, and on Testnet it was found granting EXECUTE to anon and authenticated (the '
      || 'Supabase default). After 2026-10-08_default_function_privileges.sql it grants neither; service_role '
      || 'may remain. That still leaves EXECUTE to PUBLIC on every new function, which is the built in default '
      || 'and is not recorded in this schema-scoped row (measured on postgres 17, see that file), so a new '
      || 'function is callable with the public key until it is explicitly revoked. check_12_public_execute is '
      || 'the net. A creating role that does not appear here at all still carries the built in defaults, so if '
      || 'objects are ever created as something other than postgres, that role needs the same statements.',
    'check_13_unreferenced_tables',
      'a2u_payments, one row whether or not the table exists (exists false on a network that does not have it '
      || 'is itself an answer): is RLS on, who holds grants, and what the columns are. pii_shaped_columns is a '
      || 'name based guess, not a classification. It matches the unmerged branch feat/a2u-payout, so it may be '
      || 'a table created for work that never shipped. couriers and legacy_couriers left this check on 8 October; '
      || 'check 9 confirms they are dropped.',
    'check_14_courier_registry',
      'Before 2026-10-08 is applied: exists false. After: exists true, rls_enabled true, policy_count 0, '
      || 'fifteen columns, eleven constraints (courier_registry_pkey, courier_registry_auth_user_id_fkey to '
      || 'auth.users on delete set null, and nine checks, all named courier_registry_*), four indexes '
      || '(courier_registry_pkey, courier_registry_pi_username_lower_key on lower(pi_username), '
      || 'courier_registry_piverify_session_key and courier_registry_auth_user_key, the last three partial on '
      || 'not null). After 2026-10-08_piverify_resubmission.sql: sixteen columns, the sixteenth '
      || 'piverify_allowed_action (text, nullable), and twelve constraints, the tenth check being '
      || 'courier_registry_piverify_allowed_action_check; the indexes do not change. After '
      || '2026-10-09_guest_jobs_courier_assignment.sql: seventeen columns, the seventeenth vouched_at '
      || '(timestamptz, nullable), and thirteen constraints, the new one courier_registry_vouched_pioneer_only_check (vouched_at is null or class pioneer: a legacy courier reaches full only through PiVerify); the indexes do not change. '
      || 'After 2026-10-11_courier_registry_timing_checks.sql (P17, founder decision 11 Oct 2026): fifteen '
      || 'constraints, the two new ones courier_registry_full_needs_approval_check and '
      || 'courier_registry_buffer_needs_since_check, which turn the full and buffer timing rules below into checks, '
      || 'so those two counts can only read zero; the paused rule stays a count. After '
      || '2026-10-12_courier_operator_check.sql (P18, item 10): twenty columns, the new ones operator_checked_at '
      || '(timestamptz), operator_checked_by (text) and operator_check_deadline (timestamptz), all nullable, and '
      || 'nineteen constraints, the four new ones courier_registry_operator_checked_legacy_only_check, '
      || 'courier_registry_operator_check_pair_check, courier_registry_operator_checked_by_check and '
      || 'courier_registry_operator_check_deadline_check; the indexes do not change. Two counts are added, '
      || 'null before P18: operator_checked_buffer_past_deadline is information, a buffer row through the check '
      || 'at or past its sunset deadline, which the ladder already refuses and which is due a hand pause '
      || '(paused_reason pending_timeout); operator_checked_not_legacy can only read zero after P18. An '
      || 'operator check is never verification: anchoring and the trust bureau read kyc_approved_at only. '
      || 'timing_rule_breaks counts rows '
      || 'breaking rules that are deliberately not constraints, because the operator sets paused by hand: expect '
      || 'zero on each. A non-zero count is a row to look at, not necessarily a fault. A full row needs '
      || 'kyc_approved_at or vouched_at; vouched_at_column_exists says which rule was counted, and before the '
      || 'column exists the count reads kyc_approved_at alone. A vouched courier is full for dispatch only and '
      || 'is never KYC-verified: anything that presents verification reads kyc_approved_at. Grants are in check 3b and '
      || 'in the check 9 rows: service_role SELECT, INSERT, UPDATE only, and nothing for anon, authenticated, '
      || 'PUBLIC or gyema_reader.',
    'check_15_courier_signin',
      'Before 2026-10-08_courier_signin.sql is applied: exists false. After: exists true and two tables. '
      || 'courier_sessions: rls_enabled true, policy_count 0, nine columns, seven constraints '
      || '(courier_sessions_pkey, courier_sessions_courier_id_fkey, courier_sessions_code_id_fkey, '
      || 'courier_sessions_token_hash_key, and three checks: token_hash_length, revoked_reason, revoked_pair), '
      || 'three indexes (courier_sessions_pkey, courier_sessions_token_hash_key, courier_sessions_courier_id_idx). '
      || 'courier_signin_codes: rls_enabled true, policy_count 0, seven columns, five constraints '
      || '(courier_signin_codes_pkey, courier_signin_codes_courier_id_fkey, courier_signin_codes_code_hash_key, '
      || 'and two checks: code_hash_length, consumed_or_revoked), three indexes (courier_signin_codes_pkey, '
      || 'courier_signin_codes_code_hash_key, and courier_signin_codes_one_live_per_courier, unique on '
      || 'courier_id where consumed_at is null and revoked_at is null). counts: codes_live and '
      || 'codes_unconsumed_past_expiry are information, not errors. The partial unique index cannot reference '
      || 'now(), so an expired code stays unconsumed until the next issue for that courier revokes it, and '
      || 'redemption refuses it as expired meanwhile. couriers_with_more_than_one_unrevoked_session: expect 0; '
      || 'sign-in revokes every other unrevoked session for the courier. Grants are in check 3b and the check 9 '
      || 'rows: service_role SELECT only on both tables, and nothing for anon, authenticated, PUBLIC or '
      || 'gyema_reader.',
    'check_16_guest_declared_value',
      'Before 2026-10-10_guest_jobs_declared_value.sql is applied: exists false. After: exists true. '
      || 'rows_with_value and rows_without_value are information: every row posted before the item 7 code '
      || 'deploys is null, by design, and stays so. null_rows_posted_after_first_valued_row: expect 0 once the '
      || 'code is live, because the create route requires a value. Nothing in the database enforces that, so a '
      || 'non-zero count is a row posted by hand or by an old deployment, and worth reading. The column and its '
      || 'check are confirmed by the three 2026-10-10 declared value rows in check 9.',
    'check_17_courier_assignment',
      'Before 2026-10-09_guest_jobs_courier_assignment.sql is applied: exists false. After: exists true. '
      || 'rows_with_assigned_courier_id is information: 0 until the item 6 code takes its first claim, and rows '
      || 'claimed before item 6 stay null for good. unassigned_rows_past_posting is information: rows with '
      || 'neither courier column set whose status is not posted, pending_quote or expired, which today means '
      || 'rows closed by hand (F14, for example cancelled before a claim). Read a new one. '
      || 'legacy_claims_with_assigned_courier_set: expect 0. A legacy claim writes assigned_courier null, so a '
      || 'non-zero count is a row written by hand or by a bug. The column, its foreign key and index are '
      || 'confirmed by the 2026-10-09 courier assignment rows in check 9.'
  ),

  'check_01_rls',                   (select v from check_01_rls),
  'check_02_policies',              (select v from check_02_policies),
  'check_03_table_grants',          (select v from check_03_table_grants),
  'check_04_column_grants',         (select v from check_04_column_grants),
  'check_03b_table_grants_catalog', (select v from check_03b_table_grants_catalog),
  'check_04b_column_grants_catalog', (select v from check_04b_column_grants_catalog),
  'check_05_listings_insert_policy',(select v from check_05_listings_insert_policy),
  'check_06_functions',             (select v from check_06_functions),
  'check_07_function_acls',         (select v from check_07_function_acls),
  'check_08_guard_columns',         (select v from check_08_guard_columns),
  'check_09_migration_objects',     (select v from check_09_migration_objects),
  'check_10_reader_role',           (select v from check_10_reader_role),
  'check_11_inventory',             (select v from check_11_inventory),
  'check_12_public_execute',        (select v from check_12_public_execute),
  'check_12b_default_privileges',   (select v from check_12b_default_privileges),
  'check_13_unreferenced_tables',   (select v from check_13_unreferenced_tables),
  'check_14_courier_registry',      (select v from check_14_courier_registry),
  'check_15_courier_signin',        (select v from check_15_courier_signin),
  'check_16_guest_declared_value',  (select v from check_16_guest_declared_value),
  'check_17_courier_assignment',    (select v from check_17_courier_assignment)
)) as gyema_catalog_checks;

-- ===========================================================================
-- After running this
--
-- Paste the one cell back per network. The five answers that change what
-- happens next, in order:
--
--   1. check_02_policies: the listings SELECT qual and the DELETE body.
--   2. check_04_column_grants: whether anon can read whatsapp and
--      matched_with_whatsapp.
--   3. check_07_function_acls: whether anything but service_role holds EXECUTE.
--   4. check_13_unreferenced_tables: what a2u_payments is, and whether anon
--      can read it.
--   5. check_09_migration_objects: the per network checklist that turns the
--      drift from a guess into a list.
--
-- None of the fixes those imply are written yet, and none should be applied
-- from this file. Migrations go in db/migrations, one concern each, Testnet
-- first, applied by hand.
-- ===========================================================================
