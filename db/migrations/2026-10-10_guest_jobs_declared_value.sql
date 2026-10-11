-- ===========================================================================
-- 2026-10-10  guest_jobs.declared_value_cedis
-- ===========================================================================
--
-- Anchoring Phase 1, item 7 (docs/anchoring-phase1-notes.md). Founder decision
-- 6 (docs/anchoring-decisions.md): a declared value is required on every new
-- guest job, refused above GHS 500 during the pilot (the Trancova pilot
-- liability cap), used server side only, shown to the sender and the operator,
-- and NEVER shown to any courier: a visible parcel value is a theft incentive.
--
-- WHAT THIS ADDS
--
--   1. guest_jobs.declared_value_cedis integer null. Whole cedis, 0 allowed
--      (founder decision, item 7, 10 October 2026).
--   2. guest_jobs_declared_value_cedis_check: null, or 0 to 500 inclusive. The
--      same bound is held by GuestCreateBody (lib/declared-value.ts), so
--      raising the pilot cap is a reviewed code change plus a reviewed
--      migration, and a hand edit or a code bug cannot store a value above it.
--
-- WHY NULLABLE
--
-- Every row posted before this column exists holds null, and stays eligible
-- for full-tier couriers only, for good (item 6, 6.7 B). NOT NULL would refuse
-- the add. A NOT VALID not-null check is not used either: Postgres checks it
-- on every later UPDATE of an old row, so the operator's hand status writes on
-- those rows (F14) would start failing. "Required" is the create route's rule
-- for new rows; catalog check 16 counts any null row posted after the first
-- row that carries a value.
--
-- NO GRANT, and none is needed. service_role holds the table-wide grant on
-- guest_jobs (2026-09-07_grant_baseline.sql section 5), which covers a new
-- column. anon, authenticated and gyema_reader hold nothing on guest_jobs and
-- get nothing here; the verification below reads their column privileges.
-- guest_jobs_dispatch is not changed by this file: the view gains the column
-- in P14 (item 6), after assigned_courier_id.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run the whole file; its last statement is
-- a read-only verification returning one cell. all_present must read true.
--
-- ORDER. Apply on a project BEFORE the item 7 code deploys there. The create
-- route names the column on every insert, so against a project without it
-- every guest post answers 500.
--
-- SAFE TO RE-RUN. The column is added only if absent and the check only if
-- absent by name. A second run changes nothing.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.guest_jobs
  add column if not exists declared_value_cedis integer null;


-- ---------------------------------------------------------------------------
-- 2. The named check, added only if absent
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so this is guarded on
-- pg_constraint by name. Adding it validates every existing row, and every
-- existing row is null, which passes.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.guest_jobs'::regclass
       and conname = 'guest_jobs_declared_value_cedis_check'
  ) then
    alter table public.guest_jobs
      add constraint guest_jobs_declared_value_cedis_check
      check (declared_value_cedis is null or declared_value_cedis between 0 and 500);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- The privilege rows read has_column_privilege, which counts grants through
-- PUBLIC and role membership as well as direct ones. A role missing on a
-- project reads present: false, so the cell names it rather than erroring.
-- ---------------------------------------------------------------------------
with
col as (
  select a.attnum, format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as nullable,
         pg_get_expr(d.adbin, d.adrelid) as default_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.guest_jobs'::regclass
     and a.attname = 'declared_value_cedis'
     and not a.attisdropped
),
chk as (
  select c.convalidated, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
   where c.conrelid = 'public.guest_jobs'::regclass
     and c.conname = 'guest_jobs_declared_value_cedis_check'
     and c.contype = 'c'
),
roles(rolname) as (
  values ('anon'), ('authenticated'), ('gyema_reader'), ('service_role')
),
privs(privilege) as (
  values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
),
role_column_privs as (
  select r.rolname, p.privilege,
         case when not exists (select 1 from pg_roles x where x.rolname = r.rolname) then null
              when not exists (select 1 from col) then null
              else has_column_privilege(r.rolname, 'public.guest_jobs', 'declared_value_cedis', p.privilege)
         end as has_privilege
    from roles r cross join privs p
),
rows as (
  select 'column guest_jobs.declared_value_cedis' as object,
         exists (select 1 from col) as present
  union all
  select 'declared_value_cedis is integer',
         coalesce((select data_type = 'integer' from col), false)
  union all
  select 'declared_value_cedis is nullable, with no default',
         coalesce((select nullable and default_expr is null from col), false)
  union all
  select 'constraint guest_jobs_declared_value_cedis_check, validated',
         coalesce((select convalidated from chk), false)
  union all
  select 'guest_jobs_declared_value_cedis_check bounds the value to 0 to 500, null allowed',
         coalesce((select def ~ 'declared_value_cedis IS NULL'
                          and def ~ '>= 0'
                          and def ~ '<= 500'
                     from chk), false)
  union all
  select 'exactly one check constraint on guest_jobs names declared_value_cedis',
         (select count(*) from pg_constraint c
           where c.conrelid = 'public.guest_jobs'::regclass and c.contype = 'c'
             and pg_get_constraintdef(c.oid) ~ 'declared_value_cedis') = 1
  union all
  select 'anon holds no privilege on declared_value_cedis',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'anon'), false)
  union all
  select 'authenticated holds no privilege on declared_value_cedis',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'authenticated'), false)
  union all
  select 'gyema_reader holds no privilege on declared_value_cedis',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'gyema_reader'), false)
  union all
  select 'service_role can SELECT, INSERT and UPDATE declared_value_cedis',
         coalesce((select bool_and(has_privilege) from role_column_privs
                    where rolname = 'service_role' and privilege in ('SELECT', 'INSERT', 'UPDATE')), false)
  union all
  select 'no row holds a declared value outside 0 to 500',
         not exists (select 1 from public.guest_jobs
                      where declared_value_cedis is not null
                        and (declared_value_cedis < 0 or declared_value_cedis > 500))
)
select jsonb_pretty(jsonb_build_object(
  'guest_jobs_declared_value_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'check_definition', (select def from chk),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present)) from rows)
  )
)) as guest_jobs_declared_value_verification;
