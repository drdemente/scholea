-- Clients read through functions only: no table, and so no row estimate.
--
-- What this file is about. The Data API answers "Prefer: count=planned" with
-- the planner's estimate of how many rows a request matches. The planner makes
-- that estimate from statistics about the WHOLE table and applies the caller's
-- filters to them; row level security only decides which rows come back. While
-- a signed-in client could select the tables, a researcher who saw one profile
-- row (their own) and no audit row was still told roughly how many accounts,
-- suspended accounts and audit entries exist, how many accounts name a given
-- institution, and where in the alphabet other people's addresses fall.
--
-- The fix is that there is nothing to plan: no API role can select any table
-- (010 checks the grants). Here the leak itself is attempted, with enough rows
-- and fresh statistics for the estimates to mean something, and then every
-- read function is shown to work without a single table grant.

begin;
select plan(59);

-- ---------------------------------------------------------------------------
-- Fixtures: an instance with something to count
-- ---------------------------------------------------------------------------
select tests.create_user('nr-researcher@example.test');
select tests.create_user('nr-outsider@example.test');
select tests.create_user('nr-admin@example.test', 'admin');
select tests.create_user('nr-master@example.test', 'master_admin');
select tests.create_user('nr-suspended@example.test');
select tests.create_user('nr-deleted@example.test');
select tests.create_user('nr-invited@example.test', 'researcher', false);

select count(*) as filler_accounts
  from (select tests.create_user('nr-filler-' || g || '@example.test') from generate_series(1, 120) g) made;

update public.profiles set name = 'Rae Researcher' where email = 'nr-researcher@example.test';
update public.profiles set institution = 'Aga Khan University'
 where email like 'nr-filler-1%@example.test';
update public.profiles set status = 'suspended'
 where email in ('nr-suspended@example.test', 'nr-filler-7@example.test', 'nr-filler-8@example.test');
update public.profiles set status = 'deleted', email = null where id = tests.user_id('nr-deleted@example.test');

select count(*) as filler_audit_rows
  from (select private.write_audit(tests.user_id('nr-filler-' || (g % 120 + 1) || '@example.test'), 'auth.login')
          from generate_series(1, 300) g) made;
select private.write_audit(tests.user_id('nr-master@example.test'), 'master.role_changed', 'user', 'somebody');

-- Two projects: the researcher's own, and one they have nothing to do with.
select tests.login_as('nr-researcher@example.test');
select public.create_project('proj_11000000-0000-4000-8000-000000000001', 'Mine', 'rct') ->> 'ok' as mine;
select public.put_project_content('proj_11000000-0000-4000-8000-000000000001',
  '{"stepData":{"q":"mine"},"stepStatus":{}}', 0, 1000) ->> 'rev' as pushed;
select public.add_project_comment('proj_11000000-0000-4000-8000-000000000001', 'question', 'A comment of mine.') ->> 'ok' as commented;
select public.set_project_review('proj_11000000-0000-4000-8000-000000000001', 'question', 'approved') ->> 'ok' as reviewed;
select public.set_step_owner('proj_11000000-0000-4000-8000-000000000001', 'question', auth.uid()) ->> 'ok' as owned;
select tests.login_as('nr-outsider@example.test');
select public.create_project('proj_11000000-0000-4000-8000-000000000002', 'Not yours', 'cohort') ->> 'ok' as theirs;
select public.put_project_content('proj_11000000-0000-4000-8000-000000000002',
  '{"stepData":{"q":"TOP SECRET"},"stepStatus":{}}', 0, 1000) ->> 'rev' as pushed;
select public.add_project_comment('proj_11000000-0000-4000-8000-000000000002', 'question', 'Private remark.') ->> 'ok' as commented;
select tests.logout();

-- Fresh statistics, as autovacuum produces them on a live instance.
analyze public.profiles;
analyze public.audit_log;
analyze public.projects;
analyze public.project_members;
analyze public.project_comments;

-- What "Prefer: count=planned" returns for a query: the planner's row estimate
-- as a number, or the SQLSTATE when the caller may not have the query planned.
create function pg_temp.estimate(p_sql text) returns text
language plpgsql as $$
declare
  v_plan json;
begin
  execute 'explain (format json) ' || p_sql into v_plan;
  return v_plan -> 0 -> 'Plan' ->> 'Plan Rows';
exception when others then
  return sqlstate;
end
$$;

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;

