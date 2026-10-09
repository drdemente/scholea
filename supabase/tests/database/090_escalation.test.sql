-- Privilege escalation: everything a caller might try in order to get more than
-- their role allows, attempted for real and expected to fail.
--
-- Part one is a plain researcher, signed in, with a project of their own:
--   * change their own role or status, by any route
--   * read another person's profile or email
--   * read the audit log or the instance settings
--   * write to any table directly
--   * forge an audit row or a ledger entry
--   * get into somebody else's project
--   * call any admin or master admin function
--   * run the master admin bootstrap (also as the secret key's role)
-- Part two is an admin trying to act on the admin tier, to hand out the admin
-- role, or to take over an account that is in use by changing its address.
--
-- Every other file asserts that the right thing works. This one only asserts
-- that the wrong thing does not, and that nothing changed afterwards.

begin;
select plan(134);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('es-researcher@example.test');
select tests.create_user('es-other@example.test');
select tests.create_user('es-owner@example.test');
select tests.create_user('es-suspended@example.test');
select tests.create_user('es-admin@example.test', 'admin');
select tests.create_user('es-admin2@example.test', 'admin');
select tests.create_user('es-master@example.test', 'master_admin');
select tests.create_user('es-master2@example.test', 'master_admin');
-- Two accounts nobody can use yet: invited without a password, and signed up
-- without ever confirming the address.
select tests.create_user('es-invited@example.test', 'researcher', false);
select tests.create_user('es-unconfirmed@example.test');

update public.profiles set name = 'Olivia Other', institution = 'Private Institute' where email = 'es-other@example.test';
update public.profiles set status = 'suspended' where email = 'es-suspended@example.test';
update auth.users set email_confirmed_at = null where id = tests.user_id('es-unconfirmed@example.test');

select private.write_audit(tests.user_id('es-master@example.test'), 'tap.escalation_marker');

-- What the escalation attempts must leave exactly as it is.
create temp table snapshot as
select p.id, p.email, p.name, p.institution, p.role, p.status, p.must_set_password
  from public.profiles p
 where p.email like 'es-%@example.test';
create temp table counts_before as
select (select count(*) from public.audit_log where action <> 'auth.email_changed') as audit_rows,
       (select count(*) from private.admin_intents) as intents,
       (select row(s.org_name, s.support_email, s.footer_contact, s.accent, s.enabled_study_types)::text
          from public.instance_settings s where s.id = 1) as settings;

create temp table seen (k text primary key, v text);
grant select, insert on seen to authenticated;

-- Run a statement as the current caller and name how it ended: 'ok', the code
-- of the backend's own error, or the SQLSTATE of any other. Whatever the
-- statement did is undone.
create function pg_temp.probe(p_sql text) returns text
language plpgsql as $$
declare
  v_state   text;
  v_message text;
begin
  begin
    execute p_sql;
    raise exception 'undo' using errcode = 'TAP01';
  exception
    when sqlstate 'TAP01' then
      return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
      if v_state = 'PGRST' then
        return v_message::jsonb ->> 'code';
      end if;
      return v_state;
  end;
end
$$;

-- The state of the fixtures, read as the owner while a client is signed in.
create function pg_temp.changed_profiles() returns text language sql stable security definer as $$
  select coalesce(string_agg(s.email, ',' order by s.email), '')
    from snapshot s
    join public.profiles p on p.id = s.id
   where (p.email, p.name, p.institution, p.role, p.status, p.must_set_password)
         is distinct from (s.email, s.name, s.institution, s.role, s.status, s.must_set_password);
$$;
create function pg_temp.role_of(p_email text) returns text language sql stable security definer as $$
  select p.role || '/' || p.status from public.profiles p where p.id = tests.user_id(p_email);
$$;
create function pg_temp.member_role(p_project text, p_email text) returns text language sql stable security definer as $$
  select m.role from public.project_members m where m.project_id = p_project and m.user_id = tests.user_id(p_email);
$$;

grant execute on function pg_temp.probe(text), pg_temp.changed_profiles(), pg_temp.role_of(text),
  pg_temp.member_role(text, text) to authenticated, anon, service_role;

-- Somebody else's project, with an invitation addressed to a third person.
select tests.login_as('es-owner@example.test');
select public.create_project('proj_90000000-0000-4000-8000-000000000002', 'Not Yours', 'rct') ->> 'ok' as other_project;
insert into seen
select 'invitation',
       public.invite_project_member('proj_90000000-0000-4000-8000-000000000002', 'es-someone@example.test', 'editor')
         -> 'invitation' ->> 'id';

-- ===========================================================================
-- PART ONE: a researcher
-- ===========================================================================

select tests.login_as('es-researcher@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');
select is(
  public.create_project('proj_90000000-0000-4000-8000-000000000001', 'My Own Study', 'cohort') -> 'project' ->> 'role',
  'owner', 'the researcher has a project of their own (so "their own rows" exist for the write attempts)');
select is(
  public.add_project_comment('proj_90000000-0000-4000-8000-000000000001', 'question', 'Mine.') -> 'comment' ->> 'author_id',
  auth.uid()::text, 'and a comment in it');

-- ---------------------------------------------------------------------------
-- 1. Change their own role or status
-- ---------------------------------------------------------------------------
select throws_ok(format('update public.profiles set %s where id = auth.uid()', t.assignment), '42501', null,
         'own profile, direct write: ' || t.assignment)
  from (values
    (1, $$role = 'master_admin'$$),
    (2, $$role = 'admin'$$),
    (3, $$status = 'active'$$),
    (4, $$must_set_password = false$$),
    (5, $$email = 'es-master@example.test'$$),
    (6, $$email_confirmed_at = now()$$)) t (n, assignment)
 order by t.n;
select throws_ok(
  $$ insert into public.profiles (id, email, role) values (gen_random_uuid(), 'es-forged@example.test', 'master_admin') $$,
  '42501', null, 'cannot insert a second, privileged profile');
select throws_ok(
  $$ insert into public.profiles (id, role) values (auth.uid(), 'master_admin')
     on conflict (id) do update set role = excluded.role $$,
  '42501', null, 'cannot upsert over their own profile');

select throws_ok($$ select public.update_my_profile(p_role => 'master_admin') $$, '42883', null,
  'update_my_profile takes no role');
select throws_ok($$ select public.update_my_profile('Me', 'Here', 'master_admin') $$, '42883', null,
  'not as a third positional argument either');

select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'admin_update_user on self, role',
             $q$ select public.admin_update_user(auth.uid(), '{"role":"master_admin"}') $q$),
         (2, 'admin_update_user on self, name only',
             $q$ select public.admin_update_user(auth.uid(), '{"name":"Still Me"}') $q$),
         (3, 'master_set_role on self',
             $q$ select public.master_set_role(auth.uid(), 'master_admin') $q$),
         (4, 'admin_set_user_status on self',
             $q$ select public.admin_set_user_status(auth.uid(), 'active') $q$),
         (5, 'admin_set_user_status on self, master surface',
             $q$ select public.admin_set_user_status(auth.uid(), 'active', 'master') $q$),
         (6, 'invite themselves as a master admin',
             $q$ select public.admin_begin_invite('es-researcher@example.test', 'master_admin', null, null, 'master') $q$),
         (7, 'invite a second address of theirs as an admin',
             $q$ select public.admin_begin_invite('es-researcher-alt@example.test', 'admin') $q$)
       ) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('admin_update_user on self, role', 'forbidden'),
            ('admin_update_user on self, name only', 'forbidden'),
            ('master_set_role on self', 'forbidden'),
            ('admin_set_user_status on self', 'forbidden'),
            ('admin_set_user_status on self, master surface', 'forbidden'),
            ('invite themselves as a master admin', 'forbidden'),
            ('invite a second address of theirs as an admin', 'forbidden') $$,
  'no admin function lets a researcher raise themselves: forbidden, every one');

