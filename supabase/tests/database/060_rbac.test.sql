-- Role-based access to the admin and master admin functions.
--
-- Legacy parity (old server, rbac.test.ts): a researcher is kept out of both
-- surfaces while self-service still works; an admin manages researchers and
-- supervisors, cannot manage other admins or hand out the admin role, and is
-- kept out of the master surface; a master admin reaches everything.
--
-- This file is about who gets in. What each function then does is 065
-- (accounts), 075 (settings) and 080 (the first master admin).
--
-- One function asks more than the role: admin_begin_email_change. An account
-- that is in use (address confirmed, password set) can only be moved by a
-- master admin, because whoever reads the new mailbox can take the account
-- over. An admin may still move an account nobody can use yet. The cells for
-- that function say so below; the rule itself is 067.
--
-- Calls that are expected to succeed run through pg_temp.probe(), which
-- reports the outcome and then undoes the call. So every cell below is asked of
-- the same untouched accounts, and the order of the cells does not matter.

begin;
select plan(181);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('rb-researcher@example.test');
select tests.create_user('rb-supervisor@example.test', 'supervisor');
select tests.create_user('rb-admin@example.test', 'admin');
select tests.create_user('rb-master@example.test', 'master_admin');

-- Accounts that are refused whatever their role. All four are master admins,
-- so a refusal can only be about the state of the account.
select tests.create_user('rb-suspended@example.test', 'master_admin');
select tests.create_user('rb-invited@example.test', 'master_admin', false);
select tests.create_user('rb-deleted@example.test', 'master_admin');
select tests.create_user('rb-revoked@example.test', 'master_admin');

-- The accounts acted on, one per instance role. All four are in use: their
-- address is confirmed and they have a password.
select tests.create_user('rb-t-researcher@example.test');
select tests.create_user('rb-t-supervisor@example.test', 'supervisor');
select tests.create_user('rb-t-admin@example.test', 'admin');
select tests.create_user('rb-t-master_admin@example.test', 'master_admin');

-- Two researchers nobody can use yet: one was invited and has not set a
-- password, one signed up and never confirmed the address.
select tests.create_user('rb-t-invited@example.test', 'researcher', false);
select tests.create_user('rb-t-unconfirmed@example.test');
update auth.users set email_confirmed_at = null where id = tests.user_id('rb-t-unconfirmed@example.test');

update public.profiles set status = 'suspended' where email = 'rb-suspended@example.test';
update public.profiles set status = 'deleted', email = null where id = tests.user_id('rb-deleted@example.test');

create temp table settings_before as select org_name from public.instance_settings where id = 1;

-- One call of every admin and master function. TARGET stands for the address
-- of the account acted on. Functions that take a surface appear once for each.
create temp table rpc_calls (
  n       integer generated always as identity primary key,
  name    text not null,
  surface text not null,
  sql     text not null
);
grant select on rpc_calls to authenticated, anon;

