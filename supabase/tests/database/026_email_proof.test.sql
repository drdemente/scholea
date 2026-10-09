-- Whose address is it, and who asked for the change (migration 18).
--
-- 1. An address somebody else typed in is not a confirmed address. An
--    administrator may change an account's email at once and without a code.
--    The account keeps working, but until its holder types a code that Auth
--    emailed to the new address it has no CONFIRMED address: it is shown no
--    project invitation and can accept none. Without this an administrator
--    could move an account they control onto any invited address and walk
--    into the project. A code that Auth sent to an EARLIER address of the
--    account proves nothing, although Auth still accepts it after the change.
--
--    Since migration 20 only a master admin may change the address of an
--    account that is in use (067). An admin may still correct the address of
--    an account nobody can use yet. So the changes below are asked for by a
--    master admin wherever the account is in use, and by an admin where it is
--    still waiting for its invitation code.
--
-- 2. The audit record of an email change or an invitation names the
--    administrator who asked for it, and nobody can steer that: not by asking
--    for the same address again for another account, not by being the account
--    holder who makes the same change, not by overwriting another
--    administrator's request, and not after losing the right to ask.
--
-- Auth is simulated by writing to auth.users the way it does. The shapes below
-- were recorded from Auth on the local stack; the end-to-end tests
-- (supabase/functions/tests) run the same stories against the real service.

begin;
select plan(101);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
create temp table ids (k text primary key, id uuid not null);
grant select on ids to authenticated;

create function pg_temp.id(p_key text) returns uuid language sql stable as $$
  select i.id from ids i where i.k = p_key;
$$;

create function pg_temp.mk(p_key text, p_email text, p_role text default 'researcher', p_password_set boolean default true)
returns void language sql as $$
  insert into ids values (p_key, tests.create_user(p_email, p_role, p_password_set));
$$;

-- The admin API, and the dashboard, write the new address and nothing else.
create function pg_temp.auth_admin_sets_email(p_key text, p_email text) returns void language sql as $$
  update auth.users set email = p_email where id = pg_temp.id(p_key);
$$;

-- The account holder's own change. Auth keeps the new address in email_change
-- until the emailed code is typed, then moves it into email and empties
-- email_change, in one statement.
create function pg_temp.auth_holder_changes_email(p_key text, p_email text) returns void language plpgsql as $$
begin
  update auth.users
     set email_change = p_email, email_change_token_new = 'pending', email_change_token_current = 'pending'
   where id = pg_temp.id(p_key);
  update auth.users
     set email = email_change, email_change = '', email_change_token_new = '', email_change_token_current = ''
   where id = pg_temp.id(p_key);
end $$;

-- Auth's own note of a code it issued: its hash, and the address it mailed the
-- code to. One per account and kind of code; a new code replaces the old note.
-- p_sent_to defaults to the address the account has at that moment.
create function pg_temp.auth_notes_code(p_key text, p_kind text, p_hash text, p_sent_to text default null)
returns void language plpgsql as $$
begin
  delete from auth.one_time_tokens t
   where t.user_id = pg_temp.id(p_key) and t.token_type = p_kind::auth.one_time_token_type;
  insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to)
  select gen_random_uuid(), u.id, p_kind::auth.one_time_token_type, p_hash, coalesce(p_sent_to, u.email)
    from auth.users u where u.id = pg_temp.id(p_key);
end $$;

-- A password reset or sign-in code is asked for: Auth stores its hash on the
-- user, mails the code, and notes which address it mailed it to.
create function pg_temp.auth_code_requested(p_key text, p_sent_to text default null) returns void language plpgsql as $$
declare
  v_hash text := md5(gen_random_uuid()::text);
begin
  update auth.users set recovery_token = v_hash, recovery_sent_at = now() where id = pg_temp.id(p_key);
  perform pg_temp.auth_notes_code(p_key, 'recovery_token', v_hash, p_sent_to);
end $$;

-- ... and typed. Auth empties recovery_token in a statement of its own, drops
-- its note of the code, and records the sign-in, all in one transaction. (Auth
-- finds a code by its hash, whatever address the account has by then.)
create function pg_temp.auth_code_typed(p_key text) returns void language plpgsql as $$
begin
  update auth.users set recovery_token = '' where id = pg_temp.id(p_key);
  delete from auth.one_time_tokens t
   where t.user_id = pg_temp.id(p_key) and t.token_type = 'recovery_token';
  update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id(p_key);
end $$;

-- An invitation code is sent (or sent again) ...
create function pg_temp.auth_invite_code_sent(p_key text) returns void language plpgsql as $$
declare
  v_hash text := md5(gen_random_uuid()::text);
begin
  update auth.users set confirmation_token = v_hash, confirmation_sent_at = now() where id = pg_temp.id(p_key);
  perform pg_temp.auth_notes_code(p_key, 'confirmation_token', v_hash);
end $$;

