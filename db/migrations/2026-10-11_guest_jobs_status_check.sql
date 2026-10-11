-- ===========================================================================
-- 2026-10-11  guest_jobs_status_check
-- ===========================================================================
--
-- A named check holding guest_jobs.status to the seven values the guest rail
-- uses, so a hand edit or a code bug cannot store a value nothing in the app
-- or the dispatch reader reads.
--
-- IT ALREADY EXISTS ON BOTH NETWORKS. Found 11 Oct 2026 by the founder's
-- catalog read, before this file was applied anywhere: Testnet and Mainnet
-- both carry guest_jobs_status_check with the identical live definition
--
--   CHECK ((status = ANY (ARRAY['pending_quote'::text, 'posted'::text,
--     'accepted'::text, 'in_transit'::text, 'delivered'::text,
--     'cancelled'::text, 'expired'::text])))
--
-- It was added by hand before db/migrations existed, and the repository had
-- no record of it because there is no schema baseline. On both networks this
-- file is therefore a no-op that records the constraint in the repository: it
-- adds nothing, and its verification reads true. On a project without the
-- constraint it adds it. On a project where a constraint of that name has any
-- other definition, section 1 stops the file and prints the live definition.
-- It never drops or replaces an existing constraint.
--
-- THE SEVEN VALUES (founder decision, 11 Oct 2026)
--
--   posted         app/api/guest/create/route.ts, a listed corridor
--   pending_quote  app/api/guest/create/route.ts:219, an off-list corridor,
--                  read by scripts/dispatch-reader.mjs sections 1 and 2
--   accepted       lib/guest-claim.ts, the claim
--   in_transit     app/api/guest/confirm-pickup/route.ts
--   delivered      guest_stamp_delivery (2026-08-13_delivery_code.sql)
--   cancelled      applied by hand by the operator (F14)
--   expired        applied by hand by the operator (F14)
--
-- pending_quote stays: it is what the create route writes for every off-list
-- post, so a six-value check would refuse every off-list guest post. A search
-- of the codebase and every migration on 11 Oct 2026 found no other value
-- written to guest_jobs.status.
--
-- NULL. A check passes a null, so this check does not refuse a null status.
-- Whether the column is NOT NULL is not recorded in this repository; the
-- pre-flight reads it.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, Testnet
-- first and Mainnet only on an explicit go-ahead. Confirm the project
-- breadcrumb before pasting. Run section 0 on its own first. Then run the
-- whole file: section 1 stops it, before anything is written, if a
-- guest_jobs_status_check of a different definition exists or any row holds
-- a value outside the seven. The last statement is a read-only
-- verification returning one cell. all_present must read true.
--
-- ORDER. Independent of every other file. No code change goes with it: every
-- value the code writes is in the list.
--
-- SAFE TO RE-RUN. The check is added only if absent by name. A second run
-- changes nothing.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Pre-flight, read only. Run on its own and record the result BEFORE the
--    file. Bracketed, so a trailing space shows (CLAUDE.md, GYM-2F5367).
--    Every row must be one of the seven, exactly, or a null; anything else is
--    a stop: bring it back as a decision, do not edit section 2 to fit it.
--
--     select concat('[', status, ']') as bracketed, length(status), count(*)
--       from public.guest_jobs
--      group by status
--      order by count(*) desc;
--
--     select is_nullable from information_schema.columns
--      where table_schema = 'public' and table_name = 'guest_jobs'
--        and column_name = 'status';
--
--    And every check already on the table. Expected on both networks today:
--    guest_jobs_status_check, validated, the seven values in the order the
--    header records, so the file adds nothing.
--
--     select conname, convalidated, pg_get_constraintdef(oid)
--       from pg_constraint
--      where conrelid = 'public.guest_jobs'::regclass and contype = 'c'
--      order by conname;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Guard. Raises, and so stops the file before anything is written:
--
--   (a) if a constraint named guest_jobs_status_check exists with any
--       definition other than a validated check of status against exactly
--       the seven values, in any order. The message prints the live
--       definition. This file never drops or replaces an existing
--       constraint; a different one comes back as a decision.
--   (b) if any row holds a status outside the seven. The message carries the
--       bracketed values and their counts, never a row.
--
-- The shape test is anchored on the whole of pg_get_constraintdef, so a NOT
-- VALID check (which prints " NOT VALID" at the end), an extra term, or a
-- constraint of another type all fail it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_contype char;
  v_def     text;
  v_vals    text[];
  v_bad     text;
