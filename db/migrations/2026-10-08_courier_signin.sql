-- ===========================================================================
-- 2026-10-08  courier sign-in: operator-issued codes and opaque sessions
-- ===========================================================================
--
-- WHAT THIS IS
--
-- Phase 1 item 5, part (a), as approved 8 Oct 2026
-- (docs/anchoring-phase1-notes.md, item 5, sections 5.0 to 5.2 and 5.5).
--
-- A legacy courier (no Pi account) signs in on the courier host with a
-- one-time code the founder issues by hand while on WhatsApp with them. The
-- code buys an opaque server-side session, carried in a host-only HttpOnly
-- cookie. A legacy courier never holds a Supabase Auth user or JWT, so
-- courier_registry.auth_user_id is not written by anything here (decision 1).
--
--   courier_signin_codes  one row per issued code, stored as a hash
--   courier_sessions      one row per sign-in, stored as a hash of the token
--
-- NOTHING PERSONAL IS STORED HERE. No IP, no user agent, no phone, no name.
-- Hashes, ids and times only. The plaintext code exists once, in the result
-- grid of the SQL editor that issued it. The plaintext session token exists
-- only in the courier's cookie; the database holds sha256 of it.
--
-- THE SIX FUNCTIONS
--
-- Owner only (decision 3). EXECUTE is revoked from public, anon,
-- authenticated AND service_role, and granted to nobody. The SQL editor runs
-- as postgres, the owner, so the founder can call them; the app's
-- service_role key cannot.
--
--   courier_register_legacy()               creates a legacy registry row
--   courier_issue_signin_code(courier_id)   issues one 15-minute code
--   courier_revoke_sessions(courier_id)     the "stop this courier now" control
--
-- service_role only. EXECUTE revoked from public, anon and authenticated,
-- granted to service_role. Called by the courier routes (item 5 part (b)).
--
--   courier_redeem_signin_code(code_hash, token_hash)   sign-in
--   courier_session_resolve(token_hash)                 every courier request
--   courier_end_session(token_hash)                     sign-out
--
-- Every one of the six writes, and every one is marked
-- IDENTITY WRITE: founder review required.
--
-- THE CODE
--
-- 10 characters of Crockford base32, shown as XXXXX-XXXXX, 50 bits, alive
-- for 15 minutes, single use, at most one live per courier. The alphabet is
-- the literal 0123456789ABCDEFGHJKMNPQRSTVWXYZ (no I, L, O or U).
--
-- What is stored is sha256 of the NORMALISED code, as UTF-8 text:
--
--   upper case; '-' and ' ' removed; O read as 0; I and L read as 1
--
-- written below as translate(upper(code), 'OIL- ', '011'). The route applies
-- the same normalisation to what the courier types and passes the hash to
-- courier_redeem_signin_code. On a generated code the normalisation only
-- removes the dash, which is the point: a mistyped O or I still matches.
-- No pepper (5.1): anyone who can read the hash already reads everything,
-- and the code dies in 15 minutes.
--
-- THE SESSION
--
-- One live session per courier (decision 5): a new sign-in revokes the old
-- device. 90 days absolute, 30 days idle (decision 6), both set and checked
-- here from now(), never from a time the route supplies. last_seen_at is
-- bumped at most once an hour. An expired or idle session is refused, not
-- revoked: revoked_reason records only a decision someone made (signout,
-- replaced, operator, shredded). courier_shred (item 9) will add the
-- shredded path; until then courier_session_resolve refuses a shredded
-- courier on its own.
--
-- REDEEM OUTCOMES, which the sign-in route branches on:
--
--   ok           signed in; courier_id and expires_at returned
--   no_match     unknown, already used or revoked code
--   expired      a real code past expires_at
--   unavailable  the courier is shredded, or not a legacy courier
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, the staging
-- project first and production only on an explicit go-ahead. Confirm the
-- project breadcrumb before pasting. Requires 2026-10-08_courier_registry.sql
-- (P2). Apply it BEFORE the item 5 code deploys: until these functions exist,
-- sign-in answers 500. Run the whole file top to bottom.
--
-- NEW FUNCTIONS ARE EXECUTABLE THROUGH PUBLIC until revoked, whatever the
-- default privileges say (2026-10-08_default_function_privileges.sql and the
-- founder decision recorded there). Every function here is revoked in this
-- file, in section 4, or catalog check 12 grows a row.
--
-- IDEMPOTENT. Tables and indexes with if not exists, functions with create
-- or replace, and revokes and grants that are no-ops when already in place.
-- create table if not exists does nothing when a table of the same name
-- already exists in another shape, so section 5 reports every column,
-- constraint and index by name. Section 5 is a read-only SELECT and the last
-- statement in the file: the editor's one result cell. Paste it back.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Tables
--
-- No column default for expires_at on either table: each is set by the one
-- function that inserts the row, from now(). RLS on with no policy, so a role
-- that somehow held a grant would still read nothing. service_role reads,
-- for support, and writes only through the functions.
-- ---------------------------------------------------------------------------
create table if not exists public.courier_signin_codes (
  id           uuid        not null default gen_random_uuid(),
  courier_id   uuid        not null,
  code_hash    bytea       not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz null,
  revoked_at   timestamptz null,

  constraint courier_signin_codes_pkey
    primary key (id),

  constraint courier_signin_codes_courier_id_fkey
    foreign key (courier_id) references public.courier_registry (id),

  constraint courier_signin_codes_code_hash_key
    unique (code_hash),

  constraint courier_signin_codes_code_hash_length_check
    check (octet_length(code_hash) = 32),

  -- A code ends one way: used or revoked, never both.
  constraint courier_signin_codes_consumed_or_revoked_check
    check (consumed_at is null or revoked_at is null)
);