-- ... and typed: Auth empties confirmation_token and gives the user a throwaway
-- password in one statement, confirms the address in the next, then records
-- the sign-in.
create function pg_temp.auth_invite_code_typed(p_key text) returns void language plpgsql as $$
begin
  update auth.users
     set confirmation_token = '',
         encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
   where id = pg_temp.id(p_key);
  update auth.users set email_confirmed_at = now() where id = pg_temp.id(p_key);
  delete from auth.one_time_tokens t
   where t.user_id = pg_temp.id(p_key) and t.token_type = 'confirmation_token';
  update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id(p_key);
end $$;

-- An invitation: a new user with no password.
create function pg_temp.auth_invites(p_key text, p_email text) returns void language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, invited_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, '', now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());
  insert into ids values (p_key, v_id);
end $$;

-- Every statement of this file runs in ONE transaction. Each call Auth makes is
-- a transaction of its own, and the trigger forgets at the end of a transaction
-- that it saw a code being used. That forgetting is done here by hand, wherever
-- the story moves on to a later request.
create function pg_temp.next_request() returns void language plpgsql as $$
begin
  perform set_config('scholea.code_typed', '', true);
end $$;

-- What the database holds about an account, read as the owner.
create function pg_temp.state(p_key text)
returns table (email text, unproven boolean, auth_confirmed boolean, shown_confirmed boolean)
language sql stable security definer as $$
  select p.email, p.email_unproven, u.email_confirmed_at is not null,
         (private.user_json(p) ->> 'emailConfirmed')::boolean
    from public.profiles p join auth.users u on u.id = p.id
   where p.id = (select i.id from ids i where i.k = p_key);
$$;

-- The audit rows about an account, oldest first, with the actor as a fixture key.
create function pg_temp.audit(p_key text)
returns table (actor text, action text, before_data jsonb, after_data jsonb)
language sql stable security definer as $$
  select (select i.k from ids i where i.id = a.actor_id), a.action, a.before_data, a.after_data
    from public.audit_log a
   where a.target_type = 'user' and a.target_id = (select i.id::text from ids i where i.k = p_key)
   order by a.created_at, a.id;
$$;

create function pg_temp.last_audit(p_key text)
returns table (actor text, action text, before_data jsonb, after_data jsonb)
language sql stable security definer as $$
  select (select i.k from ids i where i.id = a.actor_id), a.action, a.before_data, a.after_data
    from public.audit_log a
   where a.target_type = 'user' and a.target_id = (select i.id::text from ids i where i.k = p_key)
   order by a.created_at desc, a.id desc
   limit 1;
$$;

-- The intents recorded for an address: who asked, for which account.
create function pg_temp.intents(p_email text)
returns table (kind text, actor text, target text, role text)
language sql stable security definer as $$
  select n.kind,
         (select i.k from ids i where i.id = n.actor_id),
         (select i.k from ids i where i.id = n.target_id),
         n.payload ->> 'role'
    from private.admin_intents n where n.email = p_email;
$$;

grant execute on function pg_temp.id(text), pg_temp.audit(text), pg_temp.last_audit(text), pg_temp.intents(text)
  to authenticated;
grant execute on function pg_temp.state(text) to authenticated;

select pg_temp.mk('admin',   'ep-admin@example.test',   'admin');
select pg_temp.mk('admin2',  'ep-admin2@example.test',  'admin');
select pg_temp.mk('admin3',  'ep-admin3@example.test',  'admin');
select pg_temp.mk('master',  'ep-master@example.test',  'master_admin');
select pg_temp.mk('master2', 'ep-master2@example.test', 'master_admin');
select pg_temp.mk('master3', 'ep-master3@example.test', 'master_admin');
select pg_temp.mk('master4', 'ep-master4@example.test', 'master_admin');
select pg_temp.mk('res',     'ep-res@example.test');
select pg_temp.mk('owner',   'ep-owner@example.test');
select pg_temp.mk('puppet',  'ep-puppet@example.test');
select pg_temp.mk('puppet2', 'ep-puppet2@example.test');
select pg_temp.mk('victim',  'ep-victim@example.test', 'supervisor');
select pg_temp.mk('pending', 'ep-pending@example.test', 'researcher', false);
select pg_temp.mk('pending2', 'ep-pending2@example.test', 'researcher', false);
select pg_temp.mk('pending3', 'ep-pending3@example.test', 'researcher', false);
select pg_temp.mk('t1',      'ep-t1@example.test');
select pg_temp.mk('t2',      'ep-t2@example.test');
select pg_temp.mk('t3',      'ep-t3@example.test');
select pg_temp.mk('t4',      'ep-t4@example.test');
select pg_temp.mk('t5',      'ep-t5@example.test');
select pg_temp.mk('t6',      'ep-t6@example.test');
select pg_temp.mk('t7',      'ep-t7@example.test');
select pg_temp.mk('t8',      'ep-t8@example.test');
select pg_temp.mk('decoy',   'ep-decoy@example.test');

-- A private project, with two invitations waiting: one for an address nobody
-- has registered, one for an address that belongs to somebody.
select tests.login_as('ep-owner@example.test');
select public.create_project('proj_26000000-0000-4000-8000-000000000001', 'Secret Trial', 'rct') ->> 'ok' as project;
select public.put_project_content('proj_26000000-0000-4000-8000-000000000001',
  '{"stepData":{"a":"TOPSECRET"},"stepStatus":{}}', 0, 1000) ->> 'rev' as pushed;