-- Claims the person could put into their own user metadata, and claims they
-- could not: nothing in the token is ever read for role or status.
select tests.logout();
update auth.users
   set raw_user_meta_data = '{"role":"master_admin","status":"active","is_admin":true,"must_set_password":false}'
 where id = tests.user_id('es-researcher@example.test');
select tests.resume_as('es-researcher@example.test');
select set_config('request.jwt.claims', (
  current_setting('request.jwt.claims')::jsonb
  || '{"user_metadata":{"role":"master_admin","is_admin":true},
       "app_metadata":{"role":"master_admin","roles":["master_admin","admin"],"provider":"email"},
       "user_role":"master_admin","is_admin":true,"scholea_role":"master_admin"}'::jsonb)::text, true);
select is(auth.jwt() -> 'app_metadata' ->> 'role', 'master_admin', 'the token now claims to be a master admin');
select ok(not private.is_admin() and not private.is_master(),
  'a role in the token or in user metadata makes nobody an admin');
select is(pg_temp.probe($$ select public.admin_list_users() $$), 'forbidden',
  'and opens no admin function');
select is(pg_temp.probe($$ select public.master_list_admins() $$), 'forbidden',
  'and no master admin function');
select is(public.my_profile() -> 'user' ->> 'role', 'researcher',
  'my_profile still says researcher: the role is read from the database');
select is(pg_temp.role_of('es-researcher@example.test'), 'researcher/active',
  'the metadata edit did not reach the profile');

-- Taking over an address an administrator has just invited as an admin: the
-- role travels only with a brand new account, never with an email change.
select tests.logout();
insert into private.admin_intents (kind, actor_id, email, payload)
values ('invite', tests.user_id('es-master@example.test'), 'es-invited-admin@example.test',
        '{"role":"admin","surface":"master"}');
-- Their own change of address, as Auth writes it once they typed the emailed code.
update auth.users set email_change = 'es-invited-admin@example.test' where id = tests.user_id('es-researcher@example.test');
update auth.users set email = email_change, email_change = '' where email = 'es-researcher@example.test';
select is(
  (select p.role || '/' || p.email from public.profiles p
    where p.id = (select i.user_id from tests.issued_sessions i where i.email = 'es-researcher@example.test')),
  'researcher/es-invited-admin@example.test',
  'moving their own address onto an invited one does not give them the invited role');
select is(
  (select count(*)::integer from private.admin_intents where email = 'es-invited-admin@example.test'), 1,
  'and does not use up the invitation');
update auth.users set email_change = 'es-researcher@example.test'
 where id = (select i.user_id from tests.issued_sessions i where i.email = 'es-researcher@example.test');
update auth.users set email = email_change, email_change = ''
 where id = (select i.user_id from tests.issued_sessions i where i.email = 'es-researcher@example.test');
delete from private.admin_intents where email = 'es-invited-admin@example.test';
select tests.resume_as('es-researcher@example.test');

-- A suspended account cannot lift its own suspension.
select tests.login_as('es-suspended@example.test');
select results_eq(
  $$ select t.n, pg_temp.probe(t.sql)
       from (values
         (1, $q$ select public.admin_set_user_status(auth.uid(), 'active') $q$),
         (2, $q$ select public.update_my_profile('Free Again') $q$),
         (3, $q$ update public.profiles set status = 'active' where id = auth.uid() $q$),
         (4, $q$ select public.list_my_projects() $q$)) t (n, sql)
      order by t.n $$,
  $$ values (1, 'account_suspended'), (2, 'account_suspended'), (3, '42501'), (4, 'account_suspended') $$,
  'a suspended account cannot lift its own suspension, by function or by table');

select tests.resume_as('es-researcher@example.test');

-- ---------------------------------------------------------------------------
-- 2. Read another person's profile or email
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select email from public.profiles $$, '42501', null,
  'the profiles table shows a researcher nothing: it cannot be read at all, not even their own row');
