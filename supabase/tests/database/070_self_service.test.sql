-- Self-service: my_profile(), update_my_profile() and get_public_instance().
--
-- Legacy parity: auth.test.ts "profile update", provision.test.ts "forced
-- reset blocks everything until the password is set", admin.test.ts "public
-- projection of the settings". Plus what a person may NOT do to their own
-- account: change role, status or email, or touch anybody else's profile.

begin;
select plan(70);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('ss-ada@example.test');
select tests.create_user('ss-other@example.test');
select tests.create_user('ss-suspended@example.test');
select tests.create_user('ss-invited@example.test', 'supervisor', false);
select tests.create_user('ss-deleted@example.test');
select tests.create_user('ss-revoked@example.test');

update public.profiles set name = 'Ada Lovelace', institution = 'Analytical U' where email = 'ss-ada@example.test';
update public.profiles set name = 'Somebody Else' where email = 'ss-other@example.test';
update public.profiles set status = 'suspended' where email = 'ss-suspended@example.test';
update public.profiles set status = 'deleted', email = null where id = tests.user_id('ss-deleted@example.test');
-- A sign-in, as Auth records it.
update auth.users set last_sign_in_at = '2026-03-01 12:00:00+00' where id = tests.user_id('ss-ada@example.test');

-- A developer's database may hold other settings; these tests start from the defaults.
update public.instance_settings
   set org_name = 'Scholea', support_email = '', footer_contact = '', accent = '', enabled_study_types = null
 where id = 1;

-- Read here, as the owner: a client cannot read the profiles table.
create temp table ada (created_ms bigint);
grant select on ada to authenticated;
insert into ada select private.to_ms(p.created_at) from public.profiles p where p.email = 'ss-ada@example.test';

-- The functions of this file, one call each, for the "who is refused" checks.
create temp table rpc_calls (n integer generated always as identity primary key, name text, sql text);
grant select on rpc_calls to authenticated, anon;
insert into rpc_calls (name, sql) values
  ('my_profile',        $$ select public.my_profile() $$),
  ('update_my_profile', $$ select public.update_my_profile('Mallory') $$);

select has_function('public', 'my_profile', array[]::name[], 'my_profile() exists');
select has_function('public', 'update_my_profile', array['text', 'text'], 'update_my_profile(name, institution) exists');
select has_function('public', 'get_public_instance', array[]::name[], 'get_public_instance() exists');
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'update_my_profile'), 1,
  'update_my_profile has one signature: there is no variant that takes a role, a status or an email');

-- ===========================================================================
-- my_profile
-- ===========================================================================

select tests.login_as('ss-ada@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(
  public.my_profile(),
  jsonb_build_object('user', jsonb_build_object(
    'id',                tests.user_id('ss-ada@example.test'),
    'email',             'ss-ada@example.test',
    'name',              'Ada Lovelace',
    'institution',       'Analytical U',
    'role',              'researcher',
    'status',            'active',
    'mustResetPassword', false,
    'lastLoginAt',       1772366400000,
    'createdAt',         (select created_ms from ada),
    'emailConfirmed',    true)),
  'my_profile: {user} with exactly the ten User keys, times in epoch milliseconds');

select is(jsonb_typeof(public.my_profile() -> 'user' -> 'createdAt'), 'number',
  'my_profile: createdAt is a number');

select tests.login_as('ss-other@example.test');
select is(public.my_profile() -> 'user' ->> 'email', 'ss-other@example.test',
  'my_profile: always the caller, there is no argument to ask for anyone else');
select is(public.my_profile() -> 'user' -> 'lastLoginAt', 'null'::jsonb,
  'my_profile: lastLoginAt is null before the first recorded sign-in');

-- Invited, password not set yet: the one function that still answers.
select tests.login_as('ss-invited@example.test');
select is(
  (public.my_profile() -> 'user') - 'id' - 'createdAt',
  '{"email":"ss-invited@example.test","name":"","institution":"","role":"supervisor","status":"active",
    "mustResetPassword":true,"lastLoginAt":null,"emailConfirmed":false}'::jsonb,
  'my_profile: an invited person who has not set a password gets their profile, with mustResetPassword true');

select tests.login_as('ss-suspended@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'account_suspended', 403,
  'my_profile: a suspended account with a live session is told it is suspended');