create temp table inv (k text primary key, id uuid not null);
grant select on inv to authenticated;
insert into inv
select 'nobody', (public.invite_project_member('proj_26000000-0000-4000-8000-000000000001', 'ep-nobody@example.test', 'editor')
                    -> 'invitation' ->> 'id')::uuid;
insert into inv
select 'victim', (public.invite_project_member('proj_26000000-0000-4000-8000-000000000001', 'ep-victim@example.test', 'supervisor')
                    -> 'invitation' ->> 'id')::uuid;
select tests.logout();

-- ===========================================================================
-- 1. An address an administrator set is unproven
-- ===========================================================================

select results_eq(
  $$ select * from pg_temp.state('res') $$,
  $$ values ('ep-res@example.test', false, true, true) $$,
  'a confirmed account starts with a proven address');

select tests.login_as('ep-res@example.test');
select is(private.current_confirmed_email(), 'ep-res@example.test', 'and has a confirmed address');

select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('res'), 'ep-res-new@example.test') ->> 'changed', 'true',
  '(scene) a master admin asks for a researcher''s address to be changed');
select tests.logout();
select pg_temp.auth_admin_sets_email('res', 'ep-res-new@example.test');
select pg_temp.next_request();

select results_eq(
  $$ select * from pg_temp.state('res') $$,
  $$ values ('ep-res-new@example.test', true, true, false) $$,
  'admin change: the profile follows at once; Auth still calls the account confirmed; the address is unproven and shown as not confirmed');
select results_eq(
  $$ select * from pg_temp.last_audit('res') $$,
  $$ values ('master', 'admin.user_updated',
             '{"email":"ep-res@example.test"}'::jsonb, '{"email":"ep-res-new@example.test"}'::jsonb) $$,
  'admin change: audited as admin.user_updated by the master admin who asked, with the address before and after');

-- The person's session, opened before the change, goes on working.
select tests.resume_as('ep-res@example.test');
select is(public.my_profile() -> 'user' ->> 'email', 'ep-res-new@example.test',
  'admin change: the person stays signed in and sees the new address');
select is(public.my_profile() -> 'user' -> 'emailConfirmed', 'false'::jsonb,
  'admin change: my_profile says the address is not confirmed');
select is(private.current_confirmed_email(), null,
  'admin change: the account has no confirmed address');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb,
  'admin change: everything else about the account works as before');
select tests.login_as('ep-admin@example.test');
select is(public.admin_get_user(pg_temp.id('res')) -> 'user' -> 'emailConfirmed', 'false'::jsonb,
  'admin change: the Users screen shows the address as not confirmed');
select tests.logout();

-- What does NOT prove the address.
update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id('res');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('res')), true,
  'not proof: signing in with the password (it says nothing about the mailbox)');

select pg_temp.auth_code_requested('res');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('res')), true,
  'not proof: asking for a code');

-- A password change empties recovery_token too, together with the password.
update auth.users
   set recovery_token = '', recovery_sent_at = null,
       encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
 where id = pg_temp.id('res');
update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id('res');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('res')), true,
  'not proof: a password change, although it uses up a code that was sent to the new address');

-- A code used up without the sign-in that follows a typed code.
select pg_temp.auth_code_requested('res');
select pg_temp.next_request();
update auth.users set recovery_token = '' where id = pg_temp.id('res');
select pg_temp.next_request();
update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id('res');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('res')), true,
  'not proof: a code that disappears in one request and a sign-in in another');

-- A code Auth has no note of.
update auth.users set recovery_token = md5(gen_random_uuid()::text) where id = pg_temp.id('res');
delete from auth.one_time_tokens where user_id = pg_temp.id('res');
select pg_temp.next_request();
select pg_temp.auth_code_typed('res');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('res')), true,
  'not proof: a code of which Auth has no record of where it was sent');

-- What does: the holder types a code Auth emailed to the address.
select pg_temp.auth_code_requested('res');
select pg_temp.next_request();
select pg_temp.auth_code_typed('res');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('res') $$,
  $$ values ('ep-res-new@example.test', false, true, true) $$,
  'proof: a password reset or sign-in code that was sent to the new address, typed, makes it confirmed again');
select tests.login_as('ep-res-new@example.test');
select is(private.current_confirmed_email(), 'ep-res-new@example.test',
  'proof: and the account has a confirmed address again');
select tests.logout();

-- The way around that must stay closed. Whoever controls an account asks for a
-- code while it still has an address they can read, has the account moved to
-- somebody else's address, and then uses the old code: Auth finds a code by
-- its hash and signs them in. It was not sent to the new address.
select pg_temp.auth_code_requested('t1');
select pg_temp.next_request();
select pg_temp.auth_admin_sets_email('t1', 'ep-t1-set@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select t.relates_to, u.email::text, coalesce(u.recovery_token, '') <> ''
       from auth.one_time_tokens t join auth.users u on u.id = t.user_id where u.id = pg_temp.id('t1') $$,
  $$ values ('ep-t1@example.test', 'ep-t1-set@example.test', true) $$,
  '(scene) a code is waiting that was sent to the OLD address; the account has the new one');