insert into rpc_calls (name, surface, sql) values
  ('admin_list_users',         'admin',  $$ select public.admin_list_users() $$),
  ('admin_get_user',           'admin',  $$ select public.admin_get_user(tests.user_id('TARGET')) $$),
  ('admin_update_user',        'admin',  $$ select public.admin_update_user(tests.user_id('TARGET'), '{"name":"Changed"}') $$),
  ('admin_revoke_sessions',    'admin',  $$ select public.admin_revoke_sessions(tests.user_id('TARGET')) $$),
  ('admin_begin_invite',       'admin',  $$ select public.admin_begin_invite('rb-new@example.test', 'researcher') $$),
  ('admin_begin_email_change', 'admin',  $$ select public.admin_begin_email_change(tests.user_id('TARGET'), 'rb-moved@example.test') $$),
  ('admin_check_user_action',  'admin',  $$ select public.admin_check_user_action(tests.user_id('TARGET'), 'activate') $$),
  ('admin_set_user_status',    'admin',  $$ select public.admin_set_user_status(tests.user_id('TARGET'), 'suspended') $$),
  ('admin_soft_delete_user',   'admin',  $$ select public.admin_soft_delete_user(tests.user_id('TARGET')) $$),
  ('admin_list_audit',         'admin',  $$ select public.admin_list_audit() $$),
  ('admin_get_settings',       'admin',  $$ select public.admin_get_settings() $$),
  ('admin_update_settings',    'admin',  $$ select public.admin_update_settings('{"orgName":"Changed"}') $$),
  ('master_list_admins',       'master', $$ select public.master_list_admins() $$),
  ('master_set_role',          'master', $$ select public.master_set_role(tests.user_id('TARGET'), 'supervisor') $$),
  ('admin_begin_invite',       'master', $$ select public.admin_begin_invite('rb-new-admin@example.test', 'admin', null, null, 'master') $$),
  ('admin_check_user_action',  'master', $$ select public.admin_check_user_action(tests.user_id('TARGET'), 'activate', 'master') $$),
  ('admin_set_user_status',    'master', $$ select public.admin_set_user_status(tests.user_id('TARGET'), 'suspended', 'master') $$),
  ('admin_soft_delete_user',   'master', $$ select public.admin_soft_delete_user(tests.user_id('TARGET'), 'master') $$);

-- The call, aimed at the target account with that instance role (or at one of
-- the two accounts that are not in use: 'invited', 'unconfirmed').
create function pg_temp.aimed(p_sql text, p_target_role text default 'researcher') returns text
language sql as $$
  select replace(p_sql, 'TARGET', 'rb-t-' || p_target_role || '@example.test');
$$;

-- Run a statement as the current caller and say how it ended: 'ok', the code
-- of the error the backend raised, or the SQLSTATE of any other error. Whatever
-- the statement did is undone before returning.
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

grant execute on function pg_temp.aimed(text, text), pg_temp.probe(text) to authenticated, anon;

-- ===========================================================================
-- The calls above are the whole administrative surface
-- ===========================================================================

select set_eq(
  $$ select distinct c.name from rpc_calls c $$,
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname ~ '^(admin|master)_' $$,
  'the calls in this file cover every admin_ and master_ function in public');

select set_eq(
  $$ select c.name from rpc_calls c where c.surface = 'master' and c.name like 'admin\_%' $$,
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and 'p_surface' = any (p.proargnames) $$,
  'every function that takes a surface is also called on the master surface');

-- ===========================================================================
-- Researcher and supervisor: kept out of both surfaces (rbac.test.ts 1)
-- ===========================================================================

select tests.login_as('rb-researcher@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select tests.throws_code(pg_temp.aimed(c.sql), 'forbidden', 403,
         c.name || ' (' || c.surface || ' surface): forbidden for a researcher')
  from rpc_calls c order by c.n;

select is(public.my_profile() -> 'user' ->> 'role', 'researcher',
  'a researcher''s self-service still works');

-- The instance role "supervisor" grants nothing administrative.
select tests.login_as('rb-supervisor@example.test');
select tests.throws_code(pg_temp.aimed(c.sql), 'forbidden', 403,
         c.name || ' (' || c.surface || ' surface): forbidden for a supervisor')
  from rpc_calls c order by c.n;

-- ===========================================================================
-- Admin: the admin surface, never the master surface (rbac.test.ts 2)
-- ===========================================================================

select tests.login_as('rb-admin@example.test');

-- The researcher aimed at is in use, so the email change is the one call an
-- admin is refused here.
select is(pg_temp.probe(pg_temp.aimed(c.sql)),
         case c.name when 'admin_begin_email_change' then 'forbidden' else 'ok' end,
         c.name || case c.name
                     when 'admin_begin_email_change'
                     then ': an admin may NOT call it for a researcher whose account is in use (master admin only)'
                     else ': an admin may call it for a researcher'
                   end)
  from rpc_calls c where c.surface = 'admin' order by c.n;

