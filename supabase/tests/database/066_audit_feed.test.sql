-- The audit log stays readable however large it gets (migration 15).
--
-- Nobody can change or remove an audit row, but every account can ADD rows for
-- free: each sign-in and each change of its own name writes one. The one read
-- function used to return the newest 1000 rows and nothing else, so anybody
-- could push what an administrator did out of sight by renaming themselves a
-- thousand times.
--
-- Now admin_list_audit() pages through the whole log, filters on the server
-- (p_kind => 'admin' leaves out what accounts write about themselves), and an
-- account may change its own profile 30 times an hour.

begin;
select plan(43);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('af-admin@example.test', 'admin');
select tests.create_user('af-master@example.test', 'master_admin');
select tests.create_user('af-victim@example.test');
select tests.create_user('af-noisy@example.test');
select tests.create_user('af-other@example.test');

create temp table seen (k text primary key, j jsonb);
grant select, insert on seen to authenticated;

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;

-- How a call ends: 'ok', or the backend's own error code.
create function pg_temp.outcome(p_sql text) returns text
language plpgsql as $$
declare
  v_state   text;
  v_message text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  if v_state = 'PGRST' then
    return v_message::jsonb ->> 'code';
  end if;
  return v_state;
end
$$;

-- Read the log page after page, as the app does, until there is no next page.
-- One row per entry: the page it came on, its position on that page, and what
-- the page said comes next.
create function pg_temp.walk(p_limit integer, p_kind text default null)
returns table (page integer, pos bigint, id uuid, action text, created_at bigint)
language plpgsql as $$
declare
  v_cursor text;
  v_answer jsonb;
begin
  page := 0;
  loop
    page := page + 1;
    v_answer := public.admin_list_audit(p_limit => p_limit, p_before => v_cursor, p_kind => p_kind);
    return query
      select page, t.n, (t.e ->> 'id')::uuid, t.e ->> 'action', (t.e ->> 'createdAt')::bigint
        from jsonb_array_elements(v_answer -> 'entries') with ordinality as t (e, n);
    v_cursor := v_answer ->> 'nextCursor';
    exit when v_cursor is null or page > 50;
  end loop;
end
$$;

-- The plan of a query when reading the whole table is not an option, as text.
-- (On a table as small as a test's the planner would rather read all of it.)
create function pg_temp.plan_without_seqscan(p_sql text) returns text
language plpgsql as $$
declare
  v_line text;
  v_plan text := '';
begin
  perform set_config('enable_seqscan', 'off', true);
  for v_line in execute 'explain ' || p_sql loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  perform set_config('enable_seqscan', 'on', true);
  return v_plan;
end
$$;

grant execute on function pg_temp.keys(jsonb), pg_temp.outcome(text), pg_temp.walk(integer, text) to authenticated;

-- A developer's database is not empty. Everything below is counted relative to
-- this moment, or looked for by a marker that only this file writes.
create temp table before_test as select count(*)::integer as n from public.audit_log;
grant select on before_test to authenticated;

-- ===========================================================================
-- The attack: bury what an administrator did
-- ===========================================================================

-- An admin does something that must stay findable.
select tests.login_as('af-admin@example.test');
select is(public.admin_update_user(tests.user_id('af-victim@example.test'), '{"role":"supervisor"}') -> 'user' ->> 'role',
  'supervisor', '(scene) an admin changes somebody''s role, which is audited');
select tests.logout();
-- A few milliseconds later, so the time filters further down can tell the two
-- apart (clients see times in whole milliseconds).
select pg_sleep(0.005);
select private.write_audit(tests.user_id('af-master@example.test'), 'master.role_changed', 'user', 'af-marker');

-- Those two entries, by id. A developer's log holds other role changes; the
-- ones that have to be found again are these.
create temp table buried as
  select a.id
    from public.audit_log a
   where (a.action = 'admin.user_updated' and a.actor_id = tests.user_id('af-admin@example.test'))
      or (a.action = 'master.role_changed' and a.target_id = 'af-marker');
grant select on buried to authenticated;

-- Then 1100 entries of the kind every account can write about itself.
select count(*) as noise
  from (select private.write_audit(tests.user_id('af-noisy@example.test'), 'auth.profile_updated', 'user', 'af-noise')
          from generate_series(1, 1100)) made;

select tests.login_as('af-admin@example.test');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.admin_list_audit(1000) -> 'entries') e
    where e ->> 'action' in ('admin.user_updated', 'master.role_changed')), 0,
  '(scene) the newest 1000 entries no longer contain either administrative action');

