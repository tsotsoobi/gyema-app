#!/usr/bin/env bash
# ===========================================================================
# P18 Docker probes (item 10, notes 10.9). A throwaway postgres:17-alpine in
# Docker; no Gyema database is touched, and nothing here takes a Supabase
# credential.
#
#   bash db/probes/2026-10-12_operator_check/run.sh
#
# From the repository root. Exits 0 only when every probe passed. The
# container is removed at the end unless KEEP=1.
# ===========================================================================
set -u

HERE="db/probes/2026-10-12_operator_check"
M="db/migrations"
NAME="${PROBE_CONTAINER:-gyema-p18-probes}"
FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  ok    $1"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL  $1"; }

psqlf() { # db file [vars...]: run a file, stop on the first error
  local db="$1" file="$2"; shift 2
  docker exec -i "$NAME" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q -tA "$@" < "$file"
}
psqlc() { # db sql: one statement, tuples only
  docker exec "$NAME" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -q -tA -c "$2"
}

PRE=(2026-10-08_courier_registry 2026-10-08_piverify_webhook 2026-10-08_piverify_resubmission
     2026-10-08_courier_signin 2026-10-08_courier_piverify_bind 2026-10-09_guest_jobs_courier_assignment
     2026-10-10_courier_registry_dispatch_view 2026-10-11_courier_registry_timing_checks)

setup_db() { # db [skip...]: fixture, then every prerequisite except those named
  local db="$1"; shift
  [ "$db" != "postgres" ] && psqlc postgres "create database $db" >/dev/null
  psqlf "$db" "$HERE/fixture.sql" >/dev/null || { echo "fixture failed on $db"; exit 2; }
  for f in "${PRE[@]}"; do
    local skip=0
    for s in "$@"; do [ "$f" = "$s" ] && skip=1; done
    [ $skip -eq 1 ] && continue
    psqlf "$db" "$M/$f.sql" >/dev/null || { echo "$f failed on $db"; exit 2; }
  done
}

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=probe postgres:17-alpine >/dev/null || exit 2
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && \
    docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
echo "server: $(psqlc postgres 'select version()' | cut -c1-30)"

# --- P18 applied twice -------------------------------------------------------
echo "P18 on the full prerequisite set, twice:"
setup_db postgres
for run in 1 2; do
  out="$(psqlf postgres "$M/2026-10-12_courier_operator_check.sql" 2>&1)"
  rc=$?
  rows=$(printf '%s' "$out" | grep -c '"object"')
  if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q '"all_present": true' && ! printf '%s' "$out" | grep -q '"present": false'; then
    pass "run $run: exit 0, all_present true over $rows rows"
  else
    fail "run $run: rc=$rc $(printf '%s' "$out" | tail -3)"
  fi
done

# --- the guard: a missing prerequisite stops the file, nothing written ------
echo "P18 guard, a missing prerequisite:"
for case in "no_p17:2026-10-11_courier_registry_timing_checks:Apply P17 first" \
            "no_p15:2026-10-10_courier_registry_dispatch_view:Apply P15 first" \
            "no_p11:2026-10-08_courier_signin:Apply P11 first"; do
  db="${case%%:*}"; rest="${case#*:}"; skip="${rest%%:*}"; want="${rest#*:}"
  setup_db "$db" "$skip"
  out="$(psqlf "$db" "$M/2026-10-12_courier_operator_check.sql" 2>&1)"; rc=$?
  cols=$(psqlc "$db" "select count(*) from information_schema.columns where table_name = 'courier_registry' and column_name like 'operator_check%'")
  fns=$(psqlc "$db" "select count(*) from pg_proc where proname in ('courier_record_operator_check', 'courier_start_operator_check_sunset')")
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "$want" && [ "$cols" = "0" ] && [ "$fns" = "0" ]; then
    pass "without $skip: stopped with \"$want\", no column and no function written"
  else
    fail "without $skip: rc=$rc cols=$cols fns=$fns $(printf '%s' "$out" | grep -m1 ERROR)"
  fi
