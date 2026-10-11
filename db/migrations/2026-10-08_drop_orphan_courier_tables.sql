-- ===========================================================================
-- 2026-10-08  Drop the orphan courier tables: couriers, legacy_couriers
-- ===========================================================================
--
-- WHAT THIS IS
--
-- Two tables that nothing in this repository has ever read or written
-- (docs/catalog-checks.sql, check 13 until this file; Phase 0 claim 5). The
-- courier registry replaces both (2026-10-08_courier_registry.sql), and the
-- PiVerify webhook no longer points at legacy_couriers
-- (2026-10-08_piverify_webhook.sql). Decision 4 in docs/anchoring-decisions.md:
-- read, then drop.
--
-- WHAT WAS IN THEM, recorded by the founder before this file was written:
-- legacy_couriers, present on one network only, held one row, the founder's
-- own July test. Run docs/orphan-courier-tables.sql on each network before
-- applying this file and keep its output: after this file there is nothing
-- left to read.
--
-- NO CASCADE, deliberately. If a view, a foreign key or anything else still
-- depends on either table, the drop fails with an error naming it, and nothing
-- is dropped. Section 1 lists such dependencies first so a failure is not a
-- surprise. Read it, and stop if it returns any row.
--
-- IRREVERSIBLE. A dropped table and its rows are gone; there is no rollback
-- section, because there is nothing to restore it from but the founder's own
-- record from the orphan read.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run section 1 on its own first. Then run
-- the whole file; its last statement is a read-only verification.
--
-- IDEMPOTENT. drop table if exists: on a network that never had
-- legacy_couriers, or on a second run, it does nothing and raises a notice.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Pre-flight (read-only, changes nothing). Run this on its own first.
--
-- Every object that depends on either table, through pg_depend: views, rules,
-- foreign keys from other tables, and so on. Expect ZERO rows. Any row means
-- the drop in section 2 will fail; stop and read it.
--
--   select d.classid::regclass as catalog,
--          coalesce(dc.relname, con.conname, d.objid::text) as dependent,
--          d.refobjid::regclass as depends_on,
--          d.deptype
--     from pg_depend d
--     left join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and rw.oid = d.objid
--     left join pg_class dc on dc.oid = rw.ev_class
--     left join pg_constraint con on d.classid = 'pg_constraint'::regclass and con.oid = d.objid
--    where d.refobjid in (select oid from pg_class
--                          where relnamespace = 'public'::regnamespace
--                            and relname in ('couriers', 'legacy_couriers'))
--      and d.deptype = 'n'
--      and coalesce(dc.oid, con.conrelid, 0) not in
--          (select oid from pg_class
--            where relnamespace = 'public'::regnamespace
--              and relname in ('couriers', 'legacy_couriers'));
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 2. The drop
-- ---------------------------------------------------------------------------
drop table if exists public.couriers;
drop table if exists public.legacy_couriers;


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Both rows should read present true. courier_registry is
-- reported too, as the table that replaces them.
-- ---------------------------------------------------------------------------
with
rows as (
  select 'public.couriers is gone' as object, to_regclass('public.couriers') is null as present
  union all
  select 'public.legacy_couriers is gone', to_regclass('public.legacy_couriers') is null
)
select jsonb_pretty(jsonb_build_object(
  'drop_orphan_courier_tables_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'courier_registry_exists', to_regclass('public.courier_registry') is not null,
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present)) from rows)
  )
)) as drop_orphan_courier_tables_verification;
