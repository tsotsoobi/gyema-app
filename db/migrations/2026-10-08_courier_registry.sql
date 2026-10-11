-- ===========================================================================
-- 2026-10-08  courier_registry: one row per courier, Pioneer or legacy
-- ===========================================================================
--
-- WHAT THIS IS
--
-- The courier registry the anchoring work stands on (docs/anchoring-spec.md,
-- docs/anchoring-decisions.md answers 1, 2, 5, 7, 12 and 13). Today there is
-- no registry: a guest job stores the courier's pi_username in
-- guest_jobs.assigned_courier, a listing stores the matched party's pi_uid,
-- and two tables named couriers and legacy_couriers exist in the databases
-- with nothing in this repository reading or writing them.
--
-- One table for both classes of courier:
--
--   pioneer  has a Pi account. Linked by pi_username, the identity anchor
--            (CLAUDE.md invariant 7), never by pi_uid, which rotates.
--   legacy   no Pi account (Bolt, Yango, Uber couriers). No Pi identity of any
--            kind on the row. Signs in with an operator-issued code (Phase 1
--            item 5).
--
-- and the PiVerify status ladder (decision notes, decision 1):
--
--   registered  created; no jobs
--   buffer      KYC pending review; limited guest jobs
--   full        KYC approved
--   paused      rejected, failed, pending 30+ days, or paused by the operator
--
-- WHAT THIS FILE DOES NOT DO
--
-- No function, no trigger, no policy, no change to any existing table.
-- Nothing in the app reads or writes this table until later Phase 1 items
-- (the PiVerify webhook, courier sign-in, accept). It is safe to apply ahead
-- of the code that uses it.
--
-- It does not touch couriers or legacy_couriers. Those are read first with
-- docs/orphan-courier-tables.sql and dropped by a separate migration, on the
-- founder's go-ahead, after the PiVerify webhook stops pointing at
-- legacy_couriers (decision 4).
--
-- NOTHING PERSONAL IS STORED HERE beyond pi_username for Pioneers, which the
-- app already holds on every guest job a Pioneer accepts. No phone, name,
-- Ghana Card number or pi_uid. PiVerify keeps the documents; this row keeps
-- only the session id and its status. auth_user_id is the Supabase Auth user
-- the courier signs in as: an internal id, not a personal detail.
--
-- commitment_salt is 32 random bytes the app supplies at insert. The courier's
-- on-chain commitment is SHA-256(commitment_salt || id as 16 raw bytes).
-- Shredding a courier (Phase 1 item 9, courier_shred) nulls the salt, the Pi
-- link and the auth link and sets shredded_at; the row stays so history keeps
-- its shape, but nothing on chain can be tied back to anyone. There is no column default for the salt on
-- purpose: it would need pgcrypto, and a hand insert without a salt should
-- fail loudly rather than receive one.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Run the whole file top to bottom.
--
-- IDEMPOTENT. Every object is created with if not exists, every grant and
-- revoke is a no-op when already in place, and section 4 is a read-only
-- SELECT. One caveat, and section 4 is the answer to it: create table if not
-- exists does nothing at all when a table of this name already exists, even
-- one of a different shape, and Postgres has no add constraint if not exists.
-- So every constraint and index has a name, and section 4 reports each one by
-- name with a present flag. A re-run over a half-landed or differently shaped
-- table is visible there, never hidden behind a Success banner (invariant 8).
--
-- The last statement in the file is that verification, so running the whole
-- file returns it as the editor's one result cell. Paste it back.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The table
--
-- Hard checks for the enumerations and for the class rule. Timing rules
-- (a full courier carries kyc_approved_at, a buffer courier carries
-- buffer_since) are deliberately NOT checks: the operator sets status by hand
-- for the 30-day pause (decision 7), and a check that blocks a hand fix is
-- friction with no safety in it. Section 4 and catalog check 14 report those
-- rules instead.
-- ---------------------------------------------------------------------------
create table if not exists public.courier_registry (
  id                   uuid        not null default gen_random_uuid(),
  class                text        not null,
  status               text        not null default 'registered',
  commitment_salt      bytea       null,
  pi_username          text        null,
  auth_user_id         uuid        null,
  piverify_session_id  text        null,
  piverify_status      text        null,
  piverify_status_at   timestamptz null,
  buffer_since         timestamptz null,
  kyc_approved_at      timestamptz null,
  paused_reason        text        null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  shredded_at          timestamptz null,

  constraint courier_registry_pkey
    primary key (id),

  constraint courier_registry_class_check
    check (class in ('pioneer', 'legacy')),

  constraint courier_registry_status_check
    check (status in ('registered', 'buffer', 'full', 'paused')),

  -- PiVerify's six session statuses, as lib/piverify.ts in ed98f9f types them.
  constraint courier_registry_piverify_status_check
    check (piverify_status is null
           or piverify_status in ('created', 'started', 'pending_review',
                                  'approved', 'rejected', 'failed')),

  constraint courier_registry_paused_reason_check
    check (paused_reason is null
           or paused_reason in ('rejected', 'failed', 'pending_timeout', 'operator')),

  -- Exactly 32 bytes while it exists.
  constraint courier_registry_salt_length_check
    check (commitment_salt is null or octet_length(commitment_salt) = 32),

  -- A salt is mandatory until the row is shredded.
  constraint courier_registry_salt_until_shredded_check
    check (shredded_at is not null or commitment_salt is not null),

  -- A legacy courier carries no Pi identity, ever.
  constraint courier_registry_legacy_no_username_check
    check (class <> 'legacy' or pi_username is null),

  -- A Pioneer courier carries a pi_username until shredded.
  constraint courier_registry_pioneer_username_check
    check (class <> 'pioneer' or shredded_at is not null or pi_username is not null),

  -- Stored trimmed and non-empty, so an exact match is the only match there
  -- is. CLAUDE.md records what untrimmed free text cost on guest_jobs.
  constraint courier_registry_pi_username_trimmed_check
    check (pi_username is null or (pi_username = btrim(pi_username) and pi_username <> '')),

  -- The Supabase Auth user this courier signs in as. Set null, never cascaded,
  -- if that user is deleted: the courier row and its history stay.
  constraint courier_registry_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users (id) on delete set null
);