select throws_ok(
  $$ select 1 from public.profiles where email = 'es-other@example.test' $$, '42501', null,
  'asking for another person by email is refused');
select throws_ok(
  format('select 1 from public.profiles where id = %L', tests.user_id('es-other@example.test')), '42501', null,
  'asking by id is refused');
select throws_ok(
  $$ select 1 from public.profiles where role in ('admin', 'master_admin') $$, '42501', null,
  'a researcher cannot find out who the administrators are');

select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'admin_get_user',        $q$ select public.admin_get_user(tests.user_id('es-other@example.test')) $q$),
         (2, 'admin_list_users',      $q$ select public.admin_list_users('es-other') $q$),
         (3, 'master_list_admins',    $q$ select public.master_list_admins() $q$),
         (4, 'admin_check_user_action',
             $q$ select public.admin_check_user_action(tests.user_id('es-other@example.test'), 'activate') $q$),
         (5, 'get_project of a project they are not in',
             $q$ select public.get_project('proj_90000000-0000-4000-8000-000000000002') $q$),
         (6, 'list_project_members of a project they are not in',
             $q$ select public.list_project_members('proj_90000000-0000-4000-8000-000000000002') $q$),
         (7, 'list_project_invitations of a project they are not in',
             $q$ select public.list_project_invitations('proj_90000000-0000-4000-8000-000000000002') $q$),
         (8, 'private.display_name',  $q$ select private.display_name(tests.user_id('es-other@example.test')) $q$),
         (9, 'auth.users',            $q$ select email from auth.users $q$),
         (10, 'auth.sessions',        $q$ select user_id from auth.sessions $q$),
         (11, 'auth.identities',      $q$ select email from auth.identities $q$)
       ) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('admin_get_user', 'forbidden'), ('admin_list_users', 'forbidden'), ('master_list_admins', 'forbidden'),
            ('admin_check_user_action', 'forbidden'),
            ('get_project of a project they are not in', 'not_found'),
            ('list_project_members of a project they are not in', 'not_found'),
            ('list_project_invitations of a project they are not in', 'not_found'),
            ('private.display_name', '42501'), ('auth.users', '42501'), ('auth.sessions', '42501'),
            ('auth.identities', '42501') $$,
  'no function and no table gives a researcher another person''s profile or email');

-- The admin functions are no oracle either: a researcher gets the same answer
-- for an address that has an account and for one that has not.
select is(
  pg_temp.probe($$ select public.admin_begin_invite('es-other@example.test', 'researcher') $$),
  pg_temp.probe($$ select public.admin_begin_invite('es-nobody@example.test', 'researcher') $$),
  'admin_begin_invite tells a researcher nothing about whether an address is registered');
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(auth.uid(), 'es-other@example.test') $$),
  pg_temp.probe($$ select public.admin_begin_email_change(auth.uid(), 'es-nobody@example.test') $$),
  'neither does admin_begin_email_change');
