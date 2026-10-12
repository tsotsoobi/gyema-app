-- ===========================================================================
-- P18 behaviour probes (item 10, notes 10.9). NEVER run against a Gyema
-- project: it creates a probe schema and writes fixture couriers.
--
-- Runs after fixture.sql, P2, P5, P9, P11, P12, P13, P15, P17 and P18, as
-- the owner (postgres), in two parts split by run.sh: part 1 before the
-- two-session race, which is what starts the sunset, and part 2 after it.
-- Every probe records one row in probe.results; run.sh prints them and fails
-- on any false.
--
-- expect_error runs a statement in a subtransaction, optionally as another
-- role, and always rolls it back: on an error it compares the SQLSTATE and
-- the message's closing code word; on no error it records a failure.
-- ===========================================================================

\set ON_ERROR_STOP on

-- \if :{?part} would be neater; run.sh passes -v part=1 or part=2.
select :'part' = '1' as is_part_1 \gset

\if :is_part_1

create schema probe;

create table probe.results (
  n       serial primary key,
  name    text not null,
  ok      boolean not null,
  detail  text null
);

-- The fixture couriers, by name.
create table probe.c (name text primary key, id uuid not null);

create function probe.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into probe.results (name, ok, detail) values (p_name, coalesce(p_cond, false), p_detail);
end
$$;

create function probe.expect_error(p_name text, p_sql text, p_state text,
                                   p_word text default null, p_role text default null)
returns void language plpgsql as $$
declare
  v_state  text;
  v_msg    text;
begin
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    execute p_sql;
    raise exception 'PROBE_NO_ERROR' using errcode = 'P9999';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'P9999' then
    perform probe.ok(p_name, false, 'no error was raised');
  else
    perform probe.ok(p_name,
                     v_state = p_state and (p_word is null or v_msg like '%: ' || p_word),
                     v_state || ' ' || v_msg);
  end if;
end
$$;

create function probe.id(p_name text) returns uuid language sql as $$
  select id from probe.c where name = p_name
$$;

-- A legacy courier, signed in through the real code functions or not.
create function probe.legacy(p_name text, p_signed_in boolean) returns uuid
language plpgsql as $$
declare
  v_id    uuid;
  v_code  text;
  v_out   text;
begin
  select courier_id into v_id from public.courier_register_legacy();
  insert into probe.c values (p_name, v_id);
  if p_signed_in then
    select code into v_code from public.courier_issue_signin_code(v_id);
    select outcome into v_out from public.courier_redeem_signin_code(
      sha256(convert_to(translate(upper(v_code), 'OIL- ', '011'), 'UTF8')),
      sha256(convert_to(gen_random_uuid()::text, 'UTF8')));
    if v_out <> 'ok' then
      raise exception 'probe.legacy: redeem answered %', v_out;
    end if;
  end if;
  return v_id;
end
$$;

create function probe.check(p_name text) returns text language sql as $$
  select outcome from public.courier_record_operator_check(probe.id(p_name), 'founder')
$$;

create function probe.bind(p_name text, p_expected text, p_new text) returns text language sql as $$
  select outcome from public.courier_bind_piverify_session(probe.id(p_name), p_expected, p_new, 'created')
$$;

create function probe.apply(p_name text, p_event text, p_session text, p_status text,
                            p_action text default null) returns text language sql as $$
  select outcome from public.courier_apply_kyc_status(p_event, 'probe', p_session,
                                                      probe.id(p_name)::text, p_status, p_action)
$$;

create function probe.row(p_name text) returns public.courier_registry language sql as $$
  select * from public.courier_registry where id = probe.id(p_name)
$$;


-- ---------------------------------------------------------------------------
-- Part 1a. The sunset with nothing to mark, before any check
-- ---------------------------------------------------------------------------
select probe.expect_error('sunset with no eligible row refused, no_eligible_couriers',
  'select * from public.courier_start_operator_check_sunset()', '55000', 'no_eligible_couriers');
select probe.ok('after the refused sunset, no row carries a deadline (guard 6 reads not started)',
  not exists (select 1 from public.courier_registry where operator_check_deadline is not null));