comment on table public.courier_registry is
  'One row per courier, Pioneer or legacy, with the PiVerify status ladder and the salt behind the on-chain commitment. service_role only. See db/migrations/2026-10-08_courier_registry.sql.';
comment on column public.courier_registry.commitment_salt is
  '32 random bytes, supplied by the app at insert. Commitment = SHA-256(salt || id as 16 raw bytes). Nulled by shredding, which makes on-chain history unlinkable.';
comment on column public.courier_registry.pi_username is
  'Pioneer link (CLAUDE.md invariant 7). Null for legacy couriers, and for shredded rows.';
comment on column public.courier_registry.auth_user_id is
  'The Supabase Auth user this courier signs in as. One courier per auth user. Nulled by shredding; set null if the auth user is deleted.';
comment on column public.courier_registry.buffer_since is
  'Start of the 30-day buffer clock. The pause is computed on read; the stored status is changed by hand (decision 7).';


-- ---------------------------------------------------------------------------
-- 2. Indexes
--
-- One courier row per Pioneer, whatever the case of the username: the index
-- is on lower(pi_username), so 'Ama' and 'ama' cannot both hold a row. The
-- value itself is stored as Pi returned it. Partial, so any number of legacy
-- and shredded rows can carry null. No foreign key to pioneers (decision
-- answer 5): pioneers.pi_username is not unique yet
-- (lib/supabase-admin.ts:207-208).
--
-- One courier per PiVerify session, so a webhook's session id resolves to at
-- most one row.
--
-- One courier per Supabase Auth user, so a session resolves to at most one
-- courier.
-- ---------------------------------------------------------------------------
create unique index if not exists courier_registry_pi_username_lower_key
  on public.courier_registry (lower(pi_username))
  where pi_username is not null;

create unique index if not exists courier_registry_piverify_session_key
  on public.courier_registry (piverify_session_id)
  where piverify_session_id is not null;

create unique index if not exists courier_registry_auth_user_key
  on public.courier_registry (auth_user_id)
  where auth_user_id is not null;


-- ---------------------------------------------------------------------------
-- 3. Lock it to service_role (CLAUDE.md invariant 2)
--
-- RLS on, with no policy at all, so a role that somehow held a grant would
-- still read nothing. The grant baseline's default privileges already start a
-- new table with nothing for anon and authenticated; the revoke is stated
-- anyway, so this file does not depend on that having run.
--
-- service_role gets SELECT, INSERT and UPDATE and nothing else. Shredding is
-- an UPDATE. There is no DELETE path: removing a row would remove the history
-- the anchoring work exists to keep, and if one is ever needed it is a hand
-- operation as the table owner.
--
-- gyema_reader gets nothing here. The dispatch reader's overdue-buffer list
-- (decision 7) will read through a masked view in a later item, the same way
-- it reads guest_jobs and listings today.
-- ---------------------------------------------------------------------------
alter table public.courier_registry enable row level security;