select is(
  pg_temp.probe($$ select public.admin_begin_invite('es-other@example.test', 'researcher') $$), 'forbidden',
  'the answer is forbidden, never email_taken');

-- ---------------------------------------------------------------------------
-- 3. Read the audit log or the instance settings
-- ---------------------------------------------------------------------------
select throws_ok($$ select 1 from public.audit_log $$, '42501', null, 'the audit log shows a researcher nothing');
select throws_ok(
  $$ select 1 from public.audit_log where actor_id = auth.uid() or target_id = auth.uid()::text $$, '42501', null,
  'not even the rows about themselves');
select throws_ok($$ select 1 from public.instance_settings $$, '42501', null, 'the settings row is not readable');
select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'admin_list_audit',      $q$ select public.admin_list_audit() $q$),
         (2, 'admin_get_settings',    $q$ select public.admin_get_settings() $q$),
         (3, 'admin_update_settings', $q$ select public.admin_update_settings('{"orgName":"Mine"}') $q$),
         (4, 'private.instance_json', $q$ select private.instance_json() $q$),
         (5, 'private.admin_intents', $q$ select * from private.admin_intents $q$)) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('admin_list_audit', 'forbidden'), ('admin_get_settings', 'forbidden'),
            ('admin_update_settings', 'forbidden'), ('private.instance_json', '42501'),
            ('private.admin_intents', '42501') $$,
  'no function gives a researcher the audit log, the settings table or the admin intents');

-- ---------------------------------------------------------------------------
-- 4. Write to any table directly
-- ---------------------------------------------------------------------------
-- Every table in public, every verb. The researcher owns a project, so for
-- most of these tables there are rows that are "theirs".
select is(
  (select count(*)::integer from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')), 10,
  'the four loops below try all ten tables in public');
select throws_ok(format('insert into public.%I default values', c.relname), '42501', null,
         'direct insert into ' || c.relname)
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
 order by c.relname;
select throws_ok(
         format('update public.%I set %I = %I', c.relname,
                (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum = 1),
                (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum = 1)),
         '42501', null, 'direct update of ' || c.relname)
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
 order by c.relname;
select throws_ok(format('delete from public.%I', c.relname), '42501', null,
         'direct delete from ' || c.relname)
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
 order by c.relname;
select throws_ok(format('truncate public.%I cascade', c.relname), '42501', null,
         'truncate of ' || c.relname)
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
 order by c.relname;

-- Their own rows are no exception.
select throws_ok(
  $$ update public.projects set title = 'Direct' where id = 'proj_90000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'cannot write to their own project row: the functions are the only way');
select throws_ok(
  $$ update public.project_members set role = 'owner' where user_id = auth.uid() $$,
  '42501', null, 'cannot write to their own membership row');
select throws_ok(
  $$ delete from public.project_comments where author_id = auth.uid() $$,
  '42501', null, 'cannot delete their own comment by writing to the table');

-- ---------------------------------------------------------------------------
-- 5. Forge an audit row or a ledger entry
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'insert an audit row in an admin''s name',
             $q$ insert into public.audit_log (actor_id, actor_email, action, target_type, target_id)
                 values (tests.user_id('es-master@example.test'), 'es-master@example.test',
                         'master.role_changed', 'user', auth.uid()::text) $q$),
         (2, 'private.write_audit',
             $q$ select private.write_audit(tests.user_id('es-master@example.test'), 'master.role_changed',
                                            'user', auth.uid()::text, '{"role":"researcher"}', '{"role":"master_admin"}') $q$),
         (3, 'rewrite an audit row', $q$ update public.audit_log set action = 'nothing.happened' $q$),
         (4, 'delete audit rows',    $q$ delete from public.audit_log $q$),
         (5, 'insert a ledger entry in somebody else''s name',
             $q$ insert into public.project_activity (project_id, actor_id, actor_name, action)
                 values ('proj_90000000-0000-4000-8000-000000000001', tests.user_id('es-other@example.test'),
                         'Olivia Other', 'review.approve') $q$),
         (6, 'private.log_activity',
             $q$ select private.log_activity('proj_90000000-0000-4000-8000-000000000001',
                                             tests.user_id('es-other@example.test'), 'review.approve', 'question') $q$),
         (7, 'rewrite a ledger entry', $q$ update public.project_activity set actor_name = 'Somebody Else' $q$),
         (8, 'insert a comment as somebody else',
             $q$ insert into public.project_comments (project_id, step_id, author_id, author_name, body)
                 values ('proj_90000000-0000-4000-8000-000000000001', 'question',
                         tests.user_id('es-other@example.test'), 'Olivia Other', 'I approve.') $q$),
         (9, 'insert a sign-off as somebody else',
             $q$ insert into public.project_reviews (project_id, step_id, status, reviewer_id, reviewer_name)
                 values ('proj_90000000-0000-4000-8000-000000000001', 'question', 'approved',
                         tests.user_id('es-other@example.test'), 'Olivia Other') $q$),
         (10, 'record an admin intent',
             $q$ insert into private.admin_intents (kind, actor_id, email, payload)
                 values ('invite', tests.user_id('es-master@example.test'), 'es-researcher-alt@example.test',
                         '{"role":"master_admin"}') $q$),
         (11, 'a ledger entry in a project they are not in',
             $q$ select public.add_project_comment('proj_90000000-0000-4000-8000-000000000002', 'question', 'Hello') $q$),
         (12, 'a sign-off in a project they are not in',
             $q$ select public.set_project_review('proj_90000000-0000-4000-8000-000000000002', 'question', 'approved') $q$)
       ) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('insert an audit row in an admin''s name', '42501'), ('private.write_audit', '42501'),
            ('rewrite an audit row', '42501'), ('delete audit rows', '42501'),
            ('insert a ledger entry in somebody else''s name', '42501'), ('private.log_activity', '42501'),
            ('rewrite a ledger entry', '42501'), ('insert a comment as somebody else', '42501'),
            ('insert a sign-off as somebody else', '42501'), ('record an admin intent', '42501'),
            ('a ledger entry in a project they are not in', 'not_found'),
            ('a sign-off in a project they are not in', 'not_found') $$,
  'no audit row, ledger entry, comment, sign-off or admin intent can be forged');

