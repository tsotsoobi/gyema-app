-- ===========================================================================
-- 2026-09-15  Dispatch Reader: remit_cedis on guest_jobs_dispatch
-- ===========================================================================
--
-- EXTENDS db/migrations/2026-09-07_dispatch_reader_masked_view.sql section 5.
-- Nothing else in that file changes. The role, its session bounds, the masking
-- function, listings_dispatch, the revokes and the grant all stand as they are.
--
-- WHY THIS EXISTS
--
-- The courier commission shipped in commit 792bfd3 (Testnet) and its mirror
-- eb634ff (Mainnet). From then on /api/guest/accept writes remit_cedis, what
-- the courier owes Gyema, in the same UPDATE that claims the job.
--
-- The dispatch reader could not see it. Its REMIT OUTSTANDING section summed
-- quote_cedis, the gross the courier collected at the door, and labelled the
-- result as outstanding. The matching commit in scripts/dispatch-reader.mjs
-- sums remit_cedis instead, splits delivered rows with no commission recorded
-- into their own section, and adds an integrity check for a commission missing
-- on a job claimed after it shipped. All three need this column in the view.
--
-- WHAT IT EXPOSES, AND WHAT IT DOES NOT
--
-- gyema_reader holds SELECT on the whole view, not per column, so the column
-- added here is readable by the role the moment the replace lands. That is
-- the intent for remit_cedis. remit_pi, remit_rate, remit_method and remit_ref
-- are not added and remain unreachable to the role.
--
-- WHY CREATE OR REPLACE, AND NOT DROP THEN CREATE
--
-- The 2026-09-07 file drops and recreates the view. A drop takes the view's
-- grants with it, so this file would then have to repeat the revokes of
-- section 5a and the grant of section 7, and a missed line would either lock
-- the reader out or hand the view back to anon.
--
-- CREATE OR REPLACE VIEW keeps them. Checked against the PostgreSQL 18 manual,
-- not recalled: "only the view's defining SELECT rule, plus any WITH ( ... )
-- parameters and its CHECK OPTION are changed. Other view properties,
-- including ownership, permissions, and non-SELECT rules, remain unchanged."
--
-- Two constraints come with it, from the same page and from
-- src/backend/commands/view.c:
--
--   1. The new query must produce the existing columns with the same names, in
--      the same order, with the same types. A column may be added at the END of
--      the list and nowhere else. So the 22 existing columns below are
--      reproduced exactly and remit_cedis is column 23.
--
--   2. WITH ( ... ) is REPLACED, not merged. The source applies the options as
--      AT_ReplaceRelOptions, commented "The new options list replaces the
--      existing options list, even if it's empty." A replace that omitted WITH
--      would wipe the security_invoker = false that 2026-09-07 section 6 set.
--      The effective value would still be off, because off is the default, but
--      only by accident. So the option is restated here explicitly.
--
-- security_invoker does not exist before Postgres 15, and naming it on an older
-- server is an error. Pre-flight (a) below confirms the version first.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor. Testnet
-- first, verify with section 2 there, then the identical file on Mainnet on an
-- explicit go ahead. Confirm the project breadcrumb in the dashboard before
-- pasting, per CLAUDE.md.
--
-- ORDER AGAINST THE SCRIPT. On each network, apply this file BEFORE running the
-- new scripts/dispatch-reader.mjs there. The old script ignores the extra
-- column, so this file is safe to apply first. The new script lists
-- remit_cedis as a required column and refuses to run, with a preflight
-- failure naming it, against a view that does not have it.
--
-- SAFE TO RE-RUN. A second run replaces the view with the identical definition.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Pre-flight, read only. Run each and record the result BEFORE section 1.
--
-- (a) Server version. Expect 150000 or higher. Below that, stop: the WITH
--     clause in section 1 would error.
--
--     show server_version_num;
--
-- (b) Owner and options. Record both; section 2 expects them unchanged.
--     Expect reloptions {security_invoker=false}. You must be the owner, or a
--     member of the owning role, to replace the view.
--
--     select pg_get_userbyid(c.relowner) as owner, c.reloptions
--       from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relname = 'guest_jobs_dispatch';
--
-- (c) The LIVE definition. The replace must match the view as it exists on this
--     project, not as the 2026-09-07 file says it should be. Expect exactly the
--     22 columns in section 1, in that order, with nothing after
--     remit_paid_at. If the live view differs, stop: do not edit section 1 to
--     match, bring the difference back as a decision.
--
--     select pg_get_viewdef('public.guest_jobs_dispatch'::regclass, true);
--
-- (d) The type of the column being added, for the record.
--
--     select data_type, numeric_precision, numeric_scale, is_nullable
--       from information_schema.columns
--      where table_schema = 'public'
--        and table_name = 'guest_jobs'
--        and column_name = 'remit_cedis';
--
-- (e) Who can read the view. Record every row; section 2 expects the same rows.
--     Expect gyema_reader with SELECT, plus the owner. Nothing else, and in
--     particular no anon, authenticated or PUBLIC.
--
--     select case when a.grantee = 0 then 'PUBLIC'
--                 else pg_get_userbyid(a.grantee) end as grantee,
--            a.privilege_type
--       from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--       cross join lateral aclexplode(c.relacl) a
--      where n.nspname = 'public' and c.relname = 'guest_jobs_dispatch'
--      order by grantee, a.privilege_type;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The replace
--
-- Columns 1 to 22 are 2026-09-07 section 5 verbatim, in order. Column 23 is
-- the only addition. The ORDER BY and LIMIT are unchanged, so the row cap still
-- means the most recent 2000 rows.
-- ---------------------------------------------------------------------------
create or replace view public.guest_jobs_dispatch
  with (security_invoker = false)
