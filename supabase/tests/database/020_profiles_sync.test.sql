-- The two triggers on auth.users, branch by branch, and the last usable master
-- admin guard on profiles.
--
-- Auth is simulated by writing to auth.users the way it does. A failing trigger
-- here would block every sign-up, so each branch has its own assertion.
-- Nothing in this file asserts what a client may do; that is 010 and 025.

begin;
select plan(86);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
create temp table ids (k text primary key, id uuid not null);

-- A fresh random password hash: no password is ever written down.
create function pg_temp.fresh_hash() returns text language sql as $$
  select extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4));
$$;

-- Insert an auth.users row as Auth would and remember its id under p_key.
create function pg_temp.auth_insert(
  p_key      text,
  p_email    text,
  p_password text,
  p_meta     jsonb   default '{}',
  p_invited  boolean default false
) returns void language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, invited_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, p_password,
          case when p_invited then now() end,
          '{"provider":"email","providers":["email"]}'::jsonb, p_meta, now(), now());
  insert into ids values (p_key, v_id);
end $$;

create function pg_temp.id(p_key text) returns uuid language sql as $$
  select i.id from ids i where i.k = p_key;
$$;

create function pg_temp.audit_actions(p_key text) returns text language sql as $$
  select coalesce(string_agg(a.action, ',' order by a.action), '')
    from public.audit_log a
   where a.target_id = pg_temp.id(p_key)::text;
$$;

insert into ids values ('admin',  tests.create_user('sync-admin@example.test', 'admin'));
insert into ids values ('master', tests.create_user('sync-master@example.test', 'master_admin'));

-- ===========================================================================
-- Insert: plain sign-up (the row arrives with a password)
-- ===========================================================================

select pg_temp.auth_insert('plain', 'Sync-Plain@example.test', pg_temp.fresh_hash(),
  '{"name":"Ada Lovelace","institution":"Analytical U","role":"master_admin","status":"suspended","must_set_password":true}');

select results_eq(
  $$ select email, name, institution, role, status, must_set_password, email_confirmed_at is null, last_login_at is null
       from public.profiles where id = pg_temp.id('plain') $$,
  $$ values ('sync-plain@example.test', 'Ada Lovelace', 'Analytical U', 'researcher', 'active', false, true, true) $$,
  'sign-up: a researcher profile with the lower-cased email and the name and institution from metadata');

select is((select role from public.profiles where id = pg_temp.id('plain')), 'researcher',
  'sign-up: role in user metadata is ignored');
select is((select status from public.profiles where id = pg_temp.id('plain')), 'active',
  'sign-up: status in user metadata is ignored');
select is(pg_temp.audit_actions('plain'), '',
  'sign-up: no audit row');

select pg_temp.auth_insert('long', 'sync-long@example.test', pg_temp.fresh_hash(),
  jsonb_build_object('name', repeat('n', 250), 'institution', repeat('i', 300)));
select results_eq(
  $$ select char_length(name), char_length(institution) from public.profiles where id = pg_temp.id('long') $$,
  $$ values (200, 200) $$,
  'sign-up: name and institution are clamped to 200 characters');

select pg_temp.auth_insert('nometa', 'sync-nometa@example.test', pg_temp.fresh_hash(), null);
select results_eq(
  $$ select name, institution, role from public.profiles where id = pg_temp.id('nometa') $$,
  $$ values ('', '', 'researcher') $$,
  'sign-up: missing metadata gives an empty name and institution');

select lives_ok(
  $$ select pg_temp.auth_insert('oddmeta', 'sync-oddmeta@example.test', pg_temp.fresh_hash(), '["not","an","object"]') $$,
  'sign-up: metadata that is not an object does not block the sign-up');
select results_eq(
  $$ select name, role from public.profiles where id = pg_temp.id('oddmeta') $$,
  $$ values ('', 'researcher') $$,
  'sign-up: metadata that is not an object is ignored');

-- ===========================================================================
-- Insert: invite (the row arrives without a password) with a fresh intent
-- ===========================================================================

insert into private.admin_intents (kind, actor_id, email, payload)
values ('invite', pg_temp.id('admin'), 'sync-invited@example.test',
        '{"role":"supervisor","name":"Invited Name","institution":"Invited Inst","surface":"admin"}');

select pg_temp.auth_insert('invited', 'Sync-Invited@example.test', '',
  '{"name":"Metadata Name","institution":"Metadata Inst","role":"master_admin"}', true);