create table if not exists public.courier_sessions (
  id              uuid        not null default gen_random_uuid(),
  courier_id      uuid        not null,
  code_id         uuid        not null,
  token_hash      bytea       not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz null,
  revoked_reason  text        null,

  constraint courier_sessions_pkey
    primary key (id),

  constraint courier_sessions_courier_id_fkey
    foreign key (courier_id) references public.courier_registry (id),

  -- Which code made this session.
  constraint courier_sessions_code_id_fkey
    foreign key (code_id) references public.courier_signin_codes (id),

  constraint courier_sessions_token_hash_key
    unique (token_hash),

  constraint courier_sessions_token_hash_length_check
    check (octet_length(token_hash) = 32),

  constraint courier_sessions_revoked_reason_check
    check (revoked_reason is null
           or revoked_reason in ('signout', 'replaced', 'operator', 'shredded')),

  -- Revoked with a reason, or neither.
  constraint courier_sessions_revoked_pair_check
    check ((revoked_at is null) = (revoked_reason is null))
);

comment on table public.courier_signin_codes is
  'Operator-issued courier sign-in codes, stored as sha256 of the normalised code. Hashes, ids and times only. service_role reads; written only by the courier sign-in functions. See db/migrations/2026-10-08_courier_signin.sql.';
comment on table public.courier_sessions is
  'Opaque courier sessions, stored as sha256 of the cookie token. Hashes, ids and times only. service_role reads; written only by the courier sign-in functions. See db/migrations/2026-10-08_courier_signin.sql.';
comment on column public.courier_signin_codes.code_hash is
  'sha256 of the code normalised as translate(upper(code), ''OIL- '', ''011''), UTF-8. The plaintext is never stored.';
comment on column public.courier_sessions.token_hash is
  'sha256 of the session token (gcs_ plus base64url of 32 random bytes). The token is never stored.';


-- ---------------------------------------------------------------------------
-- 2. Indexes
--
-- At most one live code per courier: unconsumed and unrevoked. The index
-- cannot reference now(), so a code past expires_at stays in it until the
-- next issue for that courier revokes it; redemption refuses it as expired
-- meanwhile. Catalog check 15 counts those, for information.
--
-- Sessions are looked up by token_hash (the unique constraint) and revoked by
-- courier_id, which this index serves. One live session per courier is kept
-- by courier_redeem_signin_code under the courier row lock, and catalog
-- check 15 counts couriers holding more than one unrevoked session.
-- ---------------------------------------------------------------------------
create unique index if not exists courier_signin_codes_one_live_per_courier
  on public.courier_signin_codes (courier_id)
  where consumed_at is null and revoked_at is null;

create index if not exists courier_sessions_courier_id_idx
  on public.courier_sessions (courier_id);


-- ---------------------------------------------------------------------------
-- 3. Lock both tables to service_role SELECT (CLAUDE.md invariant 2)
-- ---------------------------------------------------------------------------
alter table public.courier_signin_codes enable row level security;
alter table public.courier_sessions enable row level security;