select tests.throws_code(pg_temp.aimed(c.sql), 'forbidden', 403,
         c.name || ' (master surface): forbidden for an admin')
  from rpc_calls c where c.surface = 'master' order by c.n;

-- Who an admin may act on: researchers and supervisors. Reading is not
-- managing, so admin_get_user answers for anyone. All four accounts are in
-- use, so admin_begin_email_change is forbidden in every cell: for the admin
-- tier by the role, for a researcher and a supervisor because moving the
-- address of an account in use is a master admin's action.
select results_eq(
  $$ select c.name, r.role, pg_temp.probe(pg_temp.aimed(c.sql, r.role))
       from rpc_calls c
      cross join unnest(array['researcher', 'supervisor', 'admin', 'master_admin']) with ordinality as r (role, rn)
      where c.surface = 'admin' and c.sql like '%TARGET%'
      order by c.n, r.rn $$,
  $$ values
       ('admin_get_user',           'researcher', 'ok'), ('admin_get_user',           'supervisor', 'ok'),
       ('admin_get_user',           'admin',      'ok'), ('admin_get_user',           'master_admin', 'ok'),
       ('admin_update_user',        'researcher', 'ok'), ('admin_update_user',        'supervisor', 'ok'),
       ('admin_update_user',        'admin', 'forbidden'), ('admin_update_user',      'master_admin', 'forbidden'),
       ('admin_revoke_sessions',    'researcher', 'ok'), ('admin_revoke_sessions',    'supervisor', 'ok'),
       ('admin_revoke_sessions',    'admin', 'forbidden'), ('admin_revoke_sessions',  'master_admin', 'forbidden'),
       ('admin_begin_email_change', 'researcher', 'forbidden'), ('admin_begin_email_change', 'supervisor', 'forbidden'),
       ('admin_begin_email_change', 'admin', 'forbidden'), ('admin_begin_email_change', 'master_admin', 'forbidden'),
       ('admin_check_user_action',  'researcher', 'ok'), ('admin_check_user_action',  'supervisor', 'ok'),
       ('admin_check_user_action',  'admin', 'forbidden'), ('admin_check_user_action', 'master_admin', 'forbidden'),
       ('admin_set_user_status',    'researcher', 'ok'), ('admin_set_user_status',    'supervisor', 'ok'),
       ('admin_set_user_status',    'admin', 'forbidden'), ('admin_set_user_status',  'master_admin', 'forbidden'),
       ('admin_soft_delete_user',   'researcher', 'ok'), ('admin_soft_delete_user',   'supervisor', 'ok'),
       ('admin_soft_delete_user',   'admin', 'forbidden'), ('admin_soft_delete_user', 'master_admin', 'forbidden') $$,
  'an admin manages researchers and supervisors, and no admin or master admin (canManageRole, cell by cell); the email of an account in use is nobody''s but a master admin''s to change');

-- The other half of that rule: the same call is open to an admin while nobody
-- can use the account yet. Every other admin function ignores that state.
select results_eq(
  $$ select t.target, pg_temp.probe(pg_temp.aimed(c.sql, t.target))
       from rpc_calls c
      cross join unnest(array['researcher', 'supervisor', 'invited', 'unconfirmed']) with ordinality as t (target, n)
      where c.name = 'admin_begin_email_change'
      order by t.n $$,
  $$ values ('researcher',  'forbidden'),
            ('supervisor',  'forbidden'),
            ('invited',     'ok'),
            ('unconfirmed', 'ok') $$,
  'admin_begin_email_change, for an admin: refused for an account in use, allowed for an invited account without a password and for an unconfirmed sign-up');

