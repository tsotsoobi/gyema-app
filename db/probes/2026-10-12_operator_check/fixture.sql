-- ===========================================================================
-- Docker fixture for the P18 probes (item 10). NEVER run against a Gyema
-- project: it creates roles and tables a Supabase project already has.
--
-- A throwaway postgres:17-alpine, made Supabase-shaped enough for P2, P5,
-- P9, P11, P12, P13, P15, P17 and P18 to run as they would there:
--
--   the four roles: anon, authenticated, service_role, gyema_reader
--   Supabase's default privileges for role postgres in public (all three API
--   roles on new tables and functions), then the grant baseline's 1a revoke
--   of anon and authenticated, as the item 6 fixture did
--   auth.users reduced to its key, for courier_registry's foreign key
--   guest_jobs reduced to what P13 touches, with service_role's grant only
--
-- Run by db/probes/2026-10-12_operator_check/run.sh, once per database. The
-- roles are cluster-wide, so they are created only if absent; everything
-- else is per database.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gyema_reader') then
    create role gyema_reader nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role, gyema_reader;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Grant baseline section 1a: anon and authenticated lose the defaults.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

create schema auth;
create table auth.users (id uuid primary key);

create table public.guest_jobs (
  tracking_id       text primary key,
  status            text not null default 'posted',
  assigned_courier  text null,
  created_at        timestamptz not null default now()
);