select probe.expect_error('the sunset takes no argument: (30) has no such signature',
  'select * from public.courier_start_operator_check_sunset(30)', '42883');


-- ---------------------------------------------------------------------------
-- Part 1b. The fixture couriers
-- ---------------------------------------------------------------------------
select probe.legacy('A', true);
select probe.legacy('B_revoked', true);
select probe.legacy('C_expired', true);
select probe.legacy('D_code_unredeemed', false);
select probe.legacy('E_nothing_issued', false);
select probe.legacy('K1', true);
select probe.legacy('K2', true);
select probe.legacy('K3', true);
select probe.legacy('K4', true);
select probe.legacy('K5', true);
select probe.legacy('K6', true);
select probe.legacy('K7', true);
select probe.legacy('F_full', true);
select probe.legacy('S_shredded', true);
select probe.legacy('U_unchecked', true);
select probe.legacy('X_race', true);
select probe.legacy('N_after_sunset', true);
select probe.legacy('G_buffer_unchecked', true);
select probe.legacy('H_full_unchecked', true);
select probe.legacy('J_paused', true);
select probe.legacy('L_operator_paused', true);
select probe.legacy('M_rejected', true);
select probe.legacy('O_failed', true);
select probe.legacy('Q_approved_registered', true);
insert into probe.c select 'PIO', courier_id from public.courier_register_pioneer('pioneer_fixture');

-- D gets a code, never redeemed.
select public.courier_issue_signin_code(probe.id('D_code_unredeemed'));
-- B's session revoked, C's expired: both still count for guard 11.
update public.courier_sessions set revoked_at = now(), revoked_reason = 'operator'
 where courier_id = probe.id('B_revoked');
update public.courier_sessions set expires_at = now() - interval '1 day', created_at = now() - interval '100 days'
 where courier_id = probe.id('C_expired');


-- ---------------------------------------------------------------------------
-- Part 1c. The check: positive
-- ---------------------------------------------------------------------------
do $$
declare
  r  record;
  v  public.courier_registry;
begin
  select * into r from public.courier_record_operator_check(probe.id('A'), 'founder');
  v := probe.row('A');
  perform probe.ok('check A: outcome checked, status buffer', r.outcome = 'checked' and r.status = 'buffer', r.outcome);
  perform probe.ok('check A: buffer_since and operator_checked_at equal to the microsecond',
                   r.buffer_since = r.operator_checked_at and v.buffer_since = v.operator_checked_at);
  perform probe.ok('check A: the read-back agrees with the return',
                   v.status = 'buffer' and v.buffer_since = r.buffer_since and v.operator_checked_at = r.operator_checked_at
                   and v.operator_checked_by = 'founder' and r.courier_id = v.id);
  perform probe.ok('check A: nothing else moved (no session, no PiVerify column, no vouched_at, no deadline)',
                   v.piverify_session_id is null and v.piverify_status is null and v.vouched_at is null
                   and v.kyc_approved_at is null and v.operator_check_deadline is null and v.paused_reason is null);
end
$$;

select probe.ok('check B: a revoked session still counts', probe.check('B_revoked') = 'checked');
select probe.ok('check C: an expired session still counts', probe.check('C_expired') = 'checked');

do $$
declare
  before  public.courier_registry := probe.row('A');
  r       record;
  after   public.courier_registry;
begin
  perform pg_sleep(0.05);
  select * into r from public.courier_record_operator_check(probe.id('A'), 'founder');
  after := probe.row('A');
  perform probe.ok('re-run on A: already_checked with the stored values',
                   r.outcome = 'already_checked' and r.buffer_since = before.buffer_since
                   and r.operator_checked_at = before.operator_checked_at, r.outcome);
  perform probe.ok('re-run on A: nothing changed, updated_at included',
                   after.updated_at = before.updated_at and after.buffer_since = before.buffer_since
                   and after.operator_checked_at = before.operator_checked_at);
end
$$;