-- 1. The rest of the log is still reachable: follow nextCursor.
select isnt(public.admin_list_audit(1000) ->> 'nextCursor', null,
  'a full page says there is more: nextCursor is set');
insert into seen select 'walk', jsonb_agg(to_jsonb(w)) from pg_temp.walk(400) w;
select is(
  (select array_agg(w ->> 'action' order by w ->> 'action')
     from jsonb_array_elements((select j from seen where k = 'walk')) w
    where (w ->> 'id')::uuid in (select b.id from buried b)),
  array['admin.user_updated', 'master.role_changed'],
  'paging: following nextCursor reaches both administrative actions behind the noise, each of them once');
select is(
  (select count(*)::integer from jsonb_array_elements((select j from seen where k = 'walk'))),
  (select n + 1102 from before_test),
  'paging: the pages together hold every entry of the log, the 1102 of this test included');
select is(
  (select count(distinct w ->> 'id')::integer from jsonb_array_elements((select j from seen where k = 'walk')) w),
  (select count(*)::integer from jsonb_array_elements((select j from seen where k = 'walk'))),
  'paging: no entry appears on two pages');
select tests.as_owner();   -- a client cannot read a table: compare with the stored rows as the owner
select is(
  (select array_agg((w ->> 'id') order by (w ->> 'page')::integer, (w ->> 'pos')::integer)
     from jsonb_array_elements((select j from seen where k = 'walk')) w),
  (select array_agg(a.id::text order by a.created_at desc, a.id desc) from public.audit_log a),
  'paging: and they come in exactly the order of the log, newest first');
select tests.as_client();
select ok(
  (select bool_and(n = 400) from (
     select w ->> 'page' as page, count(*) as n
       from jsonb_array_elements((select j from seen where k = 'walk')) w
      group by 1
     having (w ->> 'page')::integer < (select max((x ->> 'page')::integer)
                                         from jsonb_array_elements((select j from seen where k = 'walk')) x)) full_pages),
  'paging: every page but the last is full');

-- 2. Or leave the noise out altogether.
select results_eq(
  $$ select e ->> 'action'
       from jsonb_array_elements(public.admin_list_audit(p_limit => 2, p_kind => 'admin') -> 'entries')
            with ordinality as t (e, n)
      order by n $$,
  $$ values ('master.role_changed'), ('admin.user_updated') $$,
  'p_kind admin: the two administrative actions are the first two entries, whatever was written since');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.admin_list_audit(p_limit => 1000, p_kind => 'admin') -> 'entries') e
    where e ->> 'action' like 'auth.%'), 0,
  'p_kind admin: holds no entry an account wrote about itself');
select is(
  (select count(*)::integer from pg_temp.walk(300, 'auth') w where w.action not like 'auth.%'), 0,
  'p_kind auth: holds only those');
select is(
  (select count(*)::integer from pg_temp.walk(300, 'auth')) + (select count(*)::integer from pg_temp.walk(300, 'admin')),
  (select n + 1102 from before_test),
  'the two kinds together are the whole log: nothing falls between them');

-- The administrative entries have an index of their own, so the cost of that
-- page does not grow with the noise. The function plans its query for the
-- arguments of each call, which is what lets it use that index.
select tests.logout();
analyze public.audit_log;
select ok(
  pg_temp.plan_without_seqscan($q$ select a.id from public.audit_log a
                                    where a.action not like 'auth.%'
                                    order by a.created_at desc, a.id desc limit 201 $q$) ~ 'audit_log_admin_idx',
  'the administrative entries, newest first, can be read from their own index, in order and without a sort');
select ok(
  (select 'plan_cache_mode=force_custom_plan' = any (p.proconfig)
     from pg_proc p
    where p.oid = 'public.admin_list_audit(integer, text, text, text, uuid, text, bigint, bigint)'::regprocedure),
  'admin_list_audit plans for the arguments of each call');

-- ===========================================================================
-- The answer and the other filters
-- ===========================================================================

select tests.resume_as('af-admin@example.test');
select is(pg_temp.keys(public.admin_list_audit(1)), 'entries,nextCursor',
  'admin_list_audit: returns {entries, nextCursor}');
