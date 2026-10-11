-- ===========================================================================
-- 2026-10-08  New functions in public: no default EXECUTE for anon or
--             authenticated
-- ===========================================================================
--
-- THE FINDING
--
-- The catalog check (check 12b) found a default privileges row for role
-- postgres, schema public, object type functions, granting EXECUTE to anon and
-- authenticated. That is the Supabase project default. Every function created
-- in public afterwards is born with explicit EXECUTE for both roles, which
-- PostgREST exposes at /rest/v1/rpc/<name> to anyone holding the anon key. The
-- explicit revoke each migration in this repository carries is the only thing
-- that has stood between a new function and the public key.
--
-- WHAT THIS DOES
--
-- One statement, removing anon and authenticated from that default. A
-- function created afterwards no longer gets explicit entries for either role.
-- service_role keeps whatever the default gives it.
--
-- WHAT THIS DOES NOT DO, MEASURED, so nobody relies on it for more
--
-- A new function is STILL executable by anon and authenticated afterwards,
-- through PUBLIC. EXECUTE to PUBLIC is Postgres's built in default for
-- functions, and a default privileges row scoped to a schema (IN SCHEMA
-- public, as here) can only add to the built in defaults, never take away from
-- them. Measured on 8 October 2026 against postgres 17 (17.11): with this
-- statement applied, a new function's ACL read
-- {=X/postgres,postgres=X/postgres,service_role=X/postgres}, and
-- has_function_privilege('anon', ..., 'execute') returned true. The explicit
-- per-function revoke from public, anon and authenticated (CLAUDE.md invariant
-- 2) is therefore still required for every function, and catalog check 12
-- remains the net.
--
-- Removing PUBLIC from future functions takes the global form, with no IN
-- SCHEMA clause: ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON
-- FUNCTIONS FROM PUBLIC. In the same measurement that form did remove it (a
-- new function's ACL read {postgres=X/postgres,service_role=X/postgres} and
-- anon could not execute it). It also corrects section 1a of the grant
-- baseline, which measured only the IN SCHEMA form and concluded that no
-- default could take EXECUTE away from PUBLIC.
--
-- THE GLOBAL FORM IS NOT APPLIED. Founder decision, 8 October 2026. It
-- applies in every schema, and role postgres owned 49 functions in schema
-- extensions on the staging project. A global revoke from PUBLIC would leave
-- functions from future extension installs, pg_cron and pg_net included,
-- unexecutable by the roles that call them. The controls are therefore this
-- file's schema-scoped default, the explicit per-function revoke every
-- migration carries, and catalog check 12. Recorded in
-- docs/anchoring-phase1-notes.md.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run the whole file; its last statement is
-- a read-only verification.
--
-- IDEMPOTENT. ALTER DEFAULT PRIVILEGES is declarative: revoking what is not
-- granted changes nothing and raises nothing.
--
-- FOR ROLE postgres only. Default privileges are per creating role, and
-- postgres is what the SQL editor and the dashboard create objects as. A
-- function created by another role carries that role's defaults; check 12b
-- lists every creating role so a second one is visible.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The change
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. Verification (read-only, changes nothing)
--
-- One jsonb cell. postgres_functions_default is the row as it now stands (null
-- if there is no row at all, which also means nothing beyond the built in
-- defaults). Both present flags should read true.
--
-- To see the behaviour for yourself, without leaving anything behind, run
-- this in a separate execution and read the two booleans before the rollback:
--
--   begin;
--   create function public.zzz_function_default_probe() returns int
--     language sql as 'select 1';
--   select proacl,
--          has_function_privilege('anon', 'public.zzz_function_default_probe()', 'execute')
--     from pg_proc where proname = 'zzz_function_default_probe';
--   rollback;
--
-- Expect the ACL to name neither anon nor authenticated, and the boolean to
-- read TRUE all the same: that is PUBLIC, as described above.
-- ---------------------------------------------------------------------------
with
d as (
  select d.defaclacl
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public'
     and d.defaclobjtype = 'f'
     and d.defaclrole = 'postgres'::regrole
),
rows as (
  select 'postgres default for new functions in public grants anon nothing' as object,
         not exists (select 1 from d where array_to_string(defaclacl, ',') ~ '(^|,)anon=') as present
  union all
  select 'postgres default for new functions in public grants authenticated nothing',
         not exists (select 1 from d where array_to_string(defaclacl, ',') ~ '(^|,)authenticated=')
)
select jsonb_pretty(jsonb_build_object(
  'default_function_privileges_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'postgres_functions_default', (select to_jsonb(defaclacl::text[]) from d),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present)) from rows)
  )
)) as default_function_privileges_verification;