-- How a call ends: 'ok', the backend's own error code, or the SQLSTATE.
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

grant execute on function pg_temp.estimate(text), pg_temp.keys(jsonb), pg_temp.outcome(text)
  to authenticated, anon;

-- The owner can plan anything: the helper works, and the tables hold what the
-- estimates below must not reveal.
select cmp_ok(pg_temp.estimate('select * from public.profiles')::integer, '>=', 100,
  '(scene) the planner knows the instance has well over a hundred accounts');
select cmp_ok(pg_temp.estimate('select * from public.audit_log')::integer, '>=', 300,
  '(scene) and several hundred audit entries');

-- ===========================================================================
-- The leak, attempted by a researcher
-- ===========================================================================

select tests.login_as('nr-researcher@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

-- Every question the estimate used to answer. The researcher may see one
-- profile and no audit row; each of these was nevertheless answered with a
-- number that followed the real count.
select is(pg_temp.estimate(t.sql), '42501', 'no row estimate: ' || t.what)
  from (values
    (1,  'how many accounts there are',
         $q$ select * from public.profiles $q$),
    (2,  'how many accounts are suspended',
         $q$ select * from public.profiles where status = 'suspended' $q$),
    (3,  'how many administrators there are',
         $q$ select * from public.profiles where role in ('admin', 'master_admin') $q$),
    (4,  'how many accounts name an institution',
         $q$ select * from public.profiles where institution = 'Aga Khan University' $q$),
    (5,  'where other people''s addresses fall in the alphabet (a way to read them out of the statistics)',
         $q$ select * from public.profiles where email < 'nr-filler-5' $q$),
    (6,  'how large the audit log is',
         $q$ select * from public.audit_log $q$),
    (7,  'how often an action was taken',
         $q$ select * from public.audit_log where action = 'master.role_changed' $q$),
    (8,  'whether an address appears in the audit log (is it registered?)',
         $q$ select * from public.audit_log where actor_email in ('nr-filler-3@example.test', 'nr-researcher@example.test') $q$),
    (9,  'how many projects exist',
         $q$ select * from public.projects $q$),
    (10, 'whether a project with a given title exists',
         $q$ select * from public.projects where title = 'Not yours' $q$),
    (11, 'how many memberships exist',
         $q$ select * from public.project_members $q$),
    (12, 'what other people''s comments say',
         $q$ select * from public.project_comments where body < 'Q' $q$),
    (13, 'how many sign-offs exist',
         $q$ select * from public.project_reviews $q$),
    (14, 'how many steps have an owner',
         $q$ select * from public.step_ownership $q$),
    (15, 'how busy the instance is',
         $q$ select * from public.project_activity $q$),
    (16, 'how many invitations are waiting',
         $q$ select * from public.project_invitations $q$),
    (17, 'the settings row',
         $q$ select * from public.instance_settings $q$),
    (18, 'a count, which needs the same plan',
         $q$ select count(*) from public.profiles $q$),
    (19, 'a join of two tables',
         $q$ select * from public.project_members m join public.profiles p on p.id = m.user_id $q$)
  ) t (n, what, sql)
 order by t.n;

-- A function call is planned as one opaque row, whatever it reads.
select is(pg_temp.estimate($q$ select * from public.list_my_projects() $q$), '1',
  'the estimate for a function call is one row: it says nothing about the tables behind it');
select is(pg_temp.estimate($q$ select * from public.my_account() $q$), '1',
  'the same for my_account()');
select is(pg_temp.estimate($q$ select * from public.admin_list_users() $q$), '1',
  'and for a function the caller would be refused by');

-- ===========================================================================
-- Reading still works, through the functions, with no table grant at all
-- ===========================================================================

select is(public.my_profile() -> 'user' ->> 'email', 'nr-researcher@example.test',
  'my_profile: the caller''s own profile');
select is(
  (select array_agg(p ->> 'id') from jsonb_array_elements(public.list_my_projects() -> 'projects') p),
  array['proj_11000000-0000-4000-8000-000000000001'],
  'list_my_projects: the caller''s project, and not the one they have nothing to do with');
select is(
  (public.get_project_content('proj_11000000-0000-4000-8000-000000000001') ->> 'content')::jsonb -> 'stepData' ->> 'q',
  'mine', 'get_project_content: a member reads the content');
select is(
  jsonb_array_length(public.list_project_comments('proj_11000000-0000-4000-8000-000000000001') -> 'comments'), 1,
  'list_project_comments: a member reads the comments');
select is(
  public.list_project_reviews('proj_11000000-0000-4000-8000-000000000001') -> 'reviews' -> 0 ->> 'status', 'approved',
  'list_project_reviews: a member reads the sign-offs');
select is(
  public.list_step_ownership('proj_11000000-0000-4000-8000-000000000001') -> 'ownership' -> 0 ->> 'owner_id',
  auth.uid()::text, 'list_step_ownership: a member reads the step owners');
select cmp_ok(
  jsonb_array_length(public.get_project_activity('proj_11000000-0000-4000-8000-000000000001') -> 'entries'), '>=', 4,
  'get_project_activity: a member reads the ledger');

-- These five used to leave "is the caller a member" to row level security.
-- They ask it themselves now: somebody who is not a member gets 404, whether
-- the project exists or not, and learns nothing of what is inside.
select results_eq(
  $$ select t.name, pg_temp.outcome(format(t.sql, 'proj_11000000-0000-4000-8000-000000000002')),
                    pg_temp.outcome(format(t.sql, 'proj_11000000-0000-4000-8000-00000000dead'))
       from (values
         (1, 'get_project_content',   'select public.get_project_content(%L)'),
         (2, 'list_step_ownership',   'select public.list_step_ownership(%L)'),
         (3, 'list_project_comments', 'select public.list_project_comments(%L)'),
         (4, 'list_project_reviews',  'select public.list_project_reviews(%L)'),
         (5, 'get_project_activity',  'select public.get_project_activity(%L)')) t (n, name, sql)
      order by t.n $$,
  $$ values ('get_project_content', 'not_found', 'not_found'), ('list_step_ownership', 'not_found', 'not_found'),
            ('list_project_comments', 'not_found', 'not_found'), ('list_project_reviews', 'not_found', 'not_found'),
            ('get_project_activity', 'not_found', 'not_found') $$,
  'a non-member gets not_found from every project read, for an existing project exactly as for a missing one');

-- The administrators' reads check the role themselves.
select results_eq(
  $$ select t.name, pg_temp.outcome(t.sql)
       from (values
         (1, 'admin_list_users',   $q$ select public.admin_list_users() $q$),
         (2, 'admin_get_user',     $q$ select public.admin_get_user(tests.user_id('nr-outsider@example.test')) $q$),
         (3, 'admin_list_audit',   $q$ select public.admin_list_audit() $q$),
         (4, 'master_list_admins', $q$ select public.master_list_admins() $q$)) t (n, name, sql)
      order by t.n $$,
  $$ values ('admin_list_users', 'forbidden'), ('admin_get_user', 'forbidden'),
            ('admin_list_audit', 'forbidden'), ('master_list_admins', 'forbidden') $$,
  'a researcher is forbidden every administrative read');

select tests.login_as('nr-admin@example.test');
select cmp_ok((public.admin_list_users() ->> 'total')::integer, '>=', 126,
  'admin_list_users: an admin reads every account, with no grant on the profiles table');
select is(public.admin_get_user(tests.user_id('nr-outsider@example.test')) -> 'user' ->> 'email',
  'nr-outsider@example.test', 'admin_get_user: an admin reads one account');
select cmp_ok(jsonb_array_length(public.admin_list_audit(1000) -> 'entries'), '>=', 301,
  'admin_list_audit: an admin reads the audit log, with no grant on the audit_log table');
select is(pg_temp.outcome($$ select public.master_list_admins() $$), 'forbidden',
  'master_list_admins: an admin is not a master admin');
select is(pg_temp.estimate($q$ select * from public.profiles $q$), '42501',
  'an admin gets no estimate from the table either: the function is the only way in');
select results_eq(
  $$ select pg_temp.outcome($q$ select public.get_project_content('proj_11000000-0000-4000-8000-000000000001') $q$),
            pg_temp.outcome($q$ select public.list_project_comments('proj_11000000-0000-4000-8000-000000000001') $q$),
            (select count(*)::integer from jsonb_array_elements(public.list_my_projects() -> 'projects')) $$,
  $$ values ('not_found', 'not_found', 0) $$,
  'reading as the owner of the tables did not make an admin a member of anything');

select tests.login_as('nr-master@example.test');
select cmp_ok(jsonb_array_length(public.master_list_admins() -> 'admins'), '>=', 2,
  'master_list_admins: a master admin reads the admin tier');

-- Accounts that are not allowed in are refused by every one of them.
create temp table reads (n integer primary key, name text, sql text);
grant select on reads to authenticated;
insert into reads values
  (1, 'list_my_projects',      $q$ select public.list_my_projects() $q$),
  (2, 'get_project_content',   $q$ select public.get_project_content('proj_11000000-0000-4000-8000-000000000001') $q$),
  (3, 'list_project_comments', $q$ select public.list_project_comments('proj_11000000-0000-4000-8000-000000000001') $q$),
  (4, 'get_project_activity',  $q$ select public.get_project_activity('proj_11000000-0000-4000-8000-000000000001') $q$),
  (5, 'admin_list_users',      $q$ select public.admin_list_users() $q$),
  (6, 'admin_list_audit',      $q$ select public.admin_list_audit() $q$);

select tests.login_as('nr-suspended@example.test');
select is(
  (select array_agg(distinct pg_temp.outcome(r.sql)) from reads r), array['account_suspended'],
  'a suspended account is refused by every read function');
select tests.login_as('nr-invited@example.test');
select is(
  (select array_agg(distinct pg_temp.outcome(r.sql)) from reads r), array['password_reset_required'],
  'an invited account that has not set a password is refused by every read function');
select tests.login_as('nr-deleted@example.test');
select is(
  (select array_agg(distinct pg_temp.outcome(r.sql)) from reads r), array['unauthenticated'],
  'a deleted account is refused by every read function');

-- ===========================================================================
-- my_account: the caller's own record, whatever state the account is in
-- ===========================================================================

select tests.login_as('nr-researcher@example.test');
select is(pg_temp.keys(public.my_account()),
  'created_at,email,id,institution,must_set_password,name,role,status',
  'my_account: exactly the eight keys the app keeps on the device');
select is(
  public.my_account() - 'created_at',
  jsonb_build_object(
    'id', tests.user_id('nr-researcher@example.test'), 'email', 'nr-researcher@example.test',
    'name', 'Rae Researcher', 'institution', '', 'role', 'researcher', 'status', 'active',
    'must_set_password', false),
  'my_account: the caller''s own values');
select isnt((public.my_account() ->> 'created_at')::timestamptz, null,
  'my_account: created_at is a timestamp the app can parse');
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'my_account' and p.pronargs = 0), 1,
  'my_account: takes no argument, so there is nobody else to ask about');

