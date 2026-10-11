-- ===========================================================================
-- 2026-10-09  guest_jobs.assigned_courier_id, vouched Pioneer couriers, and
--             the Pioneer registry lookup
-- ===========================================================================
--
-- WHAT THIS IS
--
-- Phase 1 item 6, part (a), P13, as approved 9 Oct 2026
-- (docs/anchoring-phase1-notes.md, item 6, sections 6.1, 6.2, 6.6, 6.7 A and
-- the founder decisions in 6.10).
--
--   1. guest_jobs.assigned_courier_id uuid null, a foreign key to
--      courier_registry(id), with a partial index. Written only by the two
--      accept routes, in the same guarded UPDATE that claims the job:
--
--        claim by          assigned_courier         assigned_courier_id
--        legacy courier    null                     the courier id from
--                                                   resolveCourier
--        Pioneer courier   pi_username, as today    the registry id from
--                                                   courier_find_pioneer
--
--      No prefixed strings in assigned_courier (decision 2). Rows claimed
--      before item 6 keep a null assigned_courier_id; nothing backfills them.
--      No cascade: the registry has no delete path, and shredding is an
--      UPDATE, so the link survives a shred and points at a row that can no
--      longer be tied to anyone.
--
--   2. courier_registry.vouched_at timestamptz null (6.10 decision 2): the
--      founder vouched for this Pioneer courier without PiVerify. A vouched
--      courier is full FOR DISPATCH ONLY and is never presented as
--      KYC-verified. Anchoring and the trust bureau read kyc_approved_at only,
--      never vouched_at and never status = 'full' alone. Until a Pioneer
--      PiVerify path exists, vouched_at is the only route to full for a
--      Pioneer. A named check, courier_registry_vouched_pioneer_only_check,
--      holds vouched_at to Pioneer rows: a legacy courier reaches full only
--      through PiVerify. Additive: the applied
--      2026-10-08_courier_registry.sql (P2) is not edited.
--
--   3. courier_register_pioneer(p_pi_username), OWNER ONLY, the hand-run way
--      to register an existing or new Pioneer courier as full and vouched.
--
--   4. courier_find_pioneer(p_pi_username), service_role only, read only.
--      /api/guest/accept calls it after resolveCaller, with the pi_username
--      resolveCaller derived. A function and not a PostgREST filter because
--      PostgREST cannot filter on the lower() expression the unique index is
--      built on, and ilike reads _ as a wildcard: Pi usernames contain
--      underscores, so a_b would also match axb.
--
-- WHAT THIS FILE DOES NOT DO
--
-- It edits no applied migration and changes no applied function. The
-- delivery functions (guest_stamp_delivery, guest_bump_delivery_code_attempts,
-- guest_bump_last4_attempts) match on tracking_id and phone_verified only and
-- are called unchanged. It does not touch guest_jobs_dispatch: the view gains
-- the column in P14 (2026-10-09_dispatch_view_courier_id.sql). It writes no
-- row: registering couriers is the founder's hand step after this file.
--
-- NO GRANT ON THE NEW COLUMN, and none is needed. service_role holds the
-- table-wide grant on guest_jobs (2026-09-07_grant_baseline.sql section 5),
-- which covers a new column. anon, authenticated and gyema_reader hold
-- nothing on guest_jobs and get nothing here; section 5 reads their column
-- privileges. courier_registry's grants (service_role SELECT, INSERT, UPDATE)
-- already cover vouched_at.
--
-- NEW FUNCTIONS ARE EXECUTABLE THROUGH PUBLIC until revoked, whatever the
-- default privileges say (2026-10-08_default_function_privileges.sql and the
-- founder decision recorded there). Both functions are revoked in section 4,
-- or catalog check 12 grows a row.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Requires 2026-10-08_courier_registry.sql
-- (P2). Run the whole file top to bottom; its last statement is a read-only
-- verification returning one cell. all_present must read true.
--
-- ORDER. Apply on a project BEFORE the item 6 code deploys there. Every
-- accept names the column, and so does /api/guest/open, which gains the
-- both-null filter: against a project without the column the public job
-- board on the pinet host answers 500 for every Pioneer, not only accepts.
-- After this file and before the deploy, the founder registers each existing
-- Pioneer courier with courier_register_pioneer (6.7 A, the pre-flight is in
-- docs/deploy-order.md, P13). After the deploy a Pioneer with no row is
-- refused accept with courier_not_registered.
--
-- P2'S OWN VERIFICATION CELL reads false on a re-run after this file, on its
-- "no columns beyond the expected fifteen" row, exactly as it already does
-- after 2026-10-08_piverify_resubmission.sql (P9). That cell describes P2's
-- moment. Section 5 here and docs/catalog-checks.sql (check 9, check 14) are
-- the live truth.
--
-- IDEMPOTENT. The columns with add column if not exists, the foreign key
-- and the vouched check only if absent by name, the index with if not
-- exists, functions with
-- create or replace, and revokes and grants that are no-ops when already in
-- place. add column if not exists does nothing when a column of that name
-- already exists in another shape, so section 5 reports type, nullability
-- and default by name.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. guest_jobs.assigned_courier_id, its foreign key and its index
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the foreign key is guarded
-- on pg_constraint by name. Adding it validates every existing row, and every
-- existing row is null, which passes. No ON DELETE action: the default, NO
-- ACTION, is the point (see the header).
--
-- The index is partial, so the thousands of unassigned and Pioneer-claimed
-- rows that hold null cost nothing. It serves the legacy courier's mine query
-- (match on assigned_courier_id) and the foreign key's checks.
-- ---------------------------------------------------------------------------
alter table public.guest_jobs
  add column if not exists assigned_courier_id uuid null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.guest_jobs'::regclass
       and conname = 'guest_jobs_assigned_courier_id_fkey'
  ) then
    alter table public.guest_jobs
      add constraint guest_jobs_assigned_courier_id_fkey
      foreign key (assigned_courier_id) references public.courier_registry (id);
  end if;