select is(
  pg_temp.keys(public.admin_list_audit(1) -> 'entries' -> 0),
  'action,actorEmail,actorId,after,before,createdAt,id,targetId,targetType',
  'admin_list_audit: an entry has the nine keys it always had');

select is(
  jsonb_array_length(public.admin_list_audit(p_action => 'master.role_changed', p_target_id => 'af-marker') -> 'entries'), 1,
  'p_action and p_target_id: one action about one target');
select is(
  public.admin_list_audit(p_action => 'master.role_changed', p_target_id => 'af-marker') -> 'nextCursor', 'null'::jsonb,
  'a page that holds everything has no nextCursor');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.admin_list_audit(p_limit => 1000, p_done_by => tests.user_id('af-noisy@example.test'))
                               -> 'entries')),
  1000, 'p_done_by: the noisy account''s entries, a full page of them');
select isnt(
  public.admin_list_audit(p_limit => 1000, p_done_by => tests.user_id('af-noisy@example.test')) ->> 'nextCursor', null,
  'p_done_by: with more to come');
select is(
  jsonb_array_length(public.admin_list_audit(p_limit => 1000, p_done_by => tests.user_id('af-admin@example.test')) -> 'entries'),
  1, 'p_done_by: what one administrator did');
select is(
  public.admin_list_audit(p_done_by => tests.user_id('af-admin@example.test')) -> 'entries' -> 0 ->> 'action',
  'admin.user_updated', 'p_done_by: and it is the role change');
select is(
  jsonb_array_length(public.admin_list_audit(p_limit => 1000, p_target_id => tests.user_id('af-victim@example.test')::text)
                     -> 'entries'),
  1, 'p_target_id: everything that happened to one account');
select is(
  jsonb_array_length(public.admin_list_audit(p_kind => 'auth', p_action => 'master.role_changed') -> 'entries'), 0,
  'filters narrow each other: an administrative action is not among the self-service entries');

-- Time. The marker entry is the reference point.
insert into seen
select 'marker', public.admin_list_audit(p_action => 'master.role_changed', p_target_id => 'af-marker') -> 'entries' -> 0;
select is(
  jsonb_array_length(public.admin_list_audit(
    p_limit => 1000, p_kind => 'admin',
    p_from => (select (j ->> 'createdAt')::bigint from seen where k = 'marker')) -> 'entries'),
  1, 'p_from: entries at or after a time (the marker itself, and nothing administrative since)');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.admin_list_audit(
            p_limit => 1000, p_kind => 'admin',
            p_to => (select (j ->> 'createdAt')::bigint from seen where k = 'marker')) -> 'entries') e
    where e ->> 'targetId' = 'af-marker'),
  0, 'p_to: entries before a time, the time itself excluded');
select is(
  jsonb_array_length(public.admin_list_audit(
    p_from => (select (j ->> 'createdAt')::bigint + 3600000 from seen where k = 'marker')) -> 'entries'),
  0, 'p_from in the future: nothing');

-- Entries written in the same microsecond are still told apart by the cursor.
select tests.logout();
insert into public.audit_log (action, target_type, target_id, created_at)
select 'tap.same_instant', 'user', 'af-tie-' || g, '2031-01-01 00:00:00+00'
  from generate_series(1, 7) g;
select tests.resume_as('af-admin@example.test');
select is(
  (select count(distinct w.id)::integer from pg_temp.walk(3) w where w.action = 'tap.same_instant'), 7,
  'entries with one and the same timestamp: paging in threes returns each of the seven once');

-- Limits, as before.
select results_eq(
  $$ select t.lim, jsonb_array_length(public.admin_list_audit(t.lim) -> 'entries')
       from unnest(array[1, 1000, 1001, 0, -5, null]::integer[]) with ordinality as t (lim, n)
      order by t.n $$,
  $$ values (1, 1), (1000, 1000), (1001, 1000), (0, 1), (-5, 1), (null, 200) $$,
  'p_limit: still between 1 and 1000, and 200 when left out');