select results_eq(
  $$ select email, name, institution, role, status, must_set_password
       from public.profiles where id = pg_temp.id('invited') $$,
  $$ values ('sync-invited@example.test', 'Invited Name', 'Invited Inst', 'supervisor', 'active', true) $$,
  'invite: role, name and institution come from the admin intent, and a password must still be set');

select is_empty(
  $$ select 1 from private.admin_intents where email = 'sync-invited@example.test' $$,
  'invite: the intent is consumed');

select results_eq(
  $$ select actor_id, actor_email, action, target_type, target_id, before_data, after_data
       from public.audit_log where target_id = pg_temp.id('invited')::text $$,
  $$ values (pg_temp.id('admin'), 'sync-admin@example.test', 'admin.user_created', 'user',
             pg_temp.id('invited')::text, null::jsonb,
             '{"email":"sync-invited@example.test","role":"supervisor","invited":true}'::jsonb) $$,
  'invite: one audit row, attributed to the admin who authorised it');

-- Master surface, a NULL password instead of an empty one, no name in the intent.
insert into private.admin_intents (kind, actor_id, email, payload)
values ('invite', pg_temp.id('master'), 'sync-newadmin@example.test', '{"role":"admin","surface":"master"}');

select pg_temp.auth_insert('newadmin', 'sync-newadmin@example.test', null, '{"name":"From Metadata"}', true);

select results_eq(
  $$ select name, role, must_set_password from public.profiles where id = pg_temp.id('newadmin') $$,
  $$ values ('From Metadata', 'admin', true) $$,
  'invite: a NULL password counts as no password, and a missing intent name falls back to metadata');

select results_eq(
  $$ select actor_id, action, after_data ->> 'role' from public.audit_log
      where target_id = pg_temp.id('newadmin')::text $$,
  $$ values (pg_temp.id('master'), 'master.admin_created', 'admin') $$,
  'invite: the master surface is audited as master.admin_created');

-- ===========================================================================
-- Insert: when an intent must NOT be used
-- ===========================================================================

select pg_temp.auth_insert('nointent', 'sync-nointent@example.test', '', '{"role":"admin"}', true);
select results_eq(
  $$ select role, must_set_password from public.profiles where id = pg_temp.id('nointent') $$,
  $$ values ('researcher', true) $$,
  'no intent: a password-less creation is a researcher who must set a password');
select is(pg_temp.audit_actions('nointent'), '', 'no intent: no audit row');

insert into private.admin_intents (kind, actor_id, email, payload, created_at)
values ('invite', pg_temp.id('admin'), 'sync-stale@example.test', '{"role":"admin"}', now() - interval '6 minutes');
select pg_temp.auth_insert('stale', 'sync-stale@example.test', '', '{}', true);
select is((select role from public.profiles where id = pg_temp.id('stale')), 'researcher',
  'stale intent: an intent older than five minutes grants nothing');
select is((select count(*)::integer from private.admin_intents where email = 'sync-stale@example.test'), 1,
  'stale intent: it is not consumed');
select is(pg_temp.audit_actions('stale'), '', 'stale intent: no audit row');

insert into private.admin_intents (kind, actor_id, email, payload)
values ('invite', pg_temp.id('admin'), 'sync-someone-else@example.test', '{"role":"admin"}');
select pg_temp.auth_insert('other', 'sync-other@example.test', '', '{}', true);
select is((select role from public.profiles where id = pg_temp.id('other')), 'researcher',
  'other address: an intent for a different email grants nothing');
select is((select count(*)::integer from private.admin_intents where email = 'sync-someone-else@example.test'), 1,
  'other address: that intent is left alone');

insert into private.admin_intents (kind, actor_id, target_id, email, payload)
values ('email_change', pg_temp.id('admin'), pg_temp.id('plain'), 'sync-wrongkind@example.test', '{"role":"admin"}');
select pg_temp.auth_insert('wrongkind', 'sync-wrongkind@example.test', '', '{}', true);
select is((select role from public.profiles where id = pg_temp.id('wrongkind')), 'researcher',
  'wrong kind: an email_change intent is never used for a creation');
select is((select count(*)::integer from private.admin_intents where email = 'sync-wrongkind@example.test'), 1,
  'wrong kind: that intent is left alone');