as
  select
    tracking_id,
    status,
    created_at,
    updated_at,
    phone_verified,
    verified_at,
    pickup_area,
    dropoff_area,
    package_size,
    when_pref,
    scheduled_date,
    quote_cedis,
    payment_type,
    public.mask_phone_head_only(sender_phone)    as sender_phone_masked,
    public.mask_phone_head_only(recipient_phone) as recipient_phone_masked,
    assigned_courier,
    pickup_confirmed_at,
    pickup_confirmed_by,
    delivery_confirmed_at,
    delivery_confirmed_by,
    delivery_code_attempts,
    remit_paid_at,
    remit_cedis
  from public.guest_jobs
  order by created_at desc
  limit 2000;

comment on view public.guest_jobs_dispatch is
  'Dispatch reader view of guest_jobs. Phones are head masked and the raw columns are unreachable through it. Of the remit settlement columns it carries remit_paid_at and remit_cedis only. Capped at the most recent 2000 rows.';


-- ---------------------------------------------------------------------------
-- 2. Verification, per CLAUDE.md invariant 8
--
-- DDL reports Success whether or not it did what was intended. Verify from
-- catalog state, on each network, and compare against what section 0 recorded.
--
-- (a) Owner and options unchanged. Rerun 0(b). Expect the same owner and
--     reloptions {security_invoker=false}.
--
-- (b) Grants unchanged. Rerun 0(e). Expect exactly the rows it returned
--     before: gyema_reader SELECT plus the owner, and nothing else.
--
-- (c) The column list. Expect 23 rows, remit_cedis at position 23, and columns
--     1 to 22 exactly as in section 1.
--
--     select ordinal_position, column_name, data_type
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'guest_jobs_dispatch'
--      order by ordinal_position;
--
-- (d) Nothing else from the remit family arrived. Expect ZERO rows.
--
--     select column_name
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'guest_jobs_dispatch'
--        and column_name in ('remit_pi', 'remit_rate', 'remit_method', 'remit_ref');
--
-- (e) The row cap is not silently binding. Below 2000 is healthy; exactly 2000
--     means the report is truncated.
--
--     select count(*) from public.guest_jobs_dispatch;
--
-- (f) From the laptop, as gyema_reader: npm run dispatch. With the script
--     before its matching commit the preflight passes on 22 columns and the
--     extra one is ignored. With the new script it passes on 23.
--
-- ROLLBACK, if this file needs undoing. CREATE OR REPLACE cannot remove a
-- column, so the undo is a drop and a recreate. Run 2026-09-07 sections 5
-- (guest_jobs_dispatch only), 5a, 6 and the guest_jobs_dispatch grant in 7, in
-- that order, then rerun that file's section 8 checks. The new script will then
-- fail its preflight on remit_cedis, loudly, until it is reverted too.
--
-- ===========================================================================