-- What is refused.
select results_eq(
  $$ select t.what, pg_temp.outcome(t.sql)
       from (values
         (1, 'an unknown kind',          $q$ select public.admin_list_audit(p_kind => 'everything') $q$),
         (2, 'a cursor that is no cursor', $q$ select public.admin_list_audit(p_before => 'yesterday') $q$),
         (3, 'a cursor with SQL in it',  $q$ select public.admin_list_audit(p_before => '2026-01-01T00:00:00.000000Z_x''; drop table public.audit_log; --') $q$),
         (4, 'a cursor with an impossible date',
             $q$ select public.admin_list_audit(p_before => '2026-13-45T00:00:00.000000Z_00000000-0000-4000-8000-000000000000') $q$),
         (5, 'a negative time',          $q$ select public.admin_list_audit(p_from => -1) $q$),
         (6, 'a time past the year 9999', $q$ select public.admin_list_audit(p_to => 9223372036854775807) $q$),
         (7, 'an action over 200 characters', format('select public.admin_list_audit(p_action => %L)', repeat('a', 201))),
         (8, 'an empty kind (the same as none)', $q$ select public.admin_list_audit(p_kind => '') $q$),
         (9, 'a well formed cursor nobody issued',
             $q$ select public.admin_list_audit(p_before => '2026-01-01T00:00:00.000000Z_00000000-0000-4000-8000-000000000000') $q$)
       ) t (n, what, sql)
      order by t.n $$,
  $$ values ('an unknown kind', 'invalid_input'), ('a cursor that is no cursor', 'invalid_input'),
            ('a cursor with SQL in it', 'invalid_input'), ('a cursor with an impossible date', 'invalid_input'),
            ('a negative time', 'invalid_input'), ('a time past the year 9999', 'invalid_input'),
            ('an action over 200 characters', 'invalid_input'),
            ('an empty kind (the same as none)', 'ok'), ('a well formed cursor nobody issued', 'ok') $$,
  'admin_list_audit: every malformed argument is invalid_input; a cursor is only ever a position in the log');
select ok(to_regclass('public.audit_log') is not null, 'and the audit log is still there');

-- Who may read it has not changed.
select tests.login_as('af-noisy@example.test');
select is(pg_temp.outcome($$ select public.admin_list_audit(p_kind => 'admin') $$), 'forbidden',
  'a researcher is forbidden, with every argument');
select is(pg_temp.outcome($$ select public.admin_list_audit(p_before => 'nonsense') $$), 'forbidden',
  'and is told so before any argument is looked at');
select tests.login_as('af-master@example.test');
select is(pg_temp.outcome($$ select public.admin_list_audit(p_kind => 'admin') $$), 'ok', 'a master admin may');

-- ===========================================================================
-- An account cannot write audit rows without end
-- ===========================================================================

select tests.login_as('af-other@example.test');
select is(
  (select array_agg(distinct pg_temp.outcome(format('select public.update_my_profile(%L)', 'Name ' || g)))
     from generate_series(1, 30) g),
  array['ok'], '30 changes of one''s own name in an hour are fine');
select is(pg_temp.outcome($$ select public.update_my_profile('Name 31') $$), 'rate_limited',
  'the 31st is refused: rate_limited');
select tests.throws_code($$ select public.update_my_profile('Name 31') $$, 'rate_limited', 429,
  'with HTTP status 429');
select is(pg_temp.outcome($$ select public.update_my_profile(p_institution => 'Somewhere') $$), 'rate_limited',
  'the institution counts towards the same limit');
select is(public.my_profile() -> 'user' ->> 'name', 'Name 30', 'a refused change changed nothing');
select is(pg_temp.outcome($$ select public.update_my_profile('Name 30') $$), 'ok',
  'a call that changes nothing is not a change: it is neither counted nor refused');

select tests.logout();
select is(
  (select count(*)::integer from public.audit_log
    where actor_id = tests.user_id('af-other@example.test') and action = 'auth.profile_updated'), 30,
  'so one account wrote 30 audit rows in that hour, not 1000');

-- It is this account's own limit.
select tests.login_as('af-victim@example.test');
select is(pg_temp.outcome($$ select public.update_my_profile('Vera Victim') $$), 'ok',
  'another account is not affected');

-- And it is a rolling hour. The rows of the noisy account are an hour and a
-- minute old here (the log cannot be rewritten, so this account's were written
-- with that time).
select tests.logout();
insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, created_at)
select tests.user_id('af-master@example.test'), 'af-master@example.test', 'auth.profile_updated', 'user',
       tests.user_id('af-master@example.test')::text, clock_timestamp() - interval '61 minutes'
  from generate_series(1, 30);
select tests.login_as('af-master@example.test');
select is(pg_temp.outcome($$ select public.update_my_profile('Mona Master') $$), 'ok',
  'changes made more than an hour ago no longer count');

select tests.logout();

select * from finish();
rollback;
