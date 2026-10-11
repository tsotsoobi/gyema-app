-- ===========================================================================
-- Pioneer usernames that appear in more than one case
-- ===========================================================================
--
-- READ ONLY. One SELECT, one jsonb cell, one Run per network. It creates,
-- alters, drops, grants and revokes nothing.
--
-- It reads public.pioneers.pi_username and returns COUNTS ONLY. No username
-- leaves the table.
--
-- WHY. courier_registry holds one row per Pioneer, enforced by a unique index
-- on lower(pi_username) (db/migrations/2026-10-08_courier_registry.sql). That
-- is right only if Pi never returns one account's username in two cases. If
-- pioneers already holds 'Ama' and 'ama', either they are one account seen in
-- two cases, which the lower() index handles, or they are two accounts whose
-- names differ only by case, which it would wrongly treat as one. This query
-- says whether either shape exists, not which.
--
-- WHAT EACH NUMBER MEANS
--
--   rows                          rows in pioneers
--   rows_with_username            rows with a non-null pi_username
--   distinct_usernames            distinct values, case sensitive
--   distinct_usernames_lowered    distinct values after lower()
--   case_variant_groups           usernames that appear in two or more cases
--   rows_in_case_variant_groups   rows belonging to those groups
--   exact_duplicate_groups        usernames held by more than one row in the
--                                 same case (known to be possible:
--                                 lib/supabase-admin.ts:207-208)
--   untrimmed_usernames           values with leading or trailing whitespace
--
-- Expect case_variant_groups = 0 and distinct_usernames equal to
-- distinct_usernames_lowered. Anything else, paste it back before the courier
-- registry is applied.
--
-- HOW TO RUN IT. Select the whole file and Run, once per project, with the
-- project breadcrumb confirmed. Paste the one cell back, labelled with the
-- network.
-- ===========================================================================

with
u as (
  select pi_username from public.pioneers where pi_username is not null
),
by_lower as (
  select lower(pi_username) as k,
         count(*) as n_rows,
         count(distinct pi_username) as n_cases
    from u
   group by lower(pi_username)
),
by_exact as (
  select pi_username, count(*) as n_rows
    from u
   group by pi_username
)
select jsonb_pretty(jsonb_build_object(
  'gyema_pioneer_username_case', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'network_label', 'FILL THIS IN: the network this ran on'
  ),
  'rows',                        (select count(*) from public.pioneers),
  'rows_with_username',          (select count(*) from u),
  'distinct_usernames',          (select count(distinct pi_username) from u),
  'distinct_usernames_lowered',  (select count(distinct lower(pi_username)) from u),
  'case_variant_groups',         (select count(*) from by_lower where n_cases > 1),
  'rows_in_case_variant_groups', (select coalesce(sum(n_rows), 0) from by_lower where n_cases > 1),
  'exact_duplicate_groups',      (select count(*) from by_exact where n_rows > 1),
  'untrimmed_usernames',         (select count(*) from u where pi_username <> btrim(pi_username))
)) as gyema_pioneer_username_case;