-- Everyone the later probes need checked, before the sunset starts.
select probe.ok('check ' || n, probe.check(n) = 'checked')
  from unnest(array['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'F_full', 'S_shredded']) as n;


-- ---------------------------------------------------------------------------
-- Part 1d. The check: negative, each with its SQLSTATE
-- ---------------------------------------------------------------------------
-- States the guards refuse, written by hand as the founder could.
update public.courier_registry set status = 'buffer', buffer_since = now()
 where id = probe.id('G_buffer_unchecked');
update public.courier_registry set status = 'full', kyc_approved_at = now()
 where id = probe.id('H_full_unchecked');
update public.courier_registry set status = 'paused', paused_reason = 'pending_timeout'
 where id = probe.id('J_paused');
update public.courier_registry set paused_reason = 'operator'
 where id = probe.id('L_operator_paused');
update public.courier_registry set piverify_session_id = 'ks_probe_m', piverify_status = 'rejected'
 where id = probe.id('M_rejected');
update public.courier_registry set piverify_session_id = 'ks_probe_o', piverify_status = 'failed'
 where id = probe.id('O_failed');
update public.courier_registry set kyc_approved_at = now()
 where id = probe.id('Q_approved_registered');

select probe.expect_error('a Pioneer refused, not_legacy',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('PIO')), '55000', 'not_legacy');
select probe.expect_error('an unchecked buffer courier refused, not_registered',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('G_buffer_unchecked')), '55000', 'not_registered');
select probe.expect_error('an unchecked full courier refused, not_registered',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('H_full_unchecked')), '55000', 'not_registered');
select probe.expect_error('a paused courier refused, not_registered',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('J_paused')), '55000', 'not_registered');
select probe.expect_error('registered with an operator pause refused, paused',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('L_operator_paused')), '55000', 'paused');
select probe.expect_error('registered with kyc_approved_at set refused, already_approved',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('Q_approved_registered')), '55000', 'already_approved');
select probe.expect_error('current session rejected refused, piverify_refused',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('M_rejected')), '55000', 'piverify_refused');
select probe.expect_error('current session failed refused, piverify_refused',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('O_failed')), '55000', 'piverify_refused');
select probe.expect_error('a code issued but never redeemed refused, never_signed_in',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('D_code_unredeemed')), '55000', 'never_signed_in');
select probe.expect_error('no code ever issued refused, never_signed_in',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('E_nothing_issued')), '55000', 'never_signed_in');
select probe.expect_error('an unknown id refused, unknown_courier, P0002',
  'select * from public.courier_record_operator_check(''00000000-0000-4000-8000-000000000000'', ''founder'')', 'P0002', 'unknown_courier');
select probe.expect_error('checked_by null refused, bad_checked_by',
  format('select * from public.courier_record_operator_check(%L, null)', probe.id('U_unchecked')), '22023', 'bad_checked_by');