select pg_temp.auth_code_typed('t1');
select pg_temp.next_request();
select results_eq(
  $$ select unproven, shown_confirmed from pg_temp.state('t1') $$, $$ values (true, false) $$,
  'not proof: a code that was sent to an earlier address, used after the address was changed');
select tests.login_as('ep-t1-set@example.test');
select is(private.current_confirmed_email(), null, 'and the account still has no confirmed address');
select tests.logout();

-- The same when the two requests cross: Auth read the old address, mailed the
-- code there, and stored the code only after the address had been changed. Its
-- note still says where the code went.
select pg_temp.auth_code_requested('t1', 'ep-t1@example.test');
select pg_temp.next_request();
select pg_temp.auth_code_typed('t1');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('t1')), true,
  'not proof: a code stored after the change that Auth had mailed to the old address');

-- And a code sent to the new address still works for this account.
select pg_temp.auth_code_requested('t1');
select pg_temp.next_request();
select pg_temp.auth_code_typed('t1');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('t1')), false,
  'proof: for the same account, a code that was sent to the address it has now');

-- An address the admin API sets and marks confirmed in one call: no code was typed.
update auth.users set email_confirmed_at = null where id = pg_temp.id('t1');
select pg_temp.auth_admin_sets_email('t1', 'ep-t1-set-again@example.test');
update auth.users set confirmation_token = '', email_confirmed_at = now() where id = pg_temp.id('t1');
update auth.users set last_sign_in_at = clock_timestamp() where id = pg_temp.id('t1');
select pg_temp.next_request();
select results_eq(
  $$ select unproven, auth_confirmed, shown_confirmed from pg_temp.state('t1') $$,
  $$ values (true, true, false) $$,
  'not proof: an address that was set and marked confirmed without anybody typing a code');

-- An invited person whose address the admin corrected. Nobody can use the
-- account yet, so an admin (not only a master admin) may do this. The
-- invitation is sent again, to the corrected address, and typing THAT code
-- proves it.
select pg_temp.auth_invite_code_sent('pending');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('pending') $$,
  $$ values ('ep-pending@example.test', false, false, false) $$,
  '(scene) an invited account, its code sent, not confirmed yet');
select tests.login_as('ep-admin@example.test');
select is(public.admin_begin_email_change(pg_temp.id('pending'), 'ep-pending-fixed@example.test') -> 'emailConfirmed',
  'false'::jsonb, '(scene) the admin corrects the invited address');
select tests.logout();
select pg_temp.auth_admin_sets_email('pending', 'ep-pending-fixed@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('pending') $$,
  $$ values ('ep-pending-fixed@example.test', true, false, false) $$,
  'invited account, address corrected: unconfirmed and unproven');
select results_eq(
  $$ select * from pg_temp.last_audit('pending') $$,
  $$ values ('admin', 'admin.user_updated',
             '{"email":"ep-pending@example.test"}'::jsonb, '{"email":"ep-pending-fixed@example.test"}'::jsonb) $$,
  'invited account, address corrected: audited as admin.user_updated by the admin who asked');
select pg_temp.auth_invite_code_sent('pending');
select pg_temp.next_request();
select pg_temp.auth_invite_code_typed('pending');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('pending') $$,
  $$ values ('ep-pending-fixed@example.test', false, true, true) $$,
  'proof: the invitation code that was sent to the corrected address, typed, confirms and proves it');

-- The first invitation code, the one that went to the old address, confirms
-- the account as far as Auth is concerned and proves nothing about the new one.
select pg_temp.auth_invite_code_sent('pending2');
select pg_temp.next_request();
select pg_temp.auth_admin_sets_email('pending2', 'ep-pending2-moved@example.test');
select pg_temp.next_request();
select pg_temp.auth_invite_code_typed('pending2');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('pending2') $$,
  $$ values ('ep-pending2-moved@example.test', true, true, false) $$,
  'not proof: the invitation code that was sent to the address the account had before');

-- The holder's own change of address is its own proof.
select pg_temp.auth_admin_sets_email('t2', 'ep-t2-set@example.test');
select pg_temp.next_request();
select is((select unproven from pg_temp.state('t2')), true, '(scene) another address set from outside');
select pg_temp.auth_holder_changes_email('t2', 'EP-T2-Mine@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('t2') $$,
  $$ values ('ep-t2-mine@example.test', false, true, true) $$,
  'proof: the holder changing the address themselves (Auth emailed the code to the new one)');
select results_eq(
  $$ select * from pg_temp.last_audit('t2') $$,
  $$ values ('t2', 'auth.email_changed',
             '{"email":"ep-t2-set@example.test"}'::jsonb, '{"email":"ep-t2-mine@example.test"}'::jsonb) $$,
  'the holder''s own change is audited as auth.email_changed, by the account itself');

-- ===========================================================================
-- 2. Invitations do not follow an address an administrator moved
-- ===========================================================================