end
$$;

create index if not exists guest_jobs_assigned_courier_id_idx
  on public.guest_jobs (assigned_courier_id)
  where assigned_courier_id is not null;

comment on column public.guest_jobs.assigned_courier_id is
  'The courier_registry row that claimed this job, legacy or Pioneer. Written only by the accept routes, in the claim UPDATE. Null on rows claimed before item 6. See db/migrations/2026-10-09_guest_jobs_courier_assignment.sql.';


-- ---------------------------------------------------------------------------
-- 2. courier_registry.vouched_at, and the check that only a Pioneer is vouched
--
-- courier_registry_vouched_pioneer_only_check (founder decision, 10 Oct
-- 2026): vouched_at is null, or the row is a Pioneer. A legacy courier
-- reaches full only through PiVerify, so a hand UPDATE must not be able to
-- vouch one. Guarded on pg_constraint by name, as the foreign key above.
-- Adding it validates every existing row, and every existing row holds a
-- null vouched_at, which passes.
--
-- No check ties vouched_at to status: the founder sets status by hand
-- (decision 7). Catalog check 14 reports a full row carrying neither
-- kyc_approved_at nor vouched_at.
-- ---------------------------------------------------------------------------
alter table public.courier_registry
  add column if not exists vouched_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.courier_registry'::regclass
       and conname = 'courier_registry_vouched_pioneer_only_check'
  ) then
    alter table public.courier_registry
      add constraint courier_registry_vouched_pioneer_only_check
      check (vouched_at is null or class = 'pioneer');
  end if;
end
$$;

comment on column public.courier_registry.vouched_at is
  'The founder vouched for this Pioneer courier without PiVerify (item 6, decision A). Full for dispatch only: never presented as KYC-verified. Anchoring and the trust bureau read kyc_approved_at only.';


-- ---------------------------------------------------------------------------
-- 3. Functions
--
-- Both security definer with search_path pinned to public, pg_temp.
-- gen_random_uuid, sha256 and lower are core (pg_catalog), so nothing here
-- depends on the extensions schema.
-- ---------------------------------------------------------------------------