select tests.login_as('nr-suspended@example.test');
select is(public.my_account() ->> 'status', 'suspended',
  'my_account: a suspended person reads their own status, which is how the app tells them why');
select is(pg_temp.outcome($$ select public.my_profile() $$), 'account_suspended',
  'my_account: while my_profile() refuses them');

-- An admin suspension ends the sessions too. The token is all that is left.
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('nr-suspended@example.test');
select tests.resume_as('nr-suspended@example.test');
select is(pg_temp.outcome($$ select public.my_profile() $$), 'unauthenticated',
  'a suspended account whose sessions were ended: my_profile() can only say unauthenticated');
select is(public.my_account() ->> 'status', 'suspended',
  'my_account: still says suspended, so the app shows the right notice');
select is(pg_temp.outcome($$ select public.list_my_projects() $$), 'unauthenticated',
  'my_account: and answering it opens nothing else');

select tests.login_as('nr-invited@example.test');
select is(public.my_account() -> 'must_set_password', 'true'::jsonb,
  'my_account: an invited person sees that a password is still to be set');

select tests.login_as('nr-deleted@example.test');
select is(
  public.my_account() - 'id' - 'created_at' - 'name' - 'institution',
  '{"email":null,"role":"researcher","status":"deleted","must_set_password":false}'::jsonb,
  'my_account: a deleted account reads "deleted" and no address');

select tests.logout();
select tests._present(gen_random_uuid(), 'nr-ghost@example.test', gen_random_uuid());
select is(public.my_account(), null, 'my_account: null for a token whose account does not exist');

select tests.logout();
set local role authenticated;
select is(public.my_account(), null, 'my_account: null without any claims');
reset role;

select tests.as_anon();
select is(pg_temp.outcome($$ select public.my_account() $$), '42501',
  'my_account: not for a caller without an account');
select is(pg_temp.estimate($q$ select * from public.profiles $q$), '42501',
  'a caller without an account gets no estimate either');
select tests.logout();

select * from finish();
rollback;