revoke all on table public.courier_signin_codes from public, anon, authenticated;
revoke all on table public.courier_signin_codes from service_role;
grant select on table public.courier_signin_codes to service_role;

revoke all on table public.courier_sessions from public, anon, authenticated;
revoke all on table public.courier_sessions from service_role;
grant select on table public.courier_sessions to service_role;


-- ---------------------------------------------------------------------------
-- 4. Functions
--
-- All security definer with search_path pinned to public, pg_temp.
-- gen_random_uuid and sha256 are core (pg_catalog), so nothing here depends
-- on the extensions schema.
--
-- Lock order, the same in every function that takes both: the courier
-- registry row first, then its code or session rows. Two functions that took
-- them in opposite orders could deadlock each other.
-- ---------------------------------------------------------------------------

-- 4a. courier_register_legacy
--
-- IDENTITY WRITE: founder review required.
--
-- Owner only. Creates one legacy courier row: class legacy, status
-- registered, and a 32-byte salt from core Postgres (decision 2): sha256 of
-- two v4 UUIDs, 244 random bits from the strong random source, hashed to 32
-- bytes. The salt only hides a commitment; 244 bits is far past need.
create or replace function public.courier_register_legacy()
returns table (courier_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into public.courier_registry (class, status, commitment_salt)
  values ('legacy', 'registered',
          sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())))
  returning courier_registry.id;
end;
$$;

-- 4b. courier_issue_signin_code
--
-- IDENTITY WRITE: founder review required.
--
-- Owner only. Refuses an unknown, shredded or Pioneer courier (Pioneers sign
-- in with Pi). Revokes any live code for the courier first, so at most one is
-- live, then issues a new one for 15 minutes and returns it once.
--
-- The 10 characters come from one gen_random_uuid(). Of its 16 bytes, byte 6
-- carries the version and byte 8 the variant (0-based, as get_byte counts),
-- so both are skipped and the ten fully random bytes 0 to 5, 7, 9, 10 and 11
-- are used. Each is taken & 31, which is uniform because 256 is a multiple
-- of 32.
create or replace function public.courier_issue_signin_code(p_courier_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_alphabet  constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_courier   public.courier_registry%rowtype;
  v_bytes     bytea;
  v_raw       text := '';
  v_code      text;
  v_expires   timestamptz;
  v_i         integer;
begin
  select * into v_courier from public.courier_registry
   where id = p_courier_id
     for update;

  if v_courier.id is null then
    raise exception 'courier_issue_signin_code: no courier %', p_courier_id;
  end if;
  if v_courier.shredded_at is not null then
    raise exception 'courier_issue_signin_code: courier % is shredded', p_courier_id;
  end if;
  if v_courier.class <> 'legacy' then
    raise exception 'courier_issue_signin_code: courier % is a Pioneer; Pioneers sign in with Pi', p_courier_id;
  end if;

  update public.courier_signin_codes
     set revoked_at = now()
   where courier_signin_codes.courier_id = v_courier.id
     and consumed_at is null
     and revoked_at is null;

  v_bytes := uuid_send(gen_random_uuid());
  foreach v_i in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11] loop
    v_raw := v_raw || substr(c_alphabet, (get_byte(v_bytes, v_i) & 31) + 1, 1);
  end loop;
  v_code := substr(v_raw, 1, 5) || '-' || substr(v_raw, 6, 5);
  v_expires := now() + interval '15 minutes';

  insert into public.courier_signin_codes (courier_id, code_hash, expires_at)
  values (v_courier.id,
          sha256(convert_to(translate(upper(v_code), 'OIL- ', '011'), 'UTF8')),
          v_expires);

  return query select v_code, v_expires;
end;
$$;