-- Control: the person the invitation is for sees it.
select tests.login_as('ep-victim@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  '(control) the invited supervisor sees their invitation');

-- An admin is not a member of the project and cannot read it. An admin can
-- also no longer make the move this section is about: the account that would
-- be moved is in use.
select tests.login_as('ep-admin@example.test');
select tests.throws_code(
  $$ select public.get_project_content('proj_26000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  '(control) the admin cannot read the project');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('puppet'), 'ep-nobody@example.test') $$, 'forbidden', 403,
  'an admin may not move a researcher''s account that is in use, onto an invited address or any other');

-- A master admin can. A master admin is not a member of the project either,
-- and cannot read it.
select tests.login_as('ep-master@example.test');
select tests.throws_code(
  $$ select public.get_project_content('proj_26000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  '(control) the master admin cannot read the project');

-- The master admin moves an account they control onto the invited address.
select is(public.admin_begin_email_change(pg_temp.id('puppet'), 'ep-nobody@example.test') ->> 'changed', 'true',
  '(scene) the master admin moves a researcher''s account onto an address that has an invitation waiting');
select tests.logout();
select pg_temp.auth_admin_sets_email('puppet', 'ep-nobody@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.state('puppet') $$,
  $$ values ('ep-nobody@example.test', true, true, false) $$,
  '(scene) the account now carries the invited address, and Auth calls it confirmed');

select tests.login_as('ep-nobody@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'moved account: the invitation for that address is not shown to it');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', (select id from inv where k = 'nobody')), 'not_found', 404,
  'moved account: accepting the invitation by its id is not_found');
select tests.throws_code(
  format('select public.decline_project_invitation(%L)', (select id from inv where k = 'nobody')), 'not_found', 404,
  'moved account: so is declining it');
select tests.throws_code(
  $$ select public.get_project_content('proj_26000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'moved account: the project stays closed');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb, 'moved account: it is a member of nothing');

-- The same with an address that belongs to somebody: move them away first,
-- then move a second account into their place.
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('victim'), 'ep-victim-moved@example.test') ->> 'changed', 'true',
  '(scene) the master admin moves the invited supervisor to another address');
select tests.logout();
select pg_temp.auth_admin_sets_email('victim', 'ep-victim-moved@example.test');
select pg_temp.next_request();
-- This time whoever controls the second account has prepared: a reset code was
-- asked for while the account still had an address they read.
select pg_temp.auth_code_requested('puppet2');
select pg_temp.next_request();
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('puppet2'), 'ep-victim@example.test') ->> 'changed', 'true',
  '(scene) and a second account onto the address that became free');
select tests.logout();
select pg_temp.auth_admin_sets_email('puppet2', 'ep-victim@example.test');
select pg_temp.next_request();

select tests.login_as('ep-victim@example.test');
select is(auth.uid(), pg_temp.id('puppet2'), '(scene) the second account signs in under the supervisor''s old address');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'second moved account: the supervisor''s invitation is not shown to it');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', (select id from inv where k = 'victim')), 'not_found', 404,
  'second moved account: and cannot be accepted');

-- The prepared code is used now. Auth accepts it and opens a session.
select tests.logout();
select pg_temp.auth_code_typed('puppet2');
select pg_temp.next_request();
select tests.login_as('ep-victim@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'second moved account: a code from before the move does not bring the invitation either');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', (select id from inv where k = 'victim')), 'not_found', 404,
  'second moved account: and it still cannot be accepted');

select tests.login_as('ep-owner@example.test');
select is(
  (select array_agg(m ->> 'email' order by m ->> 'email')
     from jsonb_array_elements(public.list_project_members('proj_26000000-0000-4000-8000-000000000001') -> 'members') m),
  array['ep-owner@example.test'],
  'the project still has its owner and nobody else');
select is(
  jsonb_array_length(public.list_project_invitations('proj_26000000-0000-4000-8000-000000000001') -> 'invitations'), 2,
  'and both invitations are still waiting for whoever really holds those addresses');

-- An address that was changed for a good reason keeps working: once its holder
-- has typed a code sent to it, the invitation is theirs.
select tests.logout();
select pg_temp.auth_code_requested('puppet');
select pg_temp.next_request();
select pg_temp.auth_code_typed('puppet');
select pg_temp.next_request();
select tests.login_as('ep-nobody@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  'proven address: the invitation appears once the holder has typed a code sent to it');
select is(
  public.accept_project_invitation((select id from inv where k = 'nobody')),
  '{"project_id":"proj_26000000-0000-4000-8000-000000000001","role":"editor"}'::jsonb,
  'proven address: and can be accepted');
select tests.logout();

-- ===========================================================================
-- 3. Who changed an address: decided by what Auth wrote, not by the intents
-- ===========================================================================

-- A waiting intent of an administrator does not turn the holder's own change
-- into the administrator's.
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('t3'), 'ep-t3-new@example.test') ->> 'changed', 'true',
  '(scene) a master admin asks for a change that Auth then never makes');
select tests.logout();
select pg_temp.auth_holder_changes_email('t3', 'ep-t3-new@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.last_audit('t3') $$,
  $$ values ('t3', 'auth.email_changed',
             '{"email":"ep-t3@example.test"}'::jsonb, '{"email":"ep-t3-new@example.test"}'::jsonb) $$,
  'the holder makes the very change a master admin had asked for: recorded as the holder''s, not the administrator''s');