done

# --- part 1 ------------------------------------------------------------------
echo "Probes, part 1 (before the sunset):"
psqlf postgres "$HERE/probes.sql" -v part=1 >/dev/null || { fail "part 1 stopped on an error"; }

# --- the two-session race, check first: the sunset waits, then marks it ------
X=$(psqlc postgres "select id from probe.c where name = 'X_race'")
( docker exec -i "$NAME" psql -U postgres -q -tA -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
begin;
select * from public.courier_record_operator_check('$X', 'founder');
select pg_sleep(4);
commit;
SQL
) &
HOLDER=$!
sleep 1
waited=$(docker exec -i "$NAME" psql -U postgres -q -tA -v ON_ERROR_STOP=1 <<'SQL' | tail -1
select extract(epoch from clock_timestamp()) as t0 \gset
select * from public.courier_start_operator_check_sunset() \g /dev/null
select round((extract(epoch from clock_timestamp()) - :t0)::numeric, 1);
SQL
)
wait $HOLDER
xdl=$(psqlc postgres "select operator_check_deadline is not null from public.courier_registry where id = '$X'")
xck=$(psqlc postgres "select operator_checked_at is not null from public.courier_registry where id = '$X'")
if awk "BEGIN{exit !($waited >= 2.5)}" && [ "$xdl" = "t" ] && [ "$xck" = "t" ]; then
  pass "race, check held open: the sunset waited ${waited}s on the advisory lock, then marked the new check"
else
  fail "race, check held open: waited=${waited}s checked=$xck deadline=$xdl"
fi

# --- the race the other way: the sunset held open, the check waits, refused --
setup_db race2
psqlf race2 "$M/2026-10-12_courier_operator_check.sql" >/dev/null
psqlf race2 /dev/stdin >/dev/null <<'SQL'
create temp table t as select 1;
do $$
declare v_id uuid; v_code text;
begin
  for i in 1 .. 2 loop
    select courier_id into v_id from public.courier_register_legacy();
    select code into v_code from public.courier_issue_signin_code(v_id);
    perform 1 from public.courier_redeem_signin_code(
      sha256(convert_to(translate(upper(v_code), 'OIL- ', '011'), 'UTF8')),
      sha256(convert_to(gen_random_uuid()::text, 'UTF8')));
  end loop;
end $$;
select courier_record_operator_check(min(id::text)::uuid, 'founder') from public.courier_registry;
SQL
Y=$(psqlc race2 "select id from public.courier_registry where operator_checked_at is null")
( docker exec -i "$NAME" psql -U postgres -d race2 -q -tA -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
begin;
select * from public.courier_start_operator_check_sunset();
select pg_sleep(4);
commit;
SQL
) &
HOLDER=$!
sleep 1
start=$(date +%s.%N)
out=$(psqlc race2 "select * from public.courier_record_operator_check('$Y', 'founder')" 2>&1)
end=$(date +%s.%N)
wait $HOLDER
w2=$(awk "BEGIN{printf \"%.1f\", $end - $start}")
yck=$(psqlc race2 "select operator_checked_at is null and status = 'registered' from public.courier_registry where id = '$Y'")
if printf '%s' "$out" | grep -q 'sunset_started' && awk "BEGIN{exit !($w2 >= 2.5)}" && [ "$yck" = "t" ]; then
  pass "race, sunset held open: the check waited ${w2}s, then was refused sunset_started, nothing written"
else
  fail "race, sunset held open: waited=${w2}s unchanged=$yck out=$out"
fi

# --- part 2 ------------------------------------------------------------------
echo "Probes, part 2 (after the sunset):"
psqlf postgres "$HERE/probes.sql" -v part=2 >/dev/null || { fail "part 2 stopped on an error"; }

