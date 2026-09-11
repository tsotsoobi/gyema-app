-- ===========================================================================
-- 2026-09-11  Listing creation moves to a server route
-- ===========================================================================
--
-- THE FINDING (S-15)
--
-- Listing creation was a client side INSERT through the authed client, so the
-- browser composed the whole row. The catalog carries listings_insert_own:
--
--   with check (posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid'))
--
-- That is a good policy and it closed a real hole: one Pioneer could no longer
-- attribute a listing to another Pioneer's uid. It closed ONE COLUMN. The grant
-- behind it is table wide, from 2026-09-07_grant_baseline.sql section 3:
--
--   grant insert on public.listings to authenticated
--
-- so the policy was the only filter on the insert and it filtered one field.
-- Five things were still whatever the client sent, and the first of them
-- crosses a rail boundary:
--
--   1. tracking_id, chosen freely and checked against nothing. No constraint
--      can span public.listings and public.guest_jobs, and BOTH trackers
--      resolve listings before guest jobs, so a listing carrying an existing
--      guest job's code shadowed that delivery on the public tracker. The
--      sender following their parcel saw somebody else's listing. CLAUDE.md
--      invariant 3, the two rails never blend, broken from the Pioneer side.
--   2. matched_with_user_id, so a row could arrive already matched to a victim
--      and show up in their My Activity carrying a phone number its author
--      chose.
--   3. posted_by_username, which the policy does not mention at all, so a
--      Pioneer could post under their own uid and another Pioneer's name.
--   4. status, settable to completed or in_transit at insert, bypassing every
--      transition guard the routes in app/api/listings exist to enforce.
--   5. created_at, future datable, and the open feed orders by it descending.
--
-- WHAT THIS FILE DOES
--
-- Section 1 revokes INSERT on public.listings from authenticated. Creation is
-- app/api/listings/create, which runs with the service_role key, so the route
-- keeps working and nothing else can insert a listing at all. This is what
-- makes the route the only path rather than the preferred one.
--
-- Section 2 adds a unique index on tracking_id. It was missing: nothing in
-- db/migrations/ or docs/catalog-checks.sql ever created or checked one, and
-- the table predates version control. Worth having whichever fix ships,
-- because without it two listings can carry one code.
--
-- ORDER, AND IT MATTERS
--
-- DEPLOY THE CODE FIRST. Section 1 removes the grant the currently deployed
-- browser bundle relies on, so applying it before app/api/listings/create is
-- live means posting a trip or a package fails with 42501 on whichever network
-- it is applied to. The reverse order is safe: the route uses service_role,
-- which no grant in this file touches, so it works before and after.
--
-- Per CLAUDE.md this is applied BY HAND through the Supabase dashboard, with
-- the project breadcrumb confirmed, Testnet first, Mainnet only on an explicit
-- go ahead. Verify from catalog state, never from the Success banner.

-- ---------------------------------------------------------------------------
-- Section 1. Revoke INSERT on listings from authenticated
-- ---------------------------------------------------------------------------
--
-- A column level revoke cannot subtract from a table wide grant, which is the
-- lesson recorded in the 2026-08-14 migration. This is the table wide grant
-- itself, so revoking it is the whole job: there is no column list to unpick.

revoke insert on public.listings from authenticated;

-- Anon never held it. Asserted rather than assumed, because this file is
-- written to be safe on a project whose grants have drifted.
revoke insert on public.listings from anon;

-- ---------------------------------------------------------------------------
-- Section 2. One tracking ID, one row
-- ---------------------------------------------------------------------------
--
-- CREATE UNIQUE INDEX has no IF NOT EXISTS in older Postgres, and repeating a
-- migration should be safe, so this is guarded on the catalog rather than on
-- the banner.
--
-- CONCURRENTLY is deliberately NOT used. It cannot run inside a transaction
-- block, and the Supabase SQL editor does not preserve transaction state across
-- executions (CLAUDE.md), so the safe thing in a dashboard is the plain form.
-- The table is small enough that the brief lock does not matter.
--
-- IF THIS FAILS with a duplicate key error, it has found real duplicates rather
-- than misfired. Section 3 lists them.

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'listings'
       and indexname = 'listings_tracking_id_key'
  ) then
    execute 'create unique index listings_tracking_id_key
               on public.listings (tracking_id)';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Section 3. Verification, from catalog state
-- ---------------------------------------------------------------------------
--
-- Run each of these and READ THE RESULT. Invariant 8: a Success banner is not
-- evidence, and a DDL statement that matched nothing still reports success.

-- 3a. authenticated must hold SELECT and UPDATE on listings, and NOT INSERT.
--     Expect no row with privilege_type = 'INSERT'.
--
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'listings'
--    and grantee in ('anon', 'authenticated')
--  order by grantee, privilege_type;

-- 3b. The unique index must exist. Expect exactly one row.
--
-- select indexname, indexdef
--   from pg_indexes
--  where schemaname = 'public' and tablename = 'listings'
--    and indexname = 'listings_tracking_id_key';

-- 3c. Duplicates, if section 2 refused to build. Expect zero rows.
--     Run this BEFORE re-attempting section 2, and resolve by hand: a
--     tracking ID is printed on dispatch messages, so which row keeps it is a
--     judgement call and not something a migration should make.
--
-- select tracking_id, count(*), array_agg(id order by created_at)
--   from public.listings
--  group by tracking_id
-- having count(*) > 1;

-- 3d. Cross rail collisions. Expect zero rows. Nothing in the database can
--     enforce this, which is why the route checks both tables when it mints.
--
-- select l.tracking_id
--   from public.listings l
--   join public.guest_jobs g on g.tracking_id = l.tracking_id;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- Restores a hole rather than a feature, so treat it as incident response.
-- Only needed if app/api/listings/create is rolled back with it.
--
-- grant insert on public.listings to authenticated;
-- drop index if exists public.listings_tracking_id_key;