begin
  select c.contype, pg_get_constraintdef(c.oid)
    into v_contype, v_def
    from pg_constraint c
   where c.conrelid = 'public.guest_jobs'::regclass
     and c.conname = 'guest_jobs_status_check';

  if found then
    select array_agg(m[1] order by m[1] collate "C")
      into v_vals
      from regexp_matches(v_def, '''([^'']*)''::text', 'g') as m;

    if v_contype <> 'c'
       or v_def !~ '^CHECK \(\(status = ANY \(ARRAY\[''[a-z_]+''::text(, ''[a-z_]+''::text)*\]\)\)\)$'
       or v_vals is distinct from array['accepted', 'cancelled', 'delivered', 'expired',
                                        'in_transit', 'pending_quote', 'posted']::text[] then
      raise exception 'P16 guard: guest_jobs_status_check already exists with a different definition: %. Stop.', v_def;
    end if;
  end if;

  select string_agg(format('[%s] x%s', status, n), ', ' order by status)
    into v_bad
    from (select status, count(*) as n
            from public.guest_jobs
           where status not in ('posted', 'pending_quote', 'accepted', 'in_transit',
                                'delivered', 'cancelled', 'expired')
           group by status) s;

  if v_bad is not null then
    raise exception 'P16 guard: guest_jobs holds a status outside the seven: %. Stop.', v_bad;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The named check, added only if absent
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so this is guarded on
-- pg_constraint by name. Where it already exists, section 1 has confirmed it
-- is the seven-value check, and this does nothing. Where it is absent, adding
-- it validates every existing row, which section 1 has just confirmed.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.guest_jobs'::regclass
       and conname = 'guest_jobs_status_check'
  ) then
    alter table public.guest_jobs
      add constraint guest_jobs_status_check
      check (status in ('posted', 'pending_quote', 'accepted', 'in_transit',
                        'delivered', 'cancelled', 'expired'));
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Verification (read-only, changes nothing)
--
-- One jsonb cell. Every row must read present: true, and all_present true.
-- ---------------------------------------------------------------------------
with
chk as (
  select c.convalidated, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
   where c.conrelid = 'public.guest_jobs'::regclass
     and c.conname = 'guest_jobs_status_check'
     and c.contype = 'c'
),
vals(v) as (
  values ('posted'), ('pending_quote'), ('accepted'), ('in_transit'),
         ('delivered'), ('cancelled'), ('expired')
),
rows as (
  select 'constraint guest_jobs_status_check, validated' as object,
         coalesce((select convalidated from chk), false) as present
  union all
  select 'guest_jobs_status_check is status = ANY of a text array, and nothing else',
         coalesce((select def ~ '^CHECK \(\(status = ANY \(ARRAY\[''[a-z_]+''::text(, ''[a-z_]+''::text)*\]\)\)\)$'
                     from chk), false)
  union all
  select 'guest_jobs_status_check names each of the seven values',
         coalesce((select bool_and(chk.def ~ ('''' || vals.v || '''')) from chk cross join vals), false)
  union all
  select 'guest_jobs_status_check names exactly seven values',
         coalesce((select (select count(*) from regexp_matches(def, '''[a-z_]+''', 'g')) = 7 from chk), false)
  union all
  select 'exactly one check constraint on guest_jobs names status',
         (select count(*) from pg_constraint c
           where c.conrelid = 'public.guest_jobs'::regclass and c.contype = 'c'
             and pg_get_constraintdef(c.oid) ~ '\mstatus\M') = 1
  union all
  select 'no row holds a status outside the seven',
         not exists (select 1 from public.guest_jobs
                      where status not in ('posted', 'pending_quote', 'accepted', 'in_transit',
                                           'delivered', 'cancelled', 'expired'))
)
select jsonb_pretty(jsonb_build_object(
  'guest_jobs_status_check_verification', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'all_present', (select bool_and(present) from rows),
    'check_definition', (select def from chk),
    'rows', (select jsonb_agg(jsonb_build_object('object', object, 'present', present)) from rows)
  )
)) as guest_jobs_status_check_verification;