select is(public.my_account() ->> 'status', 'suspended',
  'a suspended person can still read their own account record, which is how the app shows why');

select tests.login_as('ss-deleted@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'my_profile: a deleted account is unauthenticated');

select tests.login_as('ss-revoked@example.test');
select is(public.my_profile() -> 'user' ->> 'email', 'ss-revoked@example.test',
  'my_profile: works while the session exists');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('ss-revoked@example.test');
select tests.resume_as('ss-revoked@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'my_profile: the same token is refused once its session is gone (signed out or revoked)');

-- An invited person whose session is gone is refused too, password or not.
select tests.login_as('ss-invited@example.test');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('ss-invited@example.test');
select tests.resume_as('ss-invited@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'my_profile: an invited person with a revoked session is unauthenticated');

select tests.logout();
select tests._present(gen_random_uuid(), 'ss-ghost@example.test', gen_random_uuid());
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'my_profile: a token for a user that does not exist is unauthenticated');

select tests.logout();
set local role authenticated;
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'my_profile: no claims at all is unauthenticated');
reset role;

-- ===========================================================================
-- update_my_profile
-- ===========================================================================

select tests.login_as('ss-ada@example.test');

select is(
  (public.update_my_profile('Ada King', 'Royal Society') -> 'user') - 'createdAt' - 'lastLoginAt',
  jsonb_build_object(
    'id', tests.user_id('ss-ada@example.test'), 'email', 'ss-ada@example.test',
    'name', 'Ada King', 'institution', 'Royal Society', 'role', 'researcher', 'status', 'active',
    'mustResetPassword', false, 'emailConfirmed', true),
  'update_my_profile: returns {user} with the new name and institution');
select tests.as_owner();   -- a client cannot read a table: look at the stored row as the owner
select results_eq(
  $$ select name, institution from public.profiles where id = auth.uid() $$,
  $$ values ('Ada King', 'Royal Society') $$,
  'update_my_profile: the profile row is changed');
select tests.as_client();

select tests.logout();
select results_eq(
  $$ select actor_id, actor_email, target_type, target_id, before_data, after_data
       from public.audit_log where action = 'auth.profile_updated'
        and actor_id = tests.user_id('ss-ada@example.test') $$,
  $$ values (tests.user_id('ss-ada@example.test'), 'ss-ada@example.test', 'user',
             tests.user_id('ss-ada@example.test')::text,
             '{"name":"Ada Lovelace","institution":"Analytical U"}'::jsonb,
             '{"name":"Ada King","institution":"Royal Society"}'::jsonb) $$,
  'update_my_profile: one audit row, auth.profile_updated, with the values before and after');
select tests.resume_as('ss-ada@example.test');

-- One argument at a time: the other value is kept.
select is(public.update_my_profile(p_institution => 'UCL') -> 'user' ->> 'name', 'Ada King',
  'update_my_profile: giving only the institution keeps the name');
select is(public.update_my_profile('Ada B. King') -> 'user' ->> 'institution', 'UCL',
  'update_my_profile: giving only the name keeps the institution');

select is(public.update_my_profile(E'  \tPadded Name \n', '  Padded Inst  ') -> 'user' ->> 'name', 'Padded Name',
  'update_my_profile: the name is trimmed');
select tests.as_owner();
select is((select institution from public.profiles where id = auth.uid()), 'Padded Inst',
  'update_my_profile: the institution is trimmed');
select tests.as_client();

-- Nothing to change: nothing is written.
select tests.logout();
create temp table audit_count (n integer);
insert into audit_count
select count(*) from public.audit_log
 where action = 'auth.profile_updated' and actor_id = tests.user_id('ss-ada@example.test');
update public.profiles set updated_at = '2026-01-01 00:00:00+00' where id = tests.user_id('ss-ada@example.test');
select tests.resume_as('ss-ada@example.test');

select is(public.update_my_profile('Padded Name', 'Padded Inst') -> 'user' ->> 'name', 'Padded Name',
  'update_my_profile: sending the current values is accepted');
select is(public.update_my_profile() -> 'user' ->> 'name', 'Padded Name',
  'update_my_profile: sending nothing is accepted');
select is(public.update_my_profile(' Padded Name ') -> 'user' ->> 'institution', 'Padded Inst',
  'update_my_profile: the current name with extra spaces is still no change');
select tests.logout();
select is(
  (select count(*)::integer from public.audit_log
    where action = 'auth.profile_updated' and actor_id = tests.user_id('ss-ada@example.test')),
  (select n from audit_count),
  'update_my_profile: a call that changes nothing writes no audit row');
select is((select updated_at from public.profiles where id = tests.user_id('ss-ada@example.test')),
  '2026-01-01 00:00:00+00'::timestamptz,
  'update_my_profile: a call that changes nothing does not touch the row');
select tests.resume_as('ss-ada@example.test');

select is((public.update_my_profile('', '') -> 'user') - 'id' - 'email' - 'createdAt' - 'lastLoginAt',
  '{"name":"","institution":"","role":"researcher","status":"active","mustResetPassword":false,"emailConfirmed":true}'::jsonb,
  'update_my_profile: an empty string clears the value');

select is(char_length(public.update_my_profile(repeat('n', 200), repeat('i', 200)) -> 'user' ->> 'name'), 200,
  'update_my_profile: 200 characters are accepted');
select tests.throws_code($$ select public.update_my_profile(repeat('n', 201)) $$, 'invalid_input', 400,
  'update_my_profile: a name over 200 characters is refused');
select tests.throws_code($$ select public.update_my_profile(null, repeat('i', 201)) $$, 'invalid_input', 400,
  'update_my_profile: an institution over 200 characters is refused');
select is(char_length(public.update_my_profile('  ' || repeat('n', 200) || '  ') -> 'user' ->> 'name'), 200,
  'update_my_profile: the limit applies after trimming');

-- What the function cannot be used for.
select throws_ok($$ select public.update_my_profile(p_role => 'master_admin') $$, '42883', null,
  'update_my_profile: there is no role argument');
select throws_ok($$ select public.update_my_profile(p_status => 'active') $$, '42883', null,
  'update_my_profile: there is no status argument');
select throws_ok($$ select public.update_my_profile(p_email => 'ss-new@example.test') $$, '42883', null,
  'update_my_profile: there is no email argument');
select throws_ok($$ select public.update_my_profile(p_user_id => gen_random_uuid(), p_name => 'x') $$, '42883', null,
  'update_my_profile: there is no argument naming another user');
select throws_ok($$ update public.profiles set role = 'master_admin' where id = auth.uid() $$, '42501', null,
  'a person cannot change their own role by writing to the table');
select throws_ok($$ update public.profiles set name = 'Direct' where id = auth.uid() $$, '42501', null,
  'a person cannot write even their own name to the table: the function is the only way');

select tests.logout();
select results_eq(
  $$ select role, status, email, must_set_password from public.profiles
      where id = tests.user_id('ss-ada@example.test') $$,
  $$ values ('researcher', 'active', 'ss-ada@example.test', false) $$,
  'update_my_profile: role, status, email and the password flag are untouched by all of the above');
select results_eq(
  $$ select name, institution from public.profiles where id = tests.user_id('ss-other@example.test') $$,
  $$ values ('Somebody Else', '') $$,
  'update_my_profile: nobody else''s profile was touched');

-- ===========================================================================
-- Who is refused
-- ===========================================================================

select tests.login_as('ss-suspended@example.test');
select tests.throws_code(c.sql, 'account_suspended', 403, c.name || ': refused for a suspended account')
  from rpc_calls c order by c.n;

select tests.login_as('ss-deleted@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a deleted account')
  from rpc_calls c order by c.n;

select tests.resume_as('ss-revoked@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(c.sql, '42501', null, c.name || ': not callable without an account')
  from rpc_calls c order by c.n;
select tests.logout();

select results_eq(
  $$ select name from public.profiles
      where email in ('ss-suspended@example.test', 'ss-revoked@example.test')
         or id = tests.user_id('ss-deleted@example.test') $$,
  $$ values (''), (''), ('') $$,
  'none of the refused calls changed a name');

-- ===========================================================================
-- Forced first password (provision.test.ts "forced reset")
-- ===========================================================================

select tests.login_as('ss-invited@example.test');
select tests.throws_code($$ select public.update_my_profile('Invited Person') $$, 'password_reset_required', 403,
  'invited: cannot edit the profile before setting a password');
select tests.throws_code($$ select public.list_my_projects() $$, 'password_reset_required', 403,
  'invited: cannot list projects before setting a password');
select tests.throws_code(
  $$ select public.create_project('proj_70000000-0000-4000-8000-000000000001', 'Too early', 'rct') $$,
  'password_reset_required', 403,
  'invited: cannot create a project before setting a password');

-- Auth verifies the invitation code: a throwaway password, then the confirmation.
select tests.logout();
update auth.users
   set encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
 where id = tests.user_id('ss-invited@example.test');
update auth.users set email_confirmed_at = now() where id = tests.user_id('ss-invited@example.test');
select tests.resume_as('ss-invited@example.test');
select is(public.my_profile() -> 'user' -> 'mustResetPassword', 'true'::jsonb,
  'invited: entering the invitation code does not count as setting a password');
select is(public.my_profile() -> 'user' -> 'emailConfirmed', 'true'::jsonb,
  'invited: entering the invitation code confirms the email');
select tests.throws_code($$ select public.update_my_profile('Invited Person') $$, 'password_reset_required', 403,
  'invited: still refused after the code, until a password is chosen');

-- The person chooses a password.
select tests.logout();
update auth.users
   set encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
 where id = tests.user_id('ss-invited@example.test');
select tests.resume_as('ss-invited@example.test');
select is(public.my_profile() -> 'user' -> 'mustResetPassword', 'false'::jsonb,
  'invited: choosing a password clears mustResetPassword');
select is(public.update_my_profile('Invited Person') -> 'user' ->> 'name', 'Invited Person',
  'invited: the same session can edit the profile once the password is set');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb,
  'invited: and list projects (none yet)');
select tests.logout();
select is(
  (select count(*)::integer from public.audit_log
    where action = 'auth.first_login_completed' and target_id = tests.user_id('ss-invited@example.test')::text), 1,
  'invited: the first password is audited once as auth.first_login_completed');

-- ===========================================================================
-- get_public_instance
-- ===========================================================================

select tests.as_anon();
select is(current_user::text, 'anon', 'the caller has no account');
select is(
  public.get_public_instance(),
  '{"instance":{"orgName":"Scholea","supportEmail":"","footerContact":"","accent":"","enabledStudyTypes":null}}'::jsonb,
  'get_public_instance: callable without an account; the defaults, with null meaning every study type');
select throws_ok($$ select * from public.instance_settings $$, '42501', null,
  'without an account the settings table itself is not readable');
select tests.logout();

update public.instance_settings
   set org_name = 'Example University', support_email = 'help@example.test',
       footer_contact = E'Research Office\nRoom 12', accent = '#1a2b3c',
       enabled_study_types = array['rct', 'systematic-review'],
       updated_by = tests.user_id('ss-ada@example.test')
 where id = 1;

select tests.as_anon();
select is(
  public.get_public_instance(),
  jsonb_build_object('instance', jsonb_build_object(
    'orgName', 'Example University', 'supportEmail', 'help@example.test',
    'footerContact', E'Research Office\nRoom 12', 'accent', '#1a2b3c',
    'enabledStudyTypes', jsonb_build_array('rct', 'systematic-review'))),
  'get_public_instance: reflects what the administrator saved, and exactly five keys (no updated_by, no id)');

select tests.login_as('ss-ada@example.test');
select is(public.get_public_instance() -> 'instance' ->> 'orgName', 'Example University',
  'get_public_instance: a signed-in researcher gets the same');
select throws_ok($$ select 1 from public.instance_settings $$, '42501', null,
  'a researcher cannot read the settings row directly');

select tests.login_as('ss-suspended@example.test');
select is(public.get_public_instance() -> 'instance' ->> 'accent', '#1a2b3c',
  'get_public_instance: public means public, a suspended account gets it too');

select tests.resume_as('ss-revoked@example.test');
select is(public.get_public_instance() -> 'instance' -> 'enabledStudyTypes', '["rct","systematic-review"]'::jsonb,
  'get_public_instance: and so does a token whose session is gone');

select tests.logout();

select * from finish();
rollback;