select is_empty(
  $$ select 1 from pg_temp.audit('t3') where action = 'admin.user_updated' $$,
  'no admin.user_updated row names the administrator for a change they did not make');
select is((select unproven from pg_temp.state('t3')), false, 'and the address is proven: the holder typed its code');
select is_empty($$ select 1 from pg_temp.intents('ep-t3-new@example.test') $$,
  'the administrator''s request is spent: it cannot be credited with a later change');

-- An administrator cannot take themselves out of the record by asking for the
-- same address again for another account.
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('t4'), 'ep-contested@example.test') ->> 'changed', 'true',
  '(scene) a master admin asks to move one account onto an address');
select is(public.admin_begin_email_change(pg_temp.id('decoy'), 'ep-contested@example.test') ->> 'changed', 'true',
  '(scene) and then asks the same for a second account');
select results_eq(
  $$ select actor, target from pg_temp.intents('ep-contested@example.test') order by target $$,
  $$ values ('master', 'decoy'), ('master', 't4') $$,
  'the second request did not replace the first: there are two, one per account');
select tests.logout();
select pg_temp.auth_admin_sets_email('t4', 'ep-contested@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.last_audit('t4') $$,
  $$ values ('master', 'admin.user_updated',
             '{"email":"ep-t4@example.test"}'::jsonb, '{"email":"ep-contested@example.test"}'::jsonb) $$,
  'the change of the first account is still recorded as the master admin''s');
select is_empty(
  $$ select 1 from pg_temp.audit('t4') where action = 'auth.email_changed' $$,
  'and not as the account holder''s own');
select results_eq(
  $$ select actor, target from pg_temp.intents('ep-contested@example.test') $$,
  $$ values ('master', 'decoy') $$,
  'only the request that was acted on is spent');

-- Nor by asking for a different address for the same account.
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('t5'), 'ep-t5-first@example.test') ->> 'changed', 'true',
  '(scene) a master admin asks for one new address');
select is(public.admin_begin_email_change(pg_temp.id('t5'), 'ep-t5-second@example.test') ->> 'changed', 'true',
  '(scene) and then for another');
select tests.logout();
select pg_temp.auth_admin_sets_email('t5', 'ep-t5-first@example.test');
select pg_temp.next_request();
select is((select actor || ' ' || action from pg_temp.last_audit('t5')), 'master admin.user_updated',
  'the first request still stands when Auth acts on it');

-- An administrator asking again for the same change renews their own request.
select tests.login_as('ep-master@example.test');
select public.admin_begin_email_change(pg_temp.id('t6'), 'ep-t6-new@example.test') ->> 'ok' as first;
select public.admin_begin_email_change(pg_temp.id('t6'), 'ep-t6-new@example.test') ->> 'ok' as again;
select is((select count(*)::integer from pg_temp.intents('ep-t6-new@example.test')), 1,
  'the same administrator asking twice for the same change has one request, not two');

-- Two administrators ask for the same change: the newest request is credited,
-- and both are spent.
select tests.login_as('ep-master2@example.test');
select public.admin_begin_email_change(pg_temp.id('t6'), 'ep-t6-new@example.test') ->> 'ok' as second_admin;
select results_eq(
  $$ select actor from pg_temp.intents('ep-t6-new@example.test') order by actor $$,
  $$ values ('master'), ('master2') $$,
  'a second administrator''s request does not touch the first one''s');
select tests.logout();
select pg_temp.auth_admin_sets_email('t6', 'ep-t6-new@example.test');
select pg_temp.next_request();
select is((select actor || ' ' || action from pg_temp.last_audit('t6')), 'master2 admin.user_updated',
  'two requests for one change: the newest is the one recorded');
select is_empty($$ select 1 from pg_temp.intents('ep-t6-new@example.test') $$, 'and both are spent');

-- No request at all: the instance owner editing the user in the dashboard.
select pg_temp.auth_admin_sets_email('t7', 'ep-t7-dashboard@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select * from pg_temp.last_audit('t7') $$,
  $$ values (null::text, 'admin.email_changed_unattributed',
             '{"email":"ep-t7@example.test"}'::jsonb, '{"email":"ep-t7-dashboard@example.test"}'::jsonb) $$,
  'a change nobody asked for through the app: recorded with no actor, and never as the holder''s own');
select is((select unproven from pg_temp.state('t7')), true, 'and the address is unproven');

-- A request that is too old. Its author is a master admin, so its age is the
-- only thing that stands against it.
insert into private.admin_intents (kind, actor_id, target_id, email, created_at)
values ('email_change', pg_temp.id('master'), pg_temp.id('t7'), 'ep-t7-late@example.test', now() - interval '6 minutes');
select pg_temp.auth_admin_sets_email('t7', 'ep-t7-late@example.test');
select pg_temp.next_request();
select is((select coalesce(actor, 'nobody') || ' ' || action from pg_temp.last_audit('t7')),
  'nobody admin.email_changed_unattributed',
  'a request older than five minutes credits nobody');