-- The case that matters most: anyone can sign up with a password for an address
-- an admin has just invited. That must not hand them the invited role.
insert into private.admin_intents (kind, actor_id, email, payload)
values ('invite', pg_temp.id('master'), 'sync-race@example.test', '{"role":"master_admin","surface":"master"}');
select pg_temp.auth_insert('race', 'sync-race@example.test', pg_temp.fresh_hash(), '{"role":"master_admin"}');
select results_eq(
  $$ select role, must_set_password from public.profiles where id = pg_temp.id('race') $$,
  $$ values ('researcher', false) $$,
  'password sign-up: never receives the role of a pending invite for the same address');
select is((select count(*)::integer from private.admin_intents where email = 'sync-race@example.test'), 1,
  'password sign-up: never consumes the intent');
select is(pg_temp.audit_actions('race'), '', 'password sign-up: no audit row');

select throws_ok(
  $$ insert into private.admin_intents (kind, actor_id, email, payload)
     values ('invite', pg_temp.id('admin'), 'sync-badrole@example.test', '{"role":"owner"}') $$,
  '23514', null,
  'an invite intent cannot be recorded with an unknown role');
select throws_ok(
  $$ insert into private.admin_intents (kind, actor_id, email, payload)
     values ('invite', pg_temp.id('admin'), 'Sync-Upper@example.test', '{"role":"admin"}') $$,
  '23514', null,
  'an intent cannot be recorded with an address that is not lower case (it would never match)');

-- ===========================================================================
-- Update: email
-- ===========================================================================

insert into ids values ('upd', tests.create_user('sync-upd@example.test'));

-- The account holder changes their own address. Auth keeps the new address in
-- email_change until the emailed code is typed, then moves it into email and
-- empties email_change in ONE statement. That shape, and nothing else, is what
-- the trigger takes for the holder's own change (026 covers every other shape).
create function pg_temp.holder_changes_email(p_key text, p_email text) returns void language plpgsql as $$
begin
  update auth.users set email_change = p_email, email_change_token_new = 'pending' where id = pg_temp.id(p_key);
  update auth.users
     set email = email_change, email_change = '', email_change_token_new = ''
   where id = pg_temp.id(p_key);
end $$;

select pg_temp.holder_changes_email('upd', 'Sync-Upd-New@example.test');

select is((select email from public.profiles where id = pg_temp.id('upd')), 'sync-upd-new@example.test',
  'email change: the profile follows, lower-cased');
select results_eq(
  $$ select actor_id, actor_email, action, target_type, before_data, after_data
       from public.audit_log where target_id = pg_temp.id('upd')::text $$,
  $$ values (pg_temp.id('upd'), 'sync-upd-new@example.test', 'auth.email_changed', 'user',
             '{"email":"sync-upd@example.test"}'::jsonb, '{"email":"sync-upd-new@example.test"}'::jsonb) $$,
  'email change: audited as the user''s own change with before and after');

insert into private.admin_intents (kind, actor_id, target_id, email)
values ('email_change', pg_temp.id('admin'), pg_temp.id('upd'), 'sync-upd-byadmin@example.test');
update auth.users set email = 'sync-upd-byadmin@example.test' where id = pg_temp.id('upd');

select results_eq(
  $$ select actor_id, action, before_data, after_data
       from public.audit_log
      where target_id = pg_temp.id('upd')::text and action = 'admin.user_updated' $$,
  $$ values (pg_temp.id('admin'),
             'admin.user_updated',
             '{"email":"sync-upd-new@example.test"}'::jsonb,
             '{"email":"sync-upd-byadmin@example.test"}'::jsonb) $$,
  'email change by an admin: audited as admin.user_updated with the admin as actor');
select is_empty(
  $$ select 1 from private.admin_intents where email = 'sync-upd-byadmin@example.test' $$,
  'email change by an admin: the intent is consumed');

-- A stale intent, and a fresh one that names a different user.
insert into private.admin_intents (kind, actor_id, target_id, email, created_at)
values ('email_change', pg_temp.id('admin'), pg_temp.id('upd'), 'sync-upd-stale@example.test', now() - interval '6 minutes');
select pg_temp.holder_changes_email('upd', 'sync-upd-stale@example.test');
select is(
  (select count(*)::integer from public.audit_log
    where target_id = pg_temp.id('upd')::text and action = 'auth.email_changed'), 2,
  'email change: a stale intent is ignored, the change is the user''s own');
select is((select count(*)::integer from private.admin_intents where email = 'sync-upd-stale@example.test'), 1,
  'email change: the stale intent is not consumed');