select probe.expect_error('checked_by empty refused, bad_checked_by',
  format('select * from public.courier_record_operator_check(%L, '''')', probe.id('U_unchecked')), '22023', 'bad_checked_by');
select probe.expect_error('checked_by Founder refused, bad_checked_by',
  format('select * from public.courier_record_operator_check(%L, ''Founder'')', probe.id('U_unchecked')), '22023', 'bad_checked_by');
select probe.expect_error('checked_by a name refused, bad_checked_by',
  format('select * from public.courier_record_operator_check(%L, ''Ama'')', probe.id('U_unchecked')), '22023', 'bad_checked_by');
select probe.ok('none of the refused couriers was written: still unchecked',
  not exists (select 1 from public.courier_registry r join probe.c c on c.id = r.id
               where c.name in ('PIO', 'G_buffer_unchecked', 'H_full_unchecked', 'J_paused', 'L_operator_paused',
                                'Q_approved_registered', 'M_rejected', 'O_failed', 'D_code_unredeemed',
                                'E_nothing_issued', 'U_unchecked')
                 and r.operator_checked_at is not null));

-- Shredded: checked earlier, then shredded by hand; a re-run would answer
-- already_checked, so a fresh shredded courier is used for the refusal.
select probe.legacy('S2_shredded_unchecked', true);
update public.courier_registry set shredded_at = now() where id = probe.id('S2_shredded_unchecked');
select probe.expect_error('a shredded courier refused, shredded',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('S2_shredded_unchecked')), '55000', 'shredded');
update public.courier_registry set shredded_at = now() where id = probe.id('S_shredded');


-- ---------------------------------------------------------------------------
-- Part 1e. Privileges: nobody but the owner executes either function
-- ---------------------------------------------------------------------------
select probe.expect_error('service_role cannot execute courier_record_operator_check',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('U_unchecked')), '42501', null, 'service_role');
select probe.expect_error('anon cannot execute courier_record_operator_check',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('U_unchecked')), '42501', null, 'anon');
select probe.expect_error('authenticated cannot execute courier_record_operator_check',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('U_unchecked')), '42501', null, 'authenticated');
select probe.expect_error('service_role cannot execute courier_start_operator_check_sunset',
  'select * from public.courier_start_operator_check_sunset()', '42501', null, 'service_role');
select probe.expect_error('anon cannot execute courier_start_operator_check_sunset',
  'select * from public.courier_start_operator_check_sunset()', '42501', null, 'anon');
select probe.expect_error('authenticated cannot execute courier_start_operator_check_sunset',
  'select * from public.courier_start_operator_check_sunset()', '42501', null, 'authenticated');
select probe.expect_error('gyema_reader cannot execute courier_record_operator_check',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('U_unchecked')), '42501', null, 'gyema_reader');


-- ---------------------------------------------------------------------------
-- Part 1f. The four checks refuse a hand write
-- ---------------------------------------------------------------------------
select probe.expect_error('a hand UPDATE checking a Pioneer refused, 23514',
  format('update public.courier_registry set operator_checked_at = now(), operator_checked_by = ''founder'' where id = %L', probe.id('PIO')), '23514');
select probe.expect_error('a time without a who refused, 23514',
  format('update public.courier_registry set operator_checked_at = now() where id = %L', probe.id('U_unchecked')), '23514');
select probe.expect_error('a who without a time refused, 23514',
  format('update public.courier_registry set operator_checked_by = ''founder'' where id = %L', probe.id('U_unchecked')), '23514');
select probe.expect_error('a deadline without a check refused, 23514',
  format('update public.courier_registry set operator_check_deadline = now() where id = %L', probe.id('U_unchecked')), '23514');
select probe.expect_error('operator_checked_by someone refused, 23514',
  format('update public.courier_registry set operator_checked_by = ''someone'' where id = %L', probe.id('A')), '23514');


-- ---------------------------------------------------------------------------
-- Part 1g. The bind and courier_apply_kyc_status, before the sunset
-- ---------------------------------------------------------------------------
do $$
declare
  before  public.courier_registry := probe.row('K1');
  v       public.courier_registry;
begin
  perform probe.ok('bind K1 (checked, no deadline): bound', probe.bind('K1', null, 'ks_probe_k1') = 'bound');
  v := probe.row('K1');
  perform probe.ok('bind K1: keeps status buffer and buffer_since, sets the session created',
                   v.status = 'buffer' and v.buffer_since = before.buffer_since
                   and v.piverify_session_id = 'ks_probe_k1' and v.piverify_status = 'created');
  perform probe.ok('apply created again on K1: not_forward, still buffer',
                   probe.apply('K1', 'e_k1_created', 'ks_probe_k1', 'created') = 'not_forward'
                   and (probe.row('K1')).status = 'buffer');
  perform probe.ok('apply started on K1: applied, buffer, buffer_since unchanged',
                   probe.apply('K1', 'e_k1_started', 'ks_probe_k1', 'started') = 'applied'
                   and (probe.row('K1')).status = 'buffer' and (probe.row('K1')).buffer_since = before.buffer_since);
  perform probe.ok('apply pending_review on K1: buffer, buffer_since still the check time (no fresh clock)',
                   probe.apply('K1', 'e_k1_review', 'ks_probe_k1', 'pending_review') = 'applied'
                   and (probe.row('K1')).status = 'buffer'
                   and (probe.row('K1')).buffer_since = before.operator_checked_at);
  perform probe.ok('apply approved on K1: full, kyc_approved_at set, paused_reason null',
                   probe.apply('K1', 'e_k1_approved', 'ks_probe_k1', 'approved') = 'applied'
                   and (probe.row('K1')).status = 'full' and (probe.row('K1')).kyc_approved_at is not null
                   and (probe.row('K1')).paused_reason is null);
  perform probe.ok('K1 keeps the record of the check after approval',
                   (probe.row('K1')).operator_checked_at = before.operator_checked_at);
end
$$;

do $$
declare
  checked_at  timestamptz := (probe.row('K2')).operator_checked_at;
  v           public.courier_registry;
begin
  perform probe.bind('K2', null, 'ks_probe_k2');
  perform probe.ok('apply rejected (final) on K2: paused, reason rejected',
                   probe.apply('K2', 'e_k2_rejected', 'ks_probe_k2', 'rejected') = 'applied'
                   and (probe.row('K2')).status = 'paused' and (probe.row('K2')).paused_reason = 'rejected');
  perform probe.ok('rebind K2 after the final rejection: registered, buffer_since null',
                   probe.bind('K2', 'ks_probe_k2', 'ks_probe_k2b') = 'bound'
                   and (probe.row('K2')).status = 'registered' and (probe.row('K2')).buffer_since is null);
  perform pg_sleep(0.01);
  perform probe.apply('K2', 'e_k2b_review', 'ks_probe_k2b', 'pending_review');
  v := probe.row('K2');
  perform probe.ok('K2 back through PiVerify: buffer with a buffer_since that no longer equals the check',
                   v.status = 'buffer' and v.buffer_since is not null and v.buffer_since <> checked_at
                   and v.operator_checked_at = checked_at);
end
$$;

do $$
begin
  perform probe.bind('K3', null, 'ks_probe_k3');
  perform probe.ok('apply failed on K3: paused, reason failed',
                   probe.apply('K3', 'e_k3_failed', 'ks_probe_k3', 'failed') = 'applied'
                   and (probe.row('K3')).status = 'paused' and (probe.row('K3')).paused_reason = 'failed');
  perform probe.bind('K4', null, 'ks_probe_k4');
  perform probe.ok('apply rejected with RESUBMIT on K4: paused; started on the reopened session keeps it paused (decision 9)',
                   probe.apply('K4', 'e_k4_rejected', 'ks_probe_k4', 'rejected', 'RESUBMIT') = 'applied'
                   and probe.apply('K4', 'e_k4_started', 'ks_probe_k4', 'started') = 'applied'
                   and (probe.row('K4')).status = 'paused');
  perform probe.bind('F_full', null, 'ks_probe_f');
  perform probe.ok('F approved: full', probe.apply('F_full', 'e_f_approved', 'ks_probe_f', 'approved') = 'applied'
                   and (probe.row('F_full')).status = 'full');
  perform probe.ok('bind an unchecked registered courier: registered, buffer_since null, as P12',
                   probe.bind('U_unchecked', null, 'ks_probe_u') = 'bound'
                   and (probe.row('U_unchecked')).status = 'registered' and (probe.row('U_unchecked')).buffer_since is null);
end
$$;

\else

-- ---------------------------------------------------------------------------
-- Part 2, after the two-session race started the sunset
-- ---------------------------------------------------------------------------
do $$
declare
  v_min  timestamptz;
  v_max  timestamptz;
  v_n    integer;
begin
  select min(operator_check_deadline), max(operator_check_deadline), count(*)
    into v_min, v_max, v_n
    from public.courier_registry where operator_check_deadline is not null;
  perform probe.ok('the sunset gave every marked row the same deadline', v_n > 0 and v_min = v_max, v_n || ' rows');
  perform probe.ok('the deadline is 30 days after the sunset ran (within two minutes of now plus 30 days)',
                   abs(extract(epoch from (v_max - (now() + interval '30 days')))) < 120, v_max::text);
  perform probe.ok('every eligible row has it: checked, not shredded, not full',
                   not exists (select 1 from public.courier_registry
                                where operator_checked_at is not null and shredded_at is null
                                  and status <> 'full' and operator_check_deadline is null));
  perform probe.ok('full rows get none (K1, F_full)',
                   (probe.row('K1')).operator_check_deadline is null and (probe.row('F_full')).operator_check_deadline is null);
  perform probe.ok('a shredded row gets none', (probe.row('S_shredded')).operator_check_deadline is null);
  perform probe.ok('the courier checked inside the race got the deadline', (probe.row('X_race')).operator_check_deadline is not null);
  perform probe.ok('unchecked rows get none',
                   not exists (select 1 from public.courier_registry
                                where operator_checked_at is null and operator_check_deadline is not null));
end
$$;

do $$
declare
  before  timestamptz := (probe.row('A')).operator_check_deadline;
  r       record;
begin
  select * into r from public.courier_start_operator_check_sunset();
  perform probe.ok('a re-run of the sunset sets none and returns 0', r.couriers_given_a_deadline = 0, r::text);
  perform probe.ok('a re-run of the sunset moves no deadline', (probe.row('A')).operator_check_deadline = before);
end
$$;

select probe.ok('a re-run of the check on A after the sunset still answers already_checked',
  probe.check('A') = 'already_checked');
select probe.expect_error('after the sunset, a check on a new registered legacy courier refused, sunset_started',
  format('select * from public.courier_record_operator_check(%L, ''founder'')', probe.id('N_after_sunset')), '55000', 'sunset_started');
select probe.ok('and nothing was written for it',
  (probe.row('N_after_sunset')).operator_checked_at is null and (probe.row('N_after_sunset')).status = 'registered');

-- The bind against the deadline.
do $$
declare
  v public.courier_registry;
begin
  -- K7: deadline in the future, from the sunset.
  perform probe.ok('bind K7 (deadline ahead): keeps buffer and buffer_since',
                   probe.bind('K7', null, 'ks_probe_k7') = 'bound'
                   and (probe.row('K7')).status = 'buffer'
                   and (probe.row('K7')).buffer_since = (probe.row('K7')).operator_checked_at);

  -- K5: past the deadline, not paused by hand.
  update public.courier_registry set operator_check_deadline = now() - interval '1 day' where id = probe.id('K5');
  perform probe.bind('K5', null, 'ks_probe_k5');
  v := probe.row('K5');
  perform probe.ok('bind K5 (past the deadline, unpaused): registered, buffer_since null',
                   v.status = 'registered' and v.buffer_since is null);

  -- K6: past the deadline and paused by hand, pending_timeout.
  update public.courier_registry
     set operator_check_deadline = now() - interval '1 day', status = 'paused', paused_reason = 'pending_timeout'
   where id = probe.id('K6');
  perform probe.bind('K6', null, 'ks_probe_k6');
  v := probe.row('K6');
  perform probe.ok('bind K6 (past the deadline, paused pending_timeout): registered, reason cleared, buffer_since null',
                   v.status = 'registered' and v.paused_reason is null and v.buffer_since is null);
end
$$;

-- gyema_reader through the view.
do $$
declare
  n integer;
begin
  set local role gyema_reader;
  select count(*) into n from public.courier_registry_dispatch where operator_checked_at is not null;
  reset role;
  perform probe.ok('gyema_reader reads operator_checked_at through the view', n > 0, n || ' rows');
end
$$;

do $$
declare
  n integer;
begin
  set local role gyema_reader;
  select count(*) into n from public.courier_registry_dispatch where operator_check_deadline is not null;
  reset role;
  perform probe.ok('gyema_reader reads operator_check_deadline through the view', n > 0, n || ' rows');
end
$$;

select probe.expect_error('gyema_reader cannot read operator_checked_by: not in the view (42703)',
  'select operator_checked_by from public.courier_registry_dispatch', '42703', null, 'gyema_reader');
select probe.expect_error('gyema_reader cannot read courier_registry itself (42501)',
  'select operator_checked_by from public.courier_registry', '42501', null, 'gyema_reader');
select probe.expect_error('gyema_reader cannot update through the view (42501)',
  'update public.courier_registry_dispatch set status = ''full''', '42501', null, 'gyema_reader');
select probe.expect_error('service_role holds nothing on the view (42501)',
  'select courier_ref from public.courier_registry_dispatch', '42501', null, 'service_role');
select probe.expect_error('anon holds nothing on the view (42501)',
  'select courier_ref from public.courier_registry_dispatch', '42501', null, 'anon');

\endif