-- A request whose author may no longer make it, checked when Auth acts.
select tests.login_as('ep-master4@example.test');
select public.admin_begin_email_change(pg_temp.id('t8'), 'ep-t8-a@example.test') ->> 'ok' as asked;
select tests.logout();
update public.profiles set status = 'suspended' where id = pg_temp.id('master4');
select pg_temp.auth_admin_sets_email('t8', 'ep-t8-a@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select actor, action, after_data from pg_temp.last_audit('t8') $$,
  $$ values (null::text, 'admin.email_changed_unattributed',
             jsonb_build_object('email', 'ep-t8-a@example.test', 'requestedBy', pg_temp.id('master4'))) $$,
  'the author was suspended in the meantime: not recorded as their act, but the row says who had asked');
select is_empty($$ select 1 from pg_temp.intents('ep-t8-a@example.test') $$, 'and the request is spent');

update public.profiles set status = 'active', role = 'researcher' where id = pg_temp.id('master4');
insert into private.admin_intents (kind, actor_id, target_id, email)
values ('email_change', pg_temp.id('master4'), pg_temp.id('t8'), 'ep-t8-b@example.test');
select pg_temp.auth_admin_sets_email('t8', 'ep-t8-b@example.test');
select pg_temp.next_request();
select is((select coalesce(actor, 'nobody') || ' ' || action from pg_temp.last_audit('t8')),
  'nobody admin.email_changed_unattributed',
  'the author was demoted in the meantime: the same');

-- The account was promoted out of an admin's reach in the meantime. An admin
-- can ask only for an account nobody uses yet, so this one is an invited
-- account that has not set its password.
select tests.login_as('ep-admin3@example.test');
select public.admin_begin_email_change(pg_temp.id('pending3'), 'ep-pending3-c@example.test') ->> 'ok' as asked;
select tests.logout();
update public.profiles set role = 'admin' where id = pg_temp.id('pending3');
select pg_temp.auth_admin_sets_email('pending3', 'ep-pending3-c@example.test');
select pg_temp.next_request();
select is((select coalesce(actor, 'nobody') || ' ' || action from pg_temp.last_audit('pending3')),
  'nobody admin.email_changed_unattributed',
  'the account became an admin in the meantime, which an admin may not manage: the same');

-- A request that may not be honoured does not hide one that may.
insert into private.admin_intents (kind, actor_id, target_id, email, created_at)
values ('email_change', pg_temp.id('master'), pg_temp.id('pending3'), 'ep-pending3-d@example.test', now() - interval '2 minutes'),
       ('email_change', pg_temp.id('admin3'), pg_temp.id('pending3'), 'ep-pending3-d@example.test', now() - interval '1 minute');
select pg_temp.auth_admin_sets_email('pending3', 'ep-pending3-d@example.test');
select pg_temp.next_request();
select is((select actor || ' ' || action from pg_temp.last_audit('pending3')), 'master admin.user_updated',
  'an older request of somebody who may still make it is honoured when the newest is not');

-- A profile that was deleted keeps no address, whatever Auth still does to the user.
update public.profiles set status = 'deleted', email = null where id = pg_temp.id('decoy');
select pg_temp.auth_admin_sets_email('decoy', 'ep-decoy-late@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select email, unproven from pg_temp.state('decoy') $$,
  $$ values (null::text, false) $$,
  'an address change that arrives after the profile was deleted puts no address back');

-- ===========================================================================
-- 4. Invitations by administrators: whose request Auth's invitation carries
-- ===========================================================================

-- A lower administrator cannot override a higher one's pending invitation.
select tests.login_as('ep-master@example.test');
select is(public.admin_begin_invite('ep-new-master@example.test', 'master_admin', 'Chosen By Master', null, 'master') ->> 'role',
  'master_admin', '(scene) a master admin asks to invite a new master admin');
select tests.login_as('ep-admin@example.test');
select is(public.admin_begin_invite('ep-new-master@example.test', 'researcher', 'pwned') ->> 'role', 'researcher',
  '(scene) an admin then asks to invite the same address as a researcher');
select results_eq(
  $$ select actor, role from pg_temp.intents('ep-new-master@example.test') order by actor $$,
  $$ values ('admin', 'researcher'), ('master', 'master_admin') $$,
  'the admin''s request did not replace the master admin''s: both are recorded');
select tests.logout();
select pg_temp.auth_invites('new-master', 'ep-new-master@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select role, name, must_set_password from public.profiles where id = pg_temp.id('new-master') $$,
  $$ values ('master_admin', 'Chosen By Master', true) $$,
  'the account gets the role and the name the master admin chose, although the admin asked later');
select results_eq(
  $$ select actor, action, after_data ->> 'role' from pg_temp.audit('new-master') $$,
  $$ values ('master', 'master.admin_created', 'master_admin') $$,
  'and the audit names the master admin');
select is_empty($$ select 1 from pg_temp.intents('ep-new-master@example.test') $$,
  'no request for that address is left once the account exists');