-- No function a client can call takes "who did it" as an argument: the actor
-- is always the caller.
select is_empty(
  $$ select p.proname || ': ' || a.name
       from pg_proc p
      cross join lateral unnest(p.proargnames) as a (name)
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and a.name ~ '(actor|author|reviewer|invited_by|added_by|created_by|updated_by)' $$,
  'no client function has an argument that names the actor, author or reviewer');
-- The legitimate comment they wrote carries their own name, from their profile.
select results_eq(
  $$ select (c ->> 'author_id')::uuid, c ->> 'author_name'
       from jsonb_array_elements(
              public.list_project_comments('proj_90000000-0000-4000-8000-000000000001') -> 'comments') c $$,
  $$ values (tests.user_id('es-researcher@example.test'), 'es-researcher') $$,
  'the one comment in their project is attributed to them, by the server');

-- ---------------------------------------------------------------------------
-- 6. Get into somebody else's project
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'insert a membership row',
             $q$ insert into public.project_members (project_id, user_id, role)
                 values ('proj_90000000-0000-4000-8000-000000000002', auth.uid(), 'owner') $q$),
         (2, 'set_project_member_role on themselves',
             $q$ select public.set_project_member_role('proj_90000000-0000-4000-8000-000000000002', auth.uid(), 'owner') $q$),
         (3, 'invite themselves',
             $q$ select public.invite_project_member('proj_90000000-0000-4000-8000-000000000002',
                                                    'es-researcher@example.test', 'editor') $q$),
         (4, 'accept an invitation addressed to somebody else',
             $q$ select public.accept_project_invitation((select s.v::uuid from seen s where s.k = 'invitation')) $q$),
         (5, 'cancel that invitation',
             $q$ select public.cancel_project_invitation((select s.v::uuid from seen s where s.k = 'invitation')) $q$),
         (6, 'create a project with the same id',
             $q$ select public.create_project('proj_90000000-0000-4000-8000-000000000002', 'Mine Now', 'rct') $q$),
         (7, 'make themselves its creator',
             $q$ update public.projects set owner_id = auth.uid()
                  where id = 'proj_90000000-0000-4000-8000-000000000002' $q$),
         (8, 'push content into it',
             $q$ select public.put_project_content('proj_90000000-0000-4000-8000-000000000002',
                                                  '{"stepData":{},"stepStatus":{}}', 0, 1) $q$),
         (9, 'read its content',
             $q$ select public.get_project_content('proj_90000000-0000-4000-8000-000000000002') $q$),
         (10, 'delete it',
             $q$ select public.delete_project('proj_90000000-0000-4000-8000-000000000002') $q$),
         (11, 'add a member by email',
             $q$ select public.add_project_member('proj_90000000-0000-4000-8000-000000000002',
                                                 'es-researcher@example.test', 'owner') $q$)
       ) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('insert a membership row', '42501'),
            ('set_project_member_role on themselves', 'not_found'),
            ('invite themselves', 'not_found'),
            ('accept an invitation addressed to somebody else', 'not_found'),
            ('cancel that invitation', 'not_found'),
            ('create a project with the same id', 'conflict'),
            ('make themselves its creator', '42501'),
            ('push content into it', 'not_found'),
            ('read its content', 'not_found'),
            ('delete it', 'not_found'),
            ('add a member by email', '42883') $$,
  'there is no way into somebody else''s project: every attempt is refused, and add_project_member does not exist');