insert into private.admin_intents (kind, actor_id, target_id, email)
values ('email_change', pg_temp.id('admin'), pg_temp.id('plain'), 'sync-upd-wrongtarget@example.test');
update auth.users set email = 'sync-upd-wrongtarget@example.test' where id = pg_temp.id('upd');
select is(
  (select count(*)::integer from public.audit_log
    where target_id = pg_temp.id('upd')::text and action = 'admin.user_updated'), 1,
  'email change: an intent for another user is not applied');
select is((select count(*)::integer from private.admin_intents where email = 'sync-upd-wrongtarget@example.test'), 1,
  'email change: an intent for another user is not consumed');

-- ===========================================================================
-- Update: confirmation
-- ===========================================================================

select is((select email_confirmed_at from public.profiles where id = pg_temp.id('plain')), null,
  'confirmation: unconfirmed until Auth says so');
update auth.users set email_confirmed_at = '2026-01-02 03:04:05+00' where id = pg_temp.id('plain');
select is((select email_confirmed_at from public.profiles where id = pg_temp.id('plain')),
  '2026-01-02 03:04:05+00'::timestamptz,
  'confirmation: the profile follows auth.users');
select is(pg_temp.audit_actions('plain'), '', 'confirmation: no audit row');

-- ===========================================================================
-- Update: password
-- ===========================================================================

-- An ordinary change.
update auth.users set encrypted_password = pg_temp.fresh_hash() where id = pg_temp.id('plain');
select is(pg_temp.audit_actions('plain'), 'auth.password_changed',
  'password: a change is audited as auth.password_changed');
select is((select must_set_password from public.profiles where id = pg_temp.id('plain')), false,
  'password: must_set_password stays false');

update auth.users set encrypted_password = encrypted_password where id = pg_temp.id('plain');
select is(pg_temp.audit_actions('plain'), 'auth.password_changed',
  'password: writing the same hash again is not a change');

-- What Auth does when an invited user types their invitation code: a throwaway
-- random password first, the confirmation second. The user has not chosen a
-- password yet, so nothing may change for them.
update auth.users set encrypted_password = pg_temp.fresh_hash() where id = pg_temp.id('invited');
select is((select must_set_password from public.profiles where id = pg_temp.id('invited')), true,
  'invite code verified: the throwaway password Auth assigns does not clear must_set_password');
select is(pg_temp.audit_actions('invited'), 'admin.user_created',
  'invite code verified: the throwaway password is not audited');

update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = pg_temp.id('invited');
select is((select must_set_password from public.profiles where id = pg_temp.id('invited')), true,
  'invite code verified: confirmed and signed in, still must set a password');

-- Now the user sets their own.
update auth.users set encrypted_password = pg_temp.fresh_hash() where id = pg_temp.id('invited');
select is((select must_set_password from public.profiles where id = pg_temp.id('invited')), false,
  'first password: setting it clears must_set_password');
select is(pg_temp.audit_actions('invited'), 'admin.user_created,auth.first_login_completed,auth.login',
  'first password: audited once as auth.first_login_completed, not as a password change');

update auth.users set encrypted_password = pg_temp.fresh_hash() where id = pg_temp.id('invited');
select is(pg_temp.audit_actions('invited'),
  'admin.user_created,auth.first_login_completed,auth.login,auth.password_changed',
  'first password: the next change is an ordinary auth.password_changed');

-- The other way in for an invitee: a recovery code. Auth confirms the email and
-- assigns no throwaway password, so the first real one goes from empty to set.
update auth.users set email_confirmed_at = now() where id = pg_temp.id('nointent');
select is((select must_set_password from public.profiles where id = pg_temp.id('nointent')), true,
  'recovery code verified: still must set a password');
update auth.users set encrypted_password = pg_temp.fresh_hash() where id = pg_temp.id('nointent');
select is((select must_set_password from public.profiles where id = pg_temp.id('nointent')), false,
  'first password after a recovery code: clears must_set_password');
select is(pg_temp.audit_actions('nointent'), 'auth.first_login_completed',
  'first password after a recovery code: audited as auth.first_login_completed');

-- A password that disappears is not a password that was set.
update auth.users set encrypted_password = '' where id = pg_temp.id('newadmin');
update auth.users set encrypted_password = null where id = pg_temp.id('newadmin');
select is((select must_set_password from public.profiles where id = pg_temp.id('newadmin')), true,
  'password: an empty or NULL password changes nothing');
select is(pg_temp.audit_actions('newadmin'), 'master.admin_created',
  'password: an empty or NULL password is not audited');

-- ===========================================================================
-- Update: last sign-in
-- ===========================================================================