revoke all on table public.courier_registry from public, anon, authenticated;
revoke all on table public.courier_registry from service_role;
grant select, insert, update on table public.courier_registry to service_role;


-- ---------------------------------------------------------------------------
-- 4. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row should read present true. Anything false is a
-- finding: stop and paste it back before going further. The grants are read
-- from pg_class.relacl, where no role membership filtering applies, the same
-- source catalog check 3b trusts.
-- ---------------------------------------------------------------------------
with
t as (
  select c.oid, c.relrowsecurity, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'courier_registry' and c.relkind = 'r'
),
acl as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from t
    cross join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
   where a.grantee <> t.relowner
),
expected_columns(name, data_type, nullable) as (
  values ('id', 'uuid', false), ('class', 'text', false), ('status', 'text', false),
         ('commitment_salt', 'bytea', true), ('pi_username', 'text', true),
         ('auth_user_id', 'uuid', true),
         ('piverify_session_id', 'text', true), ('piverify_status', 'text', true),
         ('piverify_status_at', 'timestamp with time zone', true),
         ('buffer_since', 'timestamp with time zone', true),
         ('kyc_approved_at', 'timestamp with time zone', true),
         ('paused_reason', 'text', true),
         ('created_at', 'timestamp with time zone', false),
         ('updated_at', 'timestamp with time zone', false),
         ('shredded_at', 'timestamp with time zone', true)
),
expected_constraints(name) as (
  values ('courier_registry_pkey'), ('courier_registry_class_check'),
         ('courier_registry_status_check'), ('courier_registry_piverify_status_check'),
         ('courier_registry_paused_reason_check'), ('courier_registry_salt_length_check'),
         ('courier_registry_salt_until_shredded_check'),
         ('courier_registry_legacy_no_username_check'),
         ('courier_registry_pioneer_username_check'),
         ('courier_registry_pi_username_trimmed_check'),
         ('courier_registry_auth_user_id_fkey')
),
expected_indexes(name) as (
  values ('courier_registry_pi_username_lower_key'), ('courier_registry_piverify_session_key'),
         ('courier_registry_auth_user_key')
),
rows as (
  select 'table public.courier_registry' as object, exists (select 1 from t) as present, null::text as detail
  union all
  select 'row level security enabled', coalesce((select relrowsecurity from t), false), null
  union all
  select 'no policies (none expected)',
         not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'courier_registry'),
         null
  union all
  select 'column ' || e.name,
         exists (select 1 from information_schema.columns col
                  where col.table_schema = 'public' and col.table_name = 'courier_registry'
                    and col.column_name = e.name and col.data_type = e.data_type
                    and (col.is_nullable = 'YES') = e.nullable),
         e.data_type || case when e.nullable then ' null' else ' not null' end
    from expected_columns e
  union all
  select 'no columns beyond the expected fifteen',
         not exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = 'courier_registry'
                        and col.column_name not in (select name from expected_columns)),
         null
  union all
  select 'constraint ' || e.name,
         exists (select 1 from pg_constraint k where k.conrelid = (select oid from t) and k.conname = e.name),
         (select pg_get_constraintdef(k.oid) from pg_constraint k
           where k.conrelid = (select oid from t) and k.conname = e.name)
    from expected_constraints e
  union all
  select 'index ' || e.name,
         exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.indexname = e.name),
         (select i.indexdef from pg_indexes i where i.schemaname = 'public' and i.indexname = e.name)
    from expected_indexes e
  union all
  select 'anon, authenticated, PUBLIC and gyema_reader hold nothing',
         not exists (select 1 from acl where grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader')),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
            from acl where grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader'))
  union all
  select 'service_role holds exactly INSERT, SELECT, UPDATE',
         coalesce((select array_agg(privilege_type order by privilege_type) from acl where grantee = 'service_role')
                  = array['INSERT', 'SELECT', 'UPDATE']::text[], false),
         (select string_agg(privilege_type, ', ' order by privilege_type) from acl where grantee = 'service_role')
)
select jsonb_pretty(jsonb_build_object(
  'courier_registry_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as courier_registry_verification;