-- An admin is an admin, so an admin cannot manage their own account this way.
select results_eq(
  $$ select c.name, pg_temp.probe(replace(c.sql, 'TARGET', 'rb-admin@example.test'))
       from rpc_calls c
      where c.surface = 'admin' and c.sql like '%TARGET%' and c.name <> 'admin_get_user'
      order by c.n $$,
  $$ values ('admin_update_user', 'forbidden'), ('admin_revoke_sessions', 'forbidden'),
            ('admin_begin_email_change', 'forbidden'), ('admin_check_user_action', 'forbidden'),
            ('admin_set_user_status', 'forbidden'), ('admin_soft_delete_user', 'forbidden') $$,
  'an admin cannot manage their own account through the admin functions');

-- Which roles an admin may hand out: researcher and supervisor.
select results_eq(
  $$ select r.role,
            pg_temp.probe(format(
              'select public.admin_update_user(tests.user_id(''rb-t-researcher@example.test''), %L)',
              jsonb_build_object('role', r.role))),
            pg_temp.probe(format(
              'select public.admin_update_user(tests.user_id(''rb-t-supervisor@example.test''), %L)',
              jsonb_build_object('role', r.role))),
            pg_temp.probe(format('select public.admin_begin_invite(''rb-role@example.test'', %L)', r.role))
       from unnest(array['researcher', 'supervisor', 'admin', 'master_admin', 'owner']) with ordinality as r (role, rn)
      order by r.rn $$,
  $$ values ('researcher',   'ok',             'ok',             'ok'),
            ('supervisor',   'ok',             'ok',             'ok'),
            ('admin',        'forbidden_role', 'forbidden_role', 'forbidden_role'),
            ('master_admin', 'forbidden_role', 'forbidden_role', 'forbidden_role'),
            ('owner',        'invalid_role',   'invalid_role',   'invalid_role') $$,
  'an admin assigns researcher and supervisor, and is refused admin and master_admin with forbidden_role (rbac.test.ts 2)');

select tests.throws_code(
  $$ select public.admin_begin_invite('rb-a2@example.test', 'admin') $$, 'forbidden_role', 403,
  'an admin cannot mint another admin: forbidden_role, HTTP 403');
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('rb-admin@example.test'), '{"role":"master_admin"}') $$,
  'forbidden', 403,
  'an admin cannot promote themselves');
-- The target is checked before the role, as the legacy route did.
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('rb-t-admin@example.test'), '{"role":"master_admin"}') $$,
  'forbidden', 403,
  'an admin changing another admin''s role is forbidden (the target), not forbidden_role');
select tests.throws_code(
  $$ select public.admin_update_user(tests.user_id('rb-t-admin@example.test'), '{"role":"owner"}') $$,
  'forbidden', 403,
  'an admin learns nothing about a patch aimed at an account they may not manage');

-- ===========================================================================
-- Master admin: everything (rbac.test.ts 3)
-- ===========================================================================

select tests.login_as('rb-master@example.test');

select is(pg_temp.probe(pg_temp.aimed(c.sql)), 'ok',
         c.name || ' (' || c.surface || ' surface): a master admin may call it')
  from rpc_calls c order by c.n;

-- Including the email of an account that is in use, which is theirs alone to
-- change, and the two accounts nobody can use yet.
select is(
  (select count(*)::integer
     from rpc_calls c
    cross join unnest(array['researcher', 'supervisor', 'admin', 'master_admin', 'invited', 'unconfirmed']) as r (role)
    where c.sql like '%TARGET%'
      and pg_temp.probe(pg_temp.aimed(c.sql, r.role)) = 'ok'),
  (select 6 * count(*)::integer from rpc_calls c where c.sql like '%TARGET%'),
  'a master admin may act on an account of any role, in use or not, on both surfaces');