update auth.users set last_sign_in_at = '2026-03-04 05:06:07+00' where id = pg_temp.id('long');
select is((select last_login_at from public.profiles where id = pg_temp.id('long')),
  '2026-03-04 05:06:07+00'::timestamptz,
  'sign-in: last_login_at follows auth.users');
select is(pg_temp.audit_actions('long'), 'auth.login', 'sign-in: audited as auth.login');

update auth.users set last_sign_in_at = '2026-03-04 05:06:07+00' where id = pg_temp.id('long');
select is(pg_temp.audit_actions('long'), 'auth.login',
  'sign-in: the same timestamp again (a token refresh) is not another login');

update auth.users set last_sign_in_at = null where id = pg_temp.id('long');
select is((select last_login_at from public.profiles where id = pg_temp.id('long')),
  '2026-03-04 05:06:07+00'::timestamptz,
  'sign-in: clearing the timestamp keeps the last known login');
select is(pg_temp.audit_actions('long'), 'auth.login', 'sign-in: clearing the timestamp is not audited');

-- Auth confirms and signs in with one statement when a code is verified.
update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = pg_temp.id('nometa');
select results_eq(
  $$ select email_confirmed_at is not null, last_login_at is not null
       from public.profiles where id = pg_temp.id('nometa') $$,
  $$ values (true, true) $$,
  'several changes in one statement are all applied');

-- ===========================================================================
-- Update: what the triggers must ignore
-- ===========================================================================

update auth.users
   set raw_user_meta_data = '{"name":"Renamed","institution":"Elsewhere","role":"master_admin","status":"suspended"}'
 where id = pg_temp.id('plain');
select results_eq(
  $$ select name, institution, role, status from public.profiles where id = pg_temp.id('plain') $$,
  $$ values ('Ada Lovelace', 'Analytical U', 'researcher', 'active') $$,
  'a later metadata edit changes nothing: not the name, not the role, not the status');

-- ===========================================================================
-- Update: soft delete
-- ===========================================================================

-- Auth obfuscates the email and clears the password in the same statement that sets deleted_at.
insert into ids values ('del', tests.create_user('sync-del@example.test', 'supervisor'));
update auth.users
   set deleted_at = now(), email = 'obfuscated-hash-of-the-old-address', encrypted_password = null
 where id = pg_temp.id('del');

select results_eq(
  $$ select status, email, role from public.profiles where id = pg_temp.id('del') $$,
  $$ values ('deleted', null::text, 'supervisor') $$,
  'soft delete: the profile is marked deleted and loses its email');
select is(pg_temp.audit_actions('del'), '',
  'soft delete: the obfuscated email is not audited as an email change');

update auth.users set email = 'obfuscated-again', last_sign_in_at = now(), encrypted_password = pg_temp.fresh_hash()
 where id = pg_temp.id('del');
select results_eq(
  $$ select status, email, last_login_at from public.profiles where id = pg_temp.id('del') $$,
  $$ values ('deleted', null::text, null::timestamptz) $$,
  'soft delete: later changes to a deleted auth user are ignored');
select is(pg_temp.audit_actions('del'), '', 'soft delete: later changes are not audited');

-- The admin RPC marks the profile first; Auth's own delete then finds nothing left to do.
insert into ids values ('del2', tests.create_user('sync-del2@example.test'));
update public.profiles set status = 'deleted', email = null where id = pg_temp.id('del2');
select lives_ok(
  $$ update auth.users set deleted_at = now(), email = 'obfuscated-2' where id = pg_temp.id('del2') $$,
  'soft delete: harmless when the profile was already marked deleted');
select is((select status from public.profiles where id = pg_temp.id('del2')), 'deleted',
  'soft delete: an already deleted profile stays deleted');

-- A hard delete removes the profile with the auth user.
insert into ids values ('gone', tests.create_user('sync-gone@example.test'));
delete from auth.users where id = pg_temp.id('gone');
select is_empty(
  $$ select 1 from public.profiles where id = pg_temp.id('gone') $$,
  'hard delete: the profile goes with the auth user');

-- ===========================================================================
-- Last usable master admin
-- ===========================================================================
-- 'master' must be the only usable master admin (active, confirmed, password
-- set) for what follows. A developer's database may already hold a real one, so
-- any master admin that is not a fixture is made unusable for the length of
-- this transaction. must_set_password is not a column the guard watches.
update public.profiles
   set must_set_password = true
 where role = 'master_admin'
   and id not in (select i.id from ids i);