select is(
  (select array_agg(p ->> 'id') from jsonb_array_elements(public.list_my_projects() -> 'projects') p),
  array['proj_90000000-0000-4000-8000-000000000001'],
  'the other project stays invisible to them: their project list is their own project and nothing else');
select is(pg_temp.member_role('proj_90000000-0000-4000-8000-000000000002', 'es-researcher@example.test'), null,
  'and they are not a member of it');
-- Owning a project is not an instance role.
select is(
  pg_temp.probe($$ select public.set_project_member_role('proj_90000000-0000-4000-8000-000000000001', auth.uid(), 'admin') $$),
  'invalid_role', 'a project owner cannot give themselves an instance role through the project');

-- ---------------------------------------------------------------------------
-- 7. Call any admin or master admin function
-- ---------------------------------------------------------------------------
-- Each one called with nothing but nulls: the role check comes before any
-- argument is looked at, so a researcher learns nothing from them.
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname ~ '^(admin|master)_'), 14,
  'the loop below calls all fourteen admin and master functions');
select is(
  pg_temp.probe(format('select public.%I(%s)', p.proname,
                       array_to_string(array_fill('null'::text, array[p.pronargs]), ', '))),
  'forbidden',
  p.proname || ': forbidden for a researcher, before any argument is looked at')
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname ~ '^(admin|master)_'
 order by p.proname;

-- ---------------------------------------------------------------------------
-- 8. Run the master admin bootstrap
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.bootstrap_master_admin('es-researcher@example.test') $$, '42501', null,
  'a signed-in researcher cannot run the bootstrap');
select throws_ok(
  $$ select private.bootstrap_master_admin('es-researcher@example.test', true) $$, '42501', null,
  'nor with force');
select throws_ok(
  $$ select * from private.bootstrap_master_admin(p_email => 'es-researcher@example.test', p_force => true) $$,
  '42501', null, 'nor called any other way');
select hasnt_function('public', 'bootstrap_master_admin', 'and there is nothing by that name in the exposed schema');

select tests.logout();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is(current_user::text, 'service_role', 'the next attempts are made as service_role, the role of the secret key');
select throws_ok(
  $$ select private.bootstrap_master_admin('es-researcher@example.test', true) $$, '42501', null,
  'the secret key cannot run the bootstrap');
select results_eq(
  $$ select t.n, pg_temp.probe(t.sql)
       from (values
         (1, $q$ select public.master_set_role('00000000-0000-4000-8000-000000000000', 'master_admin') $q$),
         (2, $q$ select public.admin_list_users() $q$),
         (3, $q$ update public.profiles set role = 'master_admin' $q$),
         (4, $q$ select * from public.profiles $q$),
         (5, $q$ select * from public.audit_log $q$),
         (6, $q$ select * from public.projects $q$),
         (7, $q$ insert into public.audit_log (action) values ('forged') $q$),
         (8, $q$ select private.write_audit(null, 'forged') $q$)) t (n, sql)
      order by t.n $$,
  $$ values (1, '42501'), (2, '42501'), (3, '42501'), (4, '42501'), (5, '42501'), (6, '42501'), (7, '42501'), (8, '42501') $$,
  'the secret key''s role can call no function and read or write no table: it is for the Auth admin API only');
select tests.logout();

select tests.as_anon();
select throws_ok(
  $$ select private.bootstrap_master_admin('es-researcher@example.test', true) $$, '42501', null,
  'a visitor without an account cannot run the bootstrap');
select tests.logout();

-- ---------------------------------------------------------------------------
-- After part one: nothing moved
-- ---------------------------------------------------------------------------
select is(pg_temp.changed_profiles(), '', 'no profile changed: not a role, a status, an email or a name');
select is(pg_temp.role_of('es-researcher@example.test'), 'researcher/active', 'the researcher is still a researcher');
select is((select count(*) from private.admin_intents), (select intents from counts_before),
  'no admin intent was recorded');
select is(
  (select count(*) from public.audit_log where action <> 'auth.email_changed'),
  (select audit_rows from counts_before),
  'no audit row was added (other than Auth''s own record of the email moved in this test)');
select is(
  (select row(s.org_name, s.support_email, s.footer_contact, s.accent, s.enabled_study_types)::text
     from public.instance_settings s where s.id = 1),
  (select settings from counts_before), 'the settings are unchanged');
select is(
  (select count(*)::integer from public.project_members
    where project_id = 'proj_90000000-0000-4000-8000-000000000002'), 1,
  'the other project still has exactly its owner');

-- ===========================================================================
-- PART TWO: an admin
-- ===========================================================================

select tests.login_as('es-admin@example.test');
select ok(private.is_admin() and not private.is_master(), 'the caller is an admin, and not a master admin');