-- Between two administrators of the same rank, the newest request counts.
select tests.login_as('ep-admin@example.test');
select public.admin_begin_invite('ep-new-res@example.test', 'researcher') ->> 'ok' as first_admin;
select tests.login_as('ep-admin2@example.test');
select public.admin_begin_invite('ep-new-res@example.test', 'supervisor') ->> 'ok' as second_admin;
select tests.logout();
select pg_temp.auth_invites('new-res', 'ep-new-res@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select actor, action, after_data ->> 'role' from pg_temp.audit('new-res') $$,
  $$ values ('admin2', 'admin.user_created', 'supervisor') $$,
  'two admins, one address: the newest request is used and its author is recorded');

-- An administrator asking again replaces their own request, nobody else's.
select tests.login_as('ep-admin@example.test');
select public.admin_begin_invite('ep-twice@example.test', 'researcher', 'First Try') ->> 'ok' as first;
select public.admin_begin_invite('ep-twice@example.test', 'supervisor', 'Second Try') ->> 'ok' as again;
select results_eq(
  $$ select actor, role from pg_temp.intents('ep-twice@example.test') $$,
  $$ values ('admin', 'supervisor') $$,
  'the same administrator asking twice has one request, the newer one');

-- An invitation is only honoured while its author may still give it.
select tests.login_as('ep-master2@example.test');
select is(public.admin_begin_invite('ep-backdoor@example.test', 'master_admin', null, null, 'master') ->> 'ok', 'true',
  '(scene) a master admin records a request for a new master admin, and is then suspended and deleted');
select tests.logout();
update public.profiles set status = 'suspended' where id = pg_temp.id('master2');
update public.profiles set status = 'deleted', email = null where id = pg_temp.id('master2');
select is((select actor || ' ' || role from pg_temp.intents('ep-backdoor@example.test')), 'master2 master_admin',
  '(scene) the request is still on record');
select pg_temp.auth_invites('backdoor', 'ep-backdoor@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select role, status, must_set_password from public.profiles where id = pg_temp.id('backdoor') $$,
  $$ values ('researcher', 'active', true) $$,
  'a request by a master admin who has since been removed makes nobody a master admin');
select results_eq(
  $$ select actor, action, after_data from pg_temp.audit('backdoor') $$,
  $$ values (null::text, 'admin.invite_role_refused',
             jsonb_build_object('email', 'ep-backdoor@example.test', 'role', 'researcher', 'invited', true,
                                'requestedRole', 'master_admin', 'requestedBy', pg_temp.id('master2'))) $$,
  'the audit says that a request was turned down, for which role, and whose it was');
select is_empty($$ select 1 from pg_temp.intents('ep-backdoor@example.test') $$, 'and the request is spent');

-- Demoted below the role they asked for.
select tests.login_as('ep-admin2@example.test');
select public.admin_begin_invite('ep-late@example.test', 'supervisor') ->> 'ok' as asked;
select tests.logout();
update public.profiles set role = 'supervisor' where id = pg_temp.id('admin2');
select pg_temp.auth_invites('late', 'ep-late@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select p.role, (select action from pg_temp.audit('late')) from public.profiles p where p.id = pg_temp.id('late') $$,
  $$ values ('researcher', 'admin.invite_role_refused') $$,
  'an admin who is no longer an admin: their invitation gives no role');

-- A master surface request needs a master admin when Auth acts, too.
select tests.login_as('ep-master3@example.test');
select public.admin_begin_invite('ep-late-admin@example.test', 'admin', null, null, 'master') ->> 'ok' as asked;
select tests.logout();
update public.profiles set role = 'admin' where id = pg_temp.id('master3');
select pg_temp.auth_invites('late-admin', 'ep-late-admin@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select p.role, (select action from pg_temp.audit('late-admin')) from public.profiles p where p.id = pg_temp.id('late-admin') $$,
  $$ values ('researcher', 'admin.invite_role_refused') $$,
  'a master admin demoted to admin: their request to create an admin is turned down');

-- A request that may not be honoured does not stand in the way of one that may.
insert into private.admin_intents (kind, actor_id, email, payload, created_at)
values ('invite', pg_temp.id('admin'),  'ep-mixed@example.test', '{"role":"supervisor","surface":"admin"}', now() - interval '2 minutes'),
       ('invite', pg_temp.id('admin2'), 'ep-mixed@example.test', '{"role":"researcher","surface":"admin"}', now() - interval '1 minute');
select pg_temp.auth_invites('mixed', 'ep-mixed@example.test');
select pg_temp.next_request();
select results_eq(
  $$ select actor, action, after_data ->> 'role' from pg_temp.audit('mixed') $$,
  $$ values ('admin', 'admin.user_created', 'supervisor') $$,
  'an older request of an admin who may still give it is used when the newest may not be');

-- ===========================================================================
-- 5. None of this is reachable by a client
-- ===========================================================================

select tests.login_as('ep-admin@example.test');
select throws_ok($$ select private.intent_allowed(auth.uid(), 'researcher') $$, '42501', null,
  'a client cannot ask whether an intent would be honoured');
select throws_ok($$ select * from private.admin_intents $$, '42501', null,
  'an admin cannot read the intents');
select throws_ok(
  $$ delete from private.admin_intents $$, '42501', null,
  'or delete one');
select throws_ok(
  $$ update public.profiles set email_unproven = false $$, '42501', null,
  'and nobody can declare an address proven by writing to the table');
select tests.logout();

select * from finish();
rollback;
