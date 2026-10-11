-- ===========================================================================
-- Orphan courier tables: what couriers and legacy_couriers hold
-- ===========================================================================
--
-- READ ONLY. One SELECT, one jsonb cell, one Run per network. It creates,
-- alters, drops, grants and revokes nothing.
--
-- UNLIKE docs/catalog-checks.sql, THIS READS THE TABLES THEMSELVES, not only
-- the catalog. It counts rows, and for every column it counts how many rows
-- hold a non-null value. It never returns a value: no phone, no name, no id
-- leaves either table. That is enough to answer the one question decision 4
-- asks ("do any rows hold real people's details") without anyone reading
-- those details.
--
-- WHY. Nothing in this repository reads or writes couriers or
-- legacy_couriers. The courier registry replaces both
-- (db/migrations/2026-10-08_courier_registry.sql). Before either is dropped,
-- the founder records what each holds, per network. legacy_couriers is known
-- to exist on one network only; on the other this reports exists: false
-- rather than failing.
--
-- HOW TO RUN IT. Select the whole file and Run, once per project, with the
-- project breadcrumb confirmed. Paste the one cell back, labelled with the
-- network. If any row count is above zero and a PII-shaped column has a
-- non-null count above zero, record those counts before anything is dropped.
--
-- The drop itself is a separate migration, applied by hand on the founder's
-- go-ahead, and only after the PiVerify webhook no longer writes
-- legacy_couriers (docs/anchoring-decisions.md, answer 4).
--
-- HOW THE COUNTS WORK. A plain count(*) over a table that does not exist is
-- an error, and one statement cannot branch around that. query_to_xml runs a
-- query given as text, so it is only built and run inside the CASE branch
-- that has already confirmed the table exists.
-- ===========================================================================

with
targets(name) as (
  values ('couriers'), ('legacy_couriers')
),
present as (
  select t.name, to_regclass('public.' || quote_ident(t.name)) as reg
    from targets t
)
select jsonb_pretty(jsonb_build_object(
  'gyema_orphan_courier_tables', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'network_label', 'FILL THIS IN: the network this ran on'
  ),
  'tables', (
    select jsonb_agg(
      jsonb_build_object(
        'table_name', p.name,
        'exists', p.reg is not null,
        'row_count',
          case when p.reg is null then null
               else (xpath('/row/n/text()',
                       query_to_xml(format('select count(*) as n from public.%I', p.name),
                                    false, true, '')))[1]::text::bigint
          end,
        'rls_enabled', (select c.relrowsecurity from pg_class c where c.oid = p.reg),
        'columns', coalesce((
          select jsonb_agg(
                   jsonb_build_object(
                     'name', col.column_name,
                     'type', col.data_type,
                     'pii_shaped',
                       (col.column_name ilike '%phone%' or col.column_name ilike '%whatsapp%'
                        or col.column_name ilike '%email%' or col.column_name ilike '%name%'
                        or col.column_name ilike '%address%' or col.column_name ilike '%card%'
                        or col.column_name ilike '%wallet%' or col.column_name ilike '%uid%'
                        or col.column_name ilike '%dob%' or col.column_name ilike '%birth%'),
                     'non_null_count',
                       (xpath('/row/n/text()',
                          query_to_xml(format('select count(%I) as n from public.%I',
                                              col.column_name, p.name),
                                       false, true, '')))[1]::text::bigint
                   )
                   order by col.ordinal_position)
            from information_schema.columns col
           where p.reg is not null
             and col.table_schema = 'public'
             and col.table_name = p.name
        ), '[]'::jsonb)
      )
      order by p.name)
    from present p
  )
)) as gyema_orphan_courier_tables;