-- Manage another admin, or a master admin.
select results_eq(
  $$ select f.name, t.who, pg_temp.probe(format(f.sql, t.email))
       from (values
         (1, 'admin_update_user',        'select public.admin_update_user(tests.user_id(%L), ''{"name":"Renamed"}'')'),
         (2, 'admin_update_user (role)', 'select public.admin_update_user(tests.user_id(%L), ''{"role":"researcher"}'')'),
         (3, 'admin_set_user_status',    'select public.admin_set_user_status(tests.user_id(%L), ''suspended'')'),
         (4, 'admin_soft_delete_user',   'select public.admin_soft_delete_user(tests.user_id(%L))'),
         (5, 'admin_revoke_sessions',    'select public.admin_revoke_sessions(tests.user_id(%L))'),
         (6, 'admin_begin_email_change', 'select public.admin_begin_email_change(tests.user_id(%L), ''es-takeover@example.test'')'),
         (7, 'admin_check_user_action',  'select public.admin_check_user_action(tests.user_id(%L), ''activate'')')
       ) f (n, name, sql)
      cross join (values (1, 'another admin', 'es-admin2@example.test'),
                         (2, 'a master admin', 'es-master@example.test'),
                         (3, 'themselves', 'es-admin@example.test')) t (n, who, email)
      order by t.n, f.n $$,
  $$ values
       ('admin_update_user', 'another admin', 'forbidden'), ('admin_update_user (role)', 'another admin', 'forbidden'),
       ('admin_set_user_status', 'another admin', 'forbidden'), ('admin_soft_delete_user', 'another admin', 'forbidden'),
       ('admin_revoke_sessions', 'another admin', 'forbidden'), ('admin_begin_email_change', 'another admin', 'forbidden'),
       ('admin_check_user_action', 'another admin', 'forbidden'),
       ('admin_update_user', 'a master admin', 'forbidden'), ('admin_update_user (role)', 'a master admin', 'forbidden'),
       ('admin_set_user_status', 'a master admin', 'forbidden'), ('admin_soft_delete_user', 'a master admin', 'forbidden'),
       ('admin_revoke_sessions', 'a master admin', 'forbidden'), ('admin_begin_email_change', 'a master admin', 'forbidden'),
       ('admin_check_user_action', 'a master admin', 'forbidden'),
       ('admin_update_user', 'themselves', 'forbidden'), ('admin_update_user (role)', 'themselves', 'forbidden'),
       ('admin_set_user_status', 'themselves', 'forbidden'), ('admin_soft_delete_user', 'themselves', 'forbidden'),
       ('admin_revoke_sessions', 'themselves', 'forbidden'), ('admin_begin_email_change', 'themselves', 'forbidden'),
       ('admin_check_user_action', 'themselves', 'forbidden') $$,
  'an admin cannot manage another admin, a master admin or their own account: forbidden, every function');

-- Hand out the admin role.
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('es-other@example.test'), '{"role":"admin"}') $$,
  'forbidden_role', 403, 'an admin cannot make a researcher an admin: forbidden_role');
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('es-other@example.test'), '{"role":"master_admin"}') $$,
  'forbidden_role', 403, 'nor a master admin');
select tests.throws_code(
  $$ select public.admin_begin_invite('es-crony@example.test', 'admin') $$,
  'forbidden_role', 403, 'an admin cannot invite an admin: forbidden_role');
select tests.throws_code(
  $$ select public.admin_begin_invite('es-crony@example.test', 'master_admin') $$,
  'forbidden_role', 403, 'nor a master admin');
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('es-admin@example.test'), '{"role":"master_admin"}') $$,
  'forbidden', 403, 'an admin cannot promote themselves');