select results_eq(
  $$ select r.role,
            pg_temp.probe(format(
              'select public.admin_update_user(tests.user_id(''rb-t-researcher@example.test''), %L)',
              jsonb_build_object('role', r.role))),
            pg_temp.probe(format('select public.admin_begin_invite(''rb-role@example.test'', %L)', r.role)),
            pg_temp.probe(format(
              'select public.master_set_role(tests.user_id(''rb-t-researcher@example.test''), %L)', r.role)),
            pg_temp.probe(format(
              'select public.admin_begin_invite(''rb-role@example.test'', %L, null, null, ''master'')', r.role))
       from unnest(array['researcher', 'supervisor', 'admin', 'master_admin', 'owner']) with ordinality as r (role, rn)
      order by r.rn $$,
  $$ values ('researcher',   'ok', 'ok', 'ok', 'invalid_role'),
            ('supervisor',   'ok', 'ok', 'ok', 'invalid_role'),
            ('admin',        'ok', 'ok', 'ok', 'ok'),
            ('master_admin', 'ok', 'ok', 'ok', 'ok'),
            ('owner',        'invalid_role', 'invalid_role', 'invalid_role', 'invalid_role') $$,
  'a master admin assigns any instance role; invitations on the master surface are for the admin tier only');

-- ===========================================================================
-- Accounts that are refused whatever their role
-- ===========================================================================

select tests.login_as('rb-suspended@example.test');
select tests.throws_code(pg_temp.aimed(c.sql), 'account_suspended', 403,
         c.name || ' (' || c.surface || ' surface): refused for a suspended master admin')
  from rpc_calls c order by c.n;

-- Invited as a master admin: the role is worth nothing until a password is set.
select tests.login_as('rb-invited@example.test');
select tests.throws_code(pg_temp.aimed(c.sql), 'password_reset_required', 403,
         c.name || ' (' || c.surface || ' surface): refused before the invited master admin sets a password')
  from rpc_calls c order by c.n;

select tests.login_as('rb-deleted@example.test');
select tests.throws_code(pg_temp.aimed(c.sql), 'unauthenticated', 401,
         c.name || ' (' || c.surface || ' surface): refused for a deleted master admin')
  from rpc_calls c order by c.n;

select tests.login_as('rb-revoked@example.test');
select is(pg_temp.probe($$ select public.master_list_admins() $$), 'ok',
  'a master admin with a live session gets in');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('rb-revoked@example.test');
select tests.resume_as('rb-revoked@example.test');
select tests.throws_code(pg_temp.aimed(c.sql), 'unauthenticated', 401,
         c.name || ' (' || c.surface || ' surface): refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(pg_temp.aimed(c.sql), '42501', null,
         c.name || ' (' || c.surface || ' surface): not callable without an account')
  from rpc_calls c order by c.n;
select tests.logout();

-- ===========================================================================
-- None of it left a trace
-- ===========================================================================

select results_eq(
  $$ select email, name, role, status from public.profiles where email like 'rb-t-%' order by email $$,
  $$ values ('rb-t-admin@example.test',        '', 'admin',        'active'),
            ('rb-t-invited@example.test',      '', 'researcher',   'active'),
            ('rb-t-master_admin@example.test', '', 'master_admin', 'active'),
            ('rb-t-researcher@example.test',   '', 'researcher',   'active'),
            ('rb-t-supervisor@example.test',   '', 'supervisor',   'active'),
            ('rb-t-unconfirmed@example.test',  '', 'researcher',   'active') $$,
  'no refused call changed an account');
select is_empty(
  $$ select 1 from private.admin_intents i where i.email like 'rb-%' $$,
  'no refused call recorded an invitation or an email change');
select is_empty(
  $$ select a.action from public.audit_log a
      where a.actor_id in (select p.id from public.profiles p
                            where p.email like 'rb-%' or p.id = tests.user_id('rb-deleted@example.test')) $$,
  'no refused call wrote an audit row');
select is(
  (select org_name from public.instance_settings where id = 1),
  (select org_name from settings_before),
  'no refused call changed the settings');

select * from finish();
rollback;