# --- the reader's own statements, run as gyema_reader ------------------------
echo "The reader's sections 10 and 12, as gyema_reader:"
# A checked courier whose clock is 40 days old must stay out of section 10;
# an unchecked buffer courier 40 days old must be in it.
psqlc postgres "update public.courier_registry set operator_checked_at = now() - interval '40 days', buffer_since = now() - interval '40 days' where id = (select id from probe.c where name = 'A')" >/dev/null
psqlc postgres "update public.courier_registry set buffer_since = now() - interval '40 days' where id = (select id from probe.c where name = 'G_buffer_unchecked')" >/dev/null
sql_for() {
  node --input-type=module -e "const m = await import('./scripts/dispatch-reader.mjs'); const s = m.SECTIONS.find((x) => String(x.id) === '$1'); console.log(m.assertReadOnlySql(m.buildSql(s)));"
}
ref() { psqlc postgres "select left(id::text, 8) from probe.c where name = '$1'"; }
S10=$(sql_for 10); S12=$(sql_for 12)
r10=$(printf 'set role gyema_reader;\n%s;\n' "$S10" | docker exec -i "$NAME" psql -U postgres -q -tA -v ON_ERROR_STOP=1 2>&1)
if printf '%s' "$r10" | grep -q "^$(ref G_buffer_unchecked)|" && ! printf '%s' "$r10" | grep -q "^$(ref A)|"; then
  pass "section 10 lists the unchecked buffer courier at 40 days and leaves out the checked one"
else
  fail "section 10: $r10"
fi
r12=$(printf 'set role gyema_reader;\n%s;\n' "$S12" | docker exec -i "$NAME" psql -U postgres -q -tA -v ON_ERROR_STOP=1 2>&1)
got=$(printf '%s\n' "$r12" | grep -c '|')
want=$(psqlc postgres "select count(*) from public.courier_registry where operator_checked_at is not null and shredded_at is null and status <> 'full'")
missing=0
for n in A B_revoked C_expired K2 K3 K4 K5 K6 K7 X_race; do
  printf '%s' "$r12" | grep -q "^$(ref $n)|" || missing=$((missing + 1))
done
leaked=0
for n in K1 F_full S_shredded U_unchecked G_buffer_unchecked PIO N_after_sunset; do
  printf '%s' "$r12" | grep -q "^$(ref $n)|" && leaked=$((leaked + 1))
done
if [ "$got" = "$want" ] && [ $missing -eq 0 ] && [ $leaked -eq 0 ]; then
  pass "section 12 lists exactly the $want checked couriers not shredded and not full"
else
  fail "section 12: got $got want $want missing $missing leaked $leaked"
fi

# --- the catalog checks, after everything ------------------------------------
cat_out=$(psqlf postgres docs/catalog-checks.sql 2>&1)
if printf '%s' "$cat_out" | node -e "
  let t=''; process.stdin.on('data', d => t += d).on('end', () => {
    const d = JSON.parse(t.slice(t.indexOf('{')));
    const k = (p) => d[Object.keys(d).find((x) => x.startsWith(p))];
    const rows = k('check_09').filter((r) => r.migration === '2026-10-12 operator check');
    const ok = rows.length === 15 && rows.every((r) => r.present) && k('check_14').timing_rule_breaks.operator_checked_not_legacy === 0;
    process.exit(ok ? 0 : 1);
  })"; then
  pass "catalog check 9's fifteen 2026-10-12 rows true, check 14 operator_checked_not_legacy 0"
else
  fail "catalog checks after the probes"
fi

# --- the SQL probes' own results ---------------------------------------------
echo "SQL probe results:"
while IFS='|' read -r n name ok detail; do
  if [ "$ok" = "t" ]; then pass "$name"; else fail "$name ($detail)"; fi
done < <(psqlc postgres "select n, name, ok, coalesce(detail, '') from probe.results order by n")

echo
echo "$PASSES passed, $FAILS failed"
[ "${KEEP:-0}" = "1" ] || docker rm -f "$NAME" >/dev/null 2>&1
[ $FAILS -eq 0 ]