-- The master surface, and every other way up.
select results_eq(
  $$ select t.attempt, pg_temp.probe(t.sql)
       from (values
         (1, 'master_set_role on a researcher',
             $q$ select public.master_set_role(tests.user_id('es-other@example.test'), 'admin') $q$),
         (2, 'master_set_role on themselves',
             $q$ select public.master_set_role(auth.uid(), 'master_admin') $q$),
         (3, 'master_list_admins', $q$ select public.master_list_admins() $q$),
         (4, 'invite on the master surface',
             $q$ select public.admin_begin_invite('es-crony@example.test', 'admin', null, null, 'master') $q$),
         (5, 'suspend a master admin on the master surface',
             $q$ select public.admin_set_user_status(tests.user_id('es-master@example.test'), 'suspended', 'master') $q$),
         (6, 'delete a master admin on the master surface',
             $q$ select public.admin_soft_delete_user(tests.user_id('es-master@example.test'), 'master') $q$),
         (7, 'the bootstrap',
             $q$ select private.bootstrap_master_admin('es-admin@example.test', true) $q$),
         (8, 'write their own role',
             $q$ update public.profiles set role = 'master_admin' where id = auth.uid() $q$),
         (9, 'write somebody else''s role',
             $q$ update public.profiles set role = 'researcher' where role = 'master_admin' $q$),
         (10, 'delete a master admin''s profile',
             $q$ delete from public.profiles where role = 'master_admin' $q$),
         (11, 'erase their tracks',
             $q$ delete from public.audit_log where actor_id = auth.uid() $q$),
         (12, 'forge an audit row',
             $q$ insert into public.audit_log (actor_id, action) values (tests.user_id('es-admin2@example.test'), 'admin.user_deleted') $q$),
         (13, 'record an intent of their own',
             $q$ insert into private.admin_intents (kind, actor_id, email, payload)
                 values ('invite', auth.uid(), 'es-crony@example.test', '{"role":"master_admin"}') $q$),
         (14, 'call the role helper directly',
             $q$ select private.require_role('master_admin') $q$),
         (15, 'call the target helper directly',
             $q$ select private.admin_target(null, auth.uid(), true) $q$)
       ) t (n, attempt, sql)
      order by t.n $$,
  $$ values ('master_set_role on a researcher', 'forbidden'), ('master_set_role on themselves', 'forbidden'),
            ('master_list_admins', 'forbidden'), ('invite on the master surface', 'forbidden'),
            ('suspend a master admin on the master surface', 'forbidden'),
            ('delete a master admin on the master surface', 'forbidden'),
            ('the bootstrap', '42501'), ('write their own role', '42501'),
            ('write somebody else''s role', '42501'), ('delete a master admin''s profile', '42501'),
            ('erase their tracks', '42501'), ('forge an audit row', '42501'),
            ('record an intent of their own', '42501'), ('call the role helper directly', '42501'),
            ('call the target helper directly', '42501') $$,
  'an admin has no way up: not the master surface, not the bootstrap, not the tables, not the helpers');

-- An instance admin is not a member of anybody's project.
select results_eq(
  $$ select t.n, pg_temp.probe(t.sql)
       from (values
         (1, $q$ select public.get_project('proj_90000000-0000-4000-8000-000000000001') $q$),
         (2, $q$ select public.get_project_content('proj_90000000-0000-4000-8000-000000000001') $q$),
         (3, $q$ select public.list_project_comments('proj_90000000-0000-4000-8000-000000000001') $q$),
         (4, $q$ select public.delete_project('proj_90000000-0000-4000-8000-000000000001') $q$)) t (n, sql)
      order by t.n $$,
  $$ values (1, 'not_found'), (2, 'not_found'), (3, 'not_found'), (4, 'not_found') $$,
  'being an admin opens nobody''s project');
select throws_ok($$ select 1 from public.projects $$, '42501', null, 'an admin who is in no project reads no project row');
select throws_ok($$ select 1 from public.project_comments $$, '42501', null, 'and no comment');

-- Taking an account over through its address. An email change takes effect at
-- once, and whoever reads the new mailbox then gets in with "Forgot password".
-- So an admin cannot move the address of an account that is in use, whatever
-- its role. What an admin IS allowed to do stays inside the matrix and inside
-- that limit: correcting the address of an account nobody can use yet.
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(tests.user_id('es-other@example.test'), 'es-takeover@example.test') $$),
  'forbidden', 'an admin cannot take over a researcher''s account through its address: an account in use is not theirs to move');
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(tests.user_id('es-master2@example.test'), 'es-takeover@example.test') $$),
  'forbidden', 'nor a master admin''s: no way to take over a higher account through its address');
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(tests.user_id('es-invited@example.test'), 'es-takeover@example.test') $$),
  'ok', 'an admin may start an email change for an invited account that has no password yet (audited, and inside the matrix)');
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(tests.user_id('es-unconfirmed@example.test'), 'es-takeover@example.test') $$),
  'ok', 'and for a sign-up that was never confirmed');

-- The one role that may move an account in use is the one that already has
-- full control of the instance.
select tests.login_as('es-master@example.test');
select is(
  pg_temp.probe($$ select public.admin_begin_email_change(tests.user_id('es-other@example.test'), 'es-takeover@example.test') $$),
  'ok', 'a master admin may start an email change for an account that is in use');

select tests.logout();

-- ---------------------------------------------------------------------------
-- After part two: nothing moved
-- ---------------------------------------------------------------------------
select is(pg_temp.changed_profiles(), '', 'no profile changed in part two either');
select results_eq(
  $$ select s.role, count(*)::integer
       from snapshot s join public.profiles p on p.id = s.id and p.role = s.role
      group by s.role order by s.role $$,
  $$ values ('admin', 2), ('master_admin', 2), ('researcher', 6) $$,
  'the admin tier is exactly who it was');
select is((select count(*) from private.admin_intents), (select intents from counts_before),
  'no admin intent is left behind');

select * from finish();
rollback;