-- 3a. courier_register_pioneer
--
-- IDENTITY WRITE: founder review required.
--
-- Owner only, like courier_register_legacy (decision 3): the app's
-- service_role key cannot register a courier. Inserts one Pioneer courier
-- row: class pioneer, status full, vouched_at now(), the username exactly as
-- given, and a 32-byte salt from core Postgres (decision 2): sha256 of two v4
-- UUIDs. kyc_approved_at stays null: vouching is not KYC.
--
-- Refuses a null, empty or untrimmed username, before the insert, with
-- 22023. The registry's own trimmed check would refuse an untrimmed one too,
-- with a less useful message. A username already registered in any case is
-- refused by courier_registry_pi_username_lower_key with 23505. Pass the
-- username exactly as Pi returns it and the 6.6 pre-flight shows it,
-- bracketed.
create or replace function public.courier_register_pioneer(p_pi_username text)
returns table (courier_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_pi_username is null or p_pi_username = '' or p_pi_username <> btrim(p_pi_username) then
    raise exception 'courier_register_pioneer: pi_username must be non-empty and trimmed'
      using errcode = '22023';
  end if;

  return query
  insert into public.courier_registry (class, status, pi_username, vouched_at, commitment_salt)
  values ('pioneer', 'full', p_pi_username, now(),
          sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())))
  returning courier_registry.id;
end;
$$;