-- 4c. courier_revoke_sessions
--
-- IDENTITY WRITE: founder review required.
--
-- Owner only. The founder's lost-phone and "stop this courier now" control.
-- Revokes every unrevoked session for the courier (reason operator) and
-- every live code, and says how many of each. An unknown id is refused
-- rather than answered with zeros, so a mistyped id is seen.
create or replace function public.courier_revoke_sessions(p_courier_id uuid)
returns table (sessions_revoked integer, codes_revoked integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id        uuid;
  v_sessions  integer;
  v_codes     integer;
begin
  select id into v_id from public.courier_registry
   where id = p_courier_id
     for update;

  if v_id is null then
    raise exception 'courier_revoke_sessions: no courier %', p_courier_id;
  end if;

  update public.courier_sessions
     set revoked_at = now(), revoked_reason = 'operator'
   where courier_sessions.courier_id = v_id
     and revoked_at is null;
  get diagnostics v_sessions = row_count;

  update public.courier_signin_codes
     set revoked_at = now()
   where courier_signin_codes.courier_id = v_id
     and consumed_at is null
     and revoked_at is null;
  get diagnostics v_codes = row_count;

  return query select v_sessions, v_codes;
end;
$$;

-- 4d. courier_redeem_signin_code
--
-- IDENTITY WRITE: founder review required.
--
-- service_role only. The sign-in route normalises and hashes the code the
-- courier typed, generates the session token, hashes it, and passes both
-- hashes. In one transaction, with the courier row and then the code row
-- locked:
--
--   1. unknown, used or revoked code: no_match. Past expires_at: expired,
--      and the code is left as it is.
--   2. a shredded or non-legacy courier: unavailable, and the code is left
--      as it is.
--   3. the code is marked consumed
--   4. every other unrevoked session for the courier is revoked (replaced):
--      one device at a time
--   5. the session is inserted, expiring 90 days from now()
--
-- The courier id comes from the code row, never from the request
-- (invariant 1). The code is looked up once without a lock to learn its
-- courier, then the courier row is locked and the code read again under its
-- own lock, which keeps the lock order of section 4.
create or replace function public.courier_redeem_signin_code(p_code_hash bytea, p_token_hash bytea)
returns table (outcome text, courier_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_courier_id  uuid;
  v_courier     public.courier_registry%rowtype;
  v_code        public.courier_signin_codes%rowtype;
  v_expires     timestamptz;
begin
  -- The route hashes both. Repeated here because this is the function that
  -- writes, and a malformed value must never reach a row.
  if p_code_hash is null or octet_length(p_code_hash) <> 32 then
    raise exception 'courier_redeem_signin_code: code hash must be 32 bytes';
  end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'courier_redeem_signin_code: token hash must be 32 bytes';
  end if;

  select c.courier_id into v_courier_id
    from public.courier_signin_codes c
   where c.code_hash = p_code_hash;

  if v_courier_id is null then
    return query select 'no_match'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select * into v_courier from public.courier_registry r
   where r.id = v_courier_id
     for update;

  select * into v_code from public.courier_signin_codes c
   where c.code_hash = p_code_hash
     for update;

  if v_code.id is null or v_code.consumed_at is not null or v_code.revoked_at is not null then
    return query select 'no_match'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if v_code.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if v_courier.shredded_at is not null or v_courier.class <> 'legacy' then
    return query select 'unavailable'::text, null::uuid, null::timestamptz;
    return;
  end if;

  update public.courier_signin_codes c
     set consumed_at = now()
   where c.id = v_code.id;

  update public.courier_sessions s
     set revoked_at = now(), revoked_reason = 'replaced'
   where s.courier_id = v_courier.id
     and s.revoked_at is null;

  v_expires := now() + interval '90 days';

  insert into public.courier_sessions (courier_id, code_id, token_hash, expires_at)
  values (v_courier.id, v_code.id, p_token_hash, v_expires);

  return query select 'ok'::text, v_courier.id, v_expires;
end;
$$;

-- 4e. courier_session_resolve
--
-- IDENTITY WRITE: founder review required (it bumps last_seen_at).
--
-- service_role only. Called by resolveCourier on every courier request with
-- sha256 of the cookie token. Returns the courier's row, or no row at all
-- for an unknown, revoked, expired (90 days) or idle (30 days) session, or a
-- shredded or non-legacy courier. bumps last_seen_at when an hour has passed,
-- so a normal request does not write.
create or replace function public.courier_session_resolve(p_token_hash bytea)
returns table (
  courier_id               uuid,
  status                   text,
  piverify_status          text,
  piverify_allowed_action  text,
  kyc_approved_at          timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id    uuid;
  v_last_seen_at  timestamptz;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    return;
  end if;

  select s.id, s.last_seen_at into v_session_id, v_last_seen_at
    from public.courier_sessions s
    join public.courier_registry r on r.id = s.courier_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and s.last_seen_at > now() - interval '30 days'
     and r.shredded_at is null
     and r.class = 'legacy';

  if v_session_id is null then
    return;
  end if;

  if v_last_seen_at < now() - interval '1 hour' then
    update public.courier_sessions s
       set last_seen_at = now()
     where s.id = v_session_id;
  end if;

  return query
  select r.id, r.status, r.piverify_status, r.piverify_allowed_action, r.kyc_approved_at
    from public.courier_sessions s
    join public.courier_registry r on r.id = s.courier_id
   where s.id = v_session_id;
end;
$$;

-- 4f. courier_end_session
--
-- IDENTITY WRITE: founder review required.
--
-- service_role only. Sign-out: revokes the caller's own session (reason
-- signout), found by the hash of the token in their cookie. ended is false
-- when there was no unrevoked session for that token, which the route
-- answers the same way: the cookie is cleared regardless.
create or replace function public.courier_end_session(p_token_hash bytea)
returns table (ended boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count  integer;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    return query select false;
    return;
  end if;

  update public.courier_sessions s
     set revoked_at = now(), revoked_reason = 'signout'
   where s.token_hash = p_token_hash
     and s.revoked_at is null;
  get diagnostics v_count = row_count;

  return query select v_count > 0;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4g. Privileges (CLAUDE.md invariant 2, decision 3)
--
-- Owner only: revoked from everyone, service_role included, granted to no
-- role. The owner keeps EXECUTE through ownership.
-- ---------------------------------------------------------------------------
revoke all on function public.courier_register_legacy()
  from public, anon, authenticated, service_role;
revoke all on function public.courier_issue_signin_code(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.courier_revoke_sessions(uuid)
  from public, anon, authenticated, service_role;

-- service_role only.
revoke all on function public.courier_redeem_signin_code(bytea, bytea)
  from public, anon, authenticated;
grant execute on function public.courier_redeem_signin_code(bytea, bytea)
  to service_role;
revoke all on function public.courier_session_resolve(bytea)
  from public, anon, authenticated;
grant execute on function public.courier_session_resolve(bytea)
  to service_role;
revoke all on function public.courier_end_session(bytea)
  from public, anon, authenticated;
grant execute on function public.courier_end_session(bytea)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row should read present true. Anything false is a
-- finding: stop and paste it back before going further. Table grants are
-- read from pg_class.relacl and function grants from pg_proc.proacl, with a
-- null ACL read as the built in default, so a function nobody revoked shows
-- PUBLIC rather than nothing.
--
-- The three owner-only rows read "service_role cannot execute" from two
-- sources, has_function_privilege and the ACL, and pass only when both say
-- service_role cannot.
-- ---------------------------------------------------------------------------
with
tbl as (
  select c.oid, c.relname, c.relrowsecurity, c.relacl, c.relowner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('courier_signin_codes', 'courier_sessions')
),
tacl as (
  select t.relname,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
    from tbl t
    cross join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
   where a.grantee <> t.relowner
),
expected_columns(tbl, name, data_type, nullable) as (
  values ('courier_signin_codes', 'id', 'uuid', false),
         ('courier_signin_codes', 'courier_id', 'uuid', false),
         ('courier_signin_codes', 'code_hash', 'bytea', false),
         ('courier_signin_codes', 'issued_at', 'timestamp with time zone', false),
         ('courier_signin_codes', 'expires_at', 'timestamp with time zone', false),
         ('courier_signin_codes', 'consumed_at', 'timestamp with time zone', true),
         ('courier_signin_codes', 'revoked_at', 'timestamp with time zone', true),
         ('courier_sessions', 'id', 'uuid', false),
         ('courier_sessions', 'courier_id', 'uuid', false),
         ('courier_sessions', 'code_id', 'uuid', false),
         ('courier_sessions', 'token_hash', 'bytea', false),
         ('courier_sessions', 'created_at', 'timestamp with time zone', false),
         ('courier_sessions', 'expires_at', 'timestamp with time zone', false),
         ('courier_sessions', 'last_seen_at', 'timestamp with time zone', false),
         ('courier_sessions', 'revoked_at', 'timestamp with time zone', true),
         ('courier_sessions', 'revoked_reason', 'text', true)
),
expected_constraints(tbl, name) as (
  values ('courier_signin_codes', 'courier_signin_codes_pkey'),
         ('courier_signin_codes', 'courier_signin_codes_courier_id_fkey'),
         ('courier_signin_codes', 'courier_signin_codes_code_hash_key'),
         ('courier_signin_codes', 'courier_signin_codes_code_hash_length_check'),
         ('courier_signin_codes', 'courier_signin_codes_consumed_or_revoked_check'),
         ('courier_sessions', 'courier_sessions_pkey'),
         ('courier_sessions', 'courier_sessions_courier_id_fkey'),
         ('courier_sessions', 'courier_sessions_code_id_fkey'),
         ('courier_sessions', 'courier_sessions_token_hash_key'),
         ('courier_sessions', 'courier_sessions_token_hash_length_check'),
         ('courier_sessions', 'courier_sessions_revoked_reason_check'),
         ('courier_sessions', 'courier_sessions_revoked_pair_check')
),
expected_indexes(name) as (
  values ('courier_signin_codes_pkey'), ('courier_signin_codes_code_hash_key'),
         ('courier_signin_codes_one_live_per_courier'),
         ('courier_sessions_pkey'), ('courier_sessions_token_hash_key'),
         ('courier_sessions_courier_id_idx')
),
-- kind: owner (no grantee at all) or service (service_role alone).
expected_functions(name, args, kind) as (
  values ('courier_register_legacy', '', 'owner'),
         ('courier_issue_signin_code', 'p_courier_id uuid', 'owner'),
         ('courier_revoke_sessions', 'p_courier_id uuid', 'owner'),
         ('courier_redeem_signin_code', 'p_code_hash bytea, p_token_hash bytea', 'service'),
         ('courier_session_resolve', 'p_token_hash bytea', 'service'),
         ('courier_end_session', 'p_token_hash bytea', 'service')
),
fn as (
  select e.name, e.args, e.kind, p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner
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
  select 'table public.' || t.name as object,
         exists (select 1 from tbl where relname = t.name) as present, null::text as detail
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
  union all
  select 'row level security enabled on ' || t.name,
         coalesce((select relrowsecurity from tbl where relname = t.name), false), null
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
  union all
  select 'no policies on ' || t.name || ' (none expected)',
         not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.name),
         null
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
  union all
  select 'column ' || e.tbl || '.' || e.name,
         exists (select 1 from information_schema.columns col
                  where col.table_schema = 'public' and col.table_name = e.tbl
                    and col.column_name = e.name and col.data_type = e.data_type
                    and (col.is_nullable = 'YES') = e.nullable),
         e.data_type || case when e.nullable then ' null' else ' not null' end
    from expected_columns e
  union all
  select 'no columns beyond the expected on ' || t.name,
         not exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = t.name
                        and col.column_name not in (select name from expected_columns where tbl = t.name)),
         null
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
  union all
  select 'constraint ' || e.name,
         exists (select 1 from pg_constraint k
                  where k.conrelid = (select oid from tbl where relname = e.tbl) and k.conname = e.name),
         (select pg_get_constraintdef(k.oid) from pg_constraint k
           where k.conrelid = (select oid from tbl where relname = e.tbl) and k.conname = e.name)
    from expected_constraints e
  union all
  select 'index ' || e.name,
         exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.indexname = e.name),
         (select i.indexdef from pg_indexes i where i.schemaname = 'public' and i.indexname = e.name)
    from expected_indexes e
  union all
  select 'anon, authenticated, PUBLIC and gyema_reader hold nothing on ' || t.name,
         exists (select 1 from tbl where relname = t.name)
         and not exists (select 1 from tacl where relname = t.name
                          and grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader')),
         (select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
            from tacl where relname = t.name and grantee in ('anon', 'authenticated', 'PUBLIC', 'gyema_reader'))
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
  union all
  select 'service_role holds exactly SELECT on ' || t.name,
         coalesce((select array_agg(privilege_type order by privilege_type) from tacl
                    where relname = t.name and grantee = 'service_role') = array['SELECT']::text[], false),
         (select string_agg(privilege_type, ', ' order by privilege_type) from tacl
           where relname = t.name and grantee = 'service_role')
    from (values ('courier_signin_codes'), ('courier_sessions')) t(name)
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
  'courier_signin_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'row_count', (select count(*) from rows),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present, 'detail', detail)) from rows)
  )
)) as courier_signin_verification;