select tests.throws_code(
  $$ update public.profiles set role = 'admin' where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: the last usable master admin cannot be demoted');
select tests.throws_code(
  $$ update public.profiles set status = 'suspended' where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: the last usable master admin cannot be suspended');
select tests.throws_code(
  $$ update public.profiles set status = 'deleted', email = null where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: the last usable master admin cannot be marked deleted');
select tests.throws_code(
  $$ delete from public.profiles where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: the last usable master admin''s profile cannot be deleted');
select tests.throws_code(
  $$ delete from auth.users where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: hard-deleting their auth user is refused too');
select tests.throws_code(
  $$ update auth.users set deleted_at = now(), email = 'obfuscated-master' where id = pg_temp.id('master') $$,
  'last_master_admin', 409, 'guard: soft-deleting their auth user is refused too');
select results_eq(
  $$ select role, status, email from public.profiles where id = pg_temp.id('master') $$,
  $$ values ('master_admin', 'active', 'sync-master@example.test') $$,
  'guard: after every refused attempt the master admin is untouched');

select lives_ok(
  $$ update public.profiles set name = 'Renamed Master', institution = 'HQ' where id = pg_temp.id('master') $$,
  'guard: other columns of the last master admin can change');
select lives_ok(
  $$ update public.profiles set role = 'master_admin', status = 'active' where id = pg_temp.id('master') $$,
  'guard: rewriting the same role and status is not a removal');

-- Master admins that cannot be used do not count as a replacement.
insert into ids values ('m_suspended', tests.create_user('sync-m-suspended@example.test', 'master_admin'));
update public.profiles set status = 'suspended' where id = pg_temp.id('m_suspended');
insert into ids values ('m_invited', tests.create_user('sync-m-invited@example.test', 'master_admin', false));
insert into ids values ('m_unconfirmed', tests.create_user('sync-m-unconfirmed@example.test', 'master_admin'));
update auth.users set email_confirmed_at = null where id = pg_temp.id('m_unconfirmed');

select results_eq(
  $$ select status, must_set_password, email_confirmed_at is null
       from public.profiles
      where id in (pg_temp.id('m_suspended'), pg_temp.id('m_invited'), pg_temp.id('m_unconfirmed'))
      order by email $$,
  $$ values ('active', true, true), ('suspended', false, false), ('active', false, true) $$,
  'guard fixtures: one invited, one suspended and one unconfirmed master admin exist');

select tests.throws_code(
  $$ update public.profiles set role = 'admin' where id = pg_temp.id('master') $$,
  'last_master_admin', 409,
  'guard: a suspended, an invited and an unconfirmed master admin do not count as a replacement');

select lives_ok(
  $$ update public.profiles set role = 'researcher' where id = pg_temp.id('m_invited') $$,
  'guard: a master admin who never set a password can be demoted');
select lives_ok(
  $$ delete from auth.users where id = pg_temp.id('m_suspended') $$,
  'guard: a suspended master admin can be deleted');

-- A second usable master admin makes the first one removable, and only one of them.
insert into ids values ('master2', tests.create_user('sync-master2@example.test', 'master_admin'));

select tests.throws_code(
  $$ update public.profiles set role = 'admin' where id in (pg_temp.id('master'), pg_temp.id('master2')) $$,
  'last_master_admin', 409, 'guard: two master admins cannot both be demoted by one statement');
select is((select count(*)::integer from public.profiles
            where id in (pg_temp.id('master'), pg_temp.id('master2')) and role = 'master_admin'), 2,
  'guard: the refused statement demoted neither');

select lives_ok(
  $$ update public.profiles set role = 'admin' where id = pg_temp.id('master') $$,
  'guard: with a second usable master admin, the first can be demoted');
select tests.throws_code(
  $$ update public.profiles set status = 'suspended' where id = pg_temp.id('master2') $$,
  'last_master_admin', 409, 'guard: the remaining one is now the last and is protected');
select lives_ok(
  $$ update public.profiles set role = 'master_admin' where id = pg_temp.id('master') $$,
  'guard: promoting someone is never refused');
select lives_ok(
  $$ update auth.users set deleted_at = now(), email = 'obfuscated-master2' where id = pg_temp.id('master2') $$,
  'guard: with a replacement in place, a master admin can be soft-deleted through Auth');
select is((select status from public.profiles where id = pg_temp.id('master2')), 'deleted',
  'guard: and their profile is marked deleted');

select * from finish();
rollback;