-- 3b. courier_find_pioneer
--
-- Read only. service_role only. Returns the one unshredded Pioneer row whose
-- lower(pi_username) equals lower(p_pi_username), or no row. The caller
-- treats a raised error as auth_unavailable (503) and never as "no row".
--
-- pi_username is not null is stated in the WHERE so the planner can prove the
-- partial unique index courier_registry_pi_username_lower_key applies; it
-- does not reliably infer that predicate from the lower() comparison alone.
-- class and shredded_at are stated too, although a legacy or shredded row
-- holds no username, so the function does not lean on that.
create or replace function public.courier_find_pioneer(p_pi_username text)
returns table (
  id               uuid,
  status           text,
  buffer_since     timestamptz,
  paused_reason    text,
  kyc_approved_at  timestamptz,
  vouched_at       timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.status, r.buffer_since, r.paused_reason, r.kyc_approved_at, r.vouched_at
    from public.courier_registry r
   where r.pi_username is not null
     and lower(r.pi_username) = lower(p_pi_username)
     and r.class = 'pioneer'
     and r.shredded_at is null;
$$;


-- ---------------------------------------------------------------------------
-- 4. Privileges (CLAUDE.md invariant 2, decision 3)
--
-- courier_register_pioneer: owner only, revoked from everyone, service_role
-- included, granted to no role. The owner keeps EXECUTE through ownership.
--
-- courier_find_pioneer: service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.courier_register_pioneer(text)
  from public, anon, authenticated, service_role;

revoke all on function public.courier_find_pioneer(text)
  from public, anon, authenticated;
grant execute on function public.courier_find_pioneer(text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- Anything false is a finding: stop and paste it back before going further.
-- Function grants are read from pg_proc.proacl, with a null ACL read as the
-- built in default, so a function nobody revoked shows PUBLIC rather than
-- nothing. The column privilege rows read has_column_privilege, which counts
-- grants through PUBLIC and role membership as well as direct ones; a role
-- missing on a project reads present: false, so the cell names it rather than
-- erroring.
-- ---------------------------------------------------------------------------
with
col as (
  select a.attrelid::regclass::text as tbl, a.attname as name,
         format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as nullable,
         pg_get_expr(d.adbin, d.adrelid) as default_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where ((a.attrelid = 'public.guest_jobs'::regclass and a.attname = 'assigned_courier_id')
       or (a.attrelid = 'public.courier_registry'::regclass and a.attname = 'vouched_at'))
     and not a.attisdropped
),
fk as (
  select k.convalidated, k.confrelid, k.confdeltype, k.confupdtype, pg_get_constraintdef(k.oid) as def
    from pg_constraint k
   where k.conrelid = 'public.guest_jobs'::regclass
     and k.conname = 'guest_jobs_assigned_courier_id_fkey'
     and k.contype = 'f'
),
idx as (
  select i.indexdef
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'guest_jobs'
     and i.indexname = 'guest_jobs_assigned_courier_id_idx'
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
              when not exists (select 1 from col where name = 'assigned_courier_id') then null
              else has_column_privilege(r.rolname, 'public.guest_jobs', 'assigned_courier_id', p.privilege)
         end as has_privilege
    from roles r cross join privs p
),
-- kind: owner (no grantee at all) or service (service_role alone).
expected_functions(name, args, kind) as (
  values ('courier_register_pioneer', 'p_pi_username text', 'owner'),
         ('courier_find_pioneer', 'p_pi_username text', 'service')
),
fn as (
  select e.name, e.args, e.kind, p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner
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
rows as (
  select 'column guest_jobs.assigned_courier_id' as object,
         exists (select 1 from col where name = 'assigned_courier_id') as present,
         (select data_type from col where name = 'assigned_courier_id') as detail
  union all
  select 'assigned_courier_id is uuid, nullable, with no default',
         coalesce((select data_type = 'uuid' and nullable and default_expr is null
                     from col where name = 'assigned_courier_id'), false),
         null
  union all
  select 'constraint guest_jobs_assigned_courier_id_fkey, validated',
         coalesce((select convalidated from fk), false),
         (select def from fk)
  union all
  select 'guest_jobs_assigned_courier_id_fkey references courier_registry(id), no action on delete or update',
         coalesce((select confrelid = 'public.courier_registry'::regclass
                          and def ~ 'FOREIGN KEY \(assigned_courier_id\) REFERENCES (public\.)?courier_registry\(id\)'
                          and confdeltype = 'a' and confupdtype = 'a'
                     from fk), false),
         null
  union all
  select 'exactly one foreign key on guest_jobs names assigned_courier_id',
         (select count(*) from pg_constraint k
           where k.conrelid = 'public.guest_jobs'::regclass and k.contype = 'f'
             and pg_get_constraintdef(k.oid) ~ 'assigned_courier_id') = 1,
         null
  union all
  select 'index guest_jobs_assigned_courier_id_idx, partial on not null',
         coalesce((select indexdef ~ '\(assigned_courier_id\)'
                          and indexdef ~ 'WHERE \(assigned_courier_id IS NOT NULL\)'
                     from idx), false),
         (select indexdef from idx)
  union all
  select 'anon holds no privilege on assigned_courier_id',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'anon'), false),
         null
  union all
  select 'authenticated holds no privilege on assigned_courier_id',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'authenticated'), false),
         null
  union all
  select 'gyema_reader holds no privilege on assigned_courier_id',
         coalesce((select bool_and(has_privilege = false) from role_column_privs where rolname = 'gyema_reader'), false),
         null
  union all
  select 'service_role can SELECT, INSERT and UPDATE assigned_courier_id',
         coalesce((select bool_and(has_privilege) from role_column_privs
                    where rolname = 'service_role' and privilege in ('SELECT', 'INSERT', 'UPDATE')), false),
         null
  union all
  select 'column courier_registry.vouched_at',
         exists (select 1 from col where name = 'vouched_at'),
         (select data_type from col where name = 'vouched_at')
  union all
  select 'vouched_at is timestamptz, nullable, with no default',
         coalesce((select data_type = 'timestamp with time zone' and nullable and default_expr is null
                     from col where name = 'vouched_at'), false),
         null
  union all
  select 'constraint courier_registry_vouched_pioneer_only_check, validated, vouched_at null or class pioneer',
         coalesce((select k.convalidated
                          and pg_get_constraintdef(k.oid) ~ 'vouched_at IS NULL'
                          and pg_get_constraintdef(k.oid) ~ 'class = ''pioneer''::text'
                     from pg_constraint k
                    where k.conrelid = 'public.courier_registry'::regclass
                      and k.conname = 'courier_registry_vouched_pioneer_only_check'
                      and k.contype = 'c'), false),
         (select pg_get_constraintdef(k.oid) from pg_constraint k
           where k.conrelid = 'public.courier_registry'::regclass
             and k.conname = 'courier_registry_vouched_pioneer_only_check')
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
  select 'courier_find_pioneer is stable, not volatile',
         coalesce((select provolatile = 's' from fn where name = 'courier_find_pioneer'), false),
         null
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
)
select jsonb_pretty(jsonb_build_object(
  'guest_jobs_courier_assignment_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as guest_jobs_courier_assignment_verification;
