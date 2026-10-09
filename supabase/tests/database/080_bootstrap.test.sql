-- The first master admin: private.bootstrap_master_admin(email, force).
--
-- Legacy parity (old server, provision.test.ts): exactly one master admin is
-- made, a second call does nothing, and without the owner's action there is
-- none at all. The third legacy test, the forced password reset, is 070.
--
-- Changed on purpose: the legacy server created the account itself, from an
-- address and a temporary password in its environment. Here nothing creates an
-- account or a password. The owner signs up like anyone else and is then
-- promoted by a function that only the database owner can run, and that the
-- API can never reach.

begin;
select plan(62);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- A developer's database may already have master admins. For the length of
-- this transaction there are none: first unusable (which the last-master guard
-- lets through), then demoted.
update public.profiles set must_set_password = true where role = 'master_admin';
update public.profiles set role = 'admin' where role = 'master_admin';

select tests.create_user('bs-owner@example.test');
select tests.create_user('bs-second@example.test');
select tests.create_user('bs-admin@example.test', 'admin');
select tests.create_user('bs-researcher@example.test');
select tests.create_user('bs-unconfirmed@example.test');
select tests.create_user('bs-invited@example.test', 'researcher', false);
select tests.create_user('bs-codeonly@example.test', 'researcher', false);
select tests.create_user('bs-suspended@example.test');
select tests.create_user('bs-deleted@example.test');

-- Signed up, code not entered.
update auth.users set email_confirmed_at = null where id = tests.user_id('bs-unconfirmed@example.test');
-- Invited, code entered, no password chosen.
update auth.users set email_confirmed_at = now() where id = tests.user_id('bs-codeonly@example.test');
update public.profiles set status = 'suspended' where email = 'bs-suspended@example.test';
update public.profiles set status = 'deleted', email = null where id = tests.user_id('bs-deleted@example.test');

create temp table before_counts as
select (select count(*)::integer from auth.users) as users,
       (select count(*)::integer from public.audit_log where action = 'master.provisioned') as provisioned;

create function pg_temp.masters() returns integer language sql stable security definer as $$
  select count(*)::integer from public.profiles where role = 'master_admin';
$$;
create function pg_temp.provisioned() returns integer language sql stable security definer as $$
  select count(*)::integer - (select b.provisioned from before_counts b)
    from public.audit_log where action = 'master.provisioned';
$$;
create function pg_temp.role_of(p_email text) returns text language sql stable security definer as $$
  select p.role from public.profiles p where p.id = tests.user_id(p_email);
$$;
grant execute on function pg_temp.masters(), pg_temp.provisioned(), pg_temp.role_of(text)
  to anon, authenticated, service_role;

-- ===========================================================================
-- Where it lives and who may run it
-- ===========================================================================

select has_function('private', 'bootstrap_master_admin', array['text', 'boolean'],
  'private.bootstrap_master_admin(email, force) exists');
select hasnt_function('public', 'bootstrap_master_admin',
  'there is no bootstrap function in public, the schema the API exposes');
select function_returns('private', 'bootstrap_master_admin', array['text', 'boolean'], 'jsonb',
  'it answers with a JSON object');
select is(
  (select p.prosecdef from pg_proc p where p.oid = 'private.bootstrap_master_admin(text, boolean)'::regprocedure),
  false,
  'it is SECURITY INVOKER: it has only the power of whoever runs it');
select is_empty(
  $$ select r.rolname
       from (values ('anon'), ('authenticated'), ('service_role'), ('authenticator')) r (rolname)
      where has_function_privilege(r.rolname, 'private.bootstrap_master_admin(text, boolean)', 'EXECUTE') $$,
  'no API role is granted it');
select ok(has_function_privilege('postgres', 'private.bootstrap_master_admin(text, boolean)', 'EXECUTE'),
  'the database owner can run it');
-- A promotion and a removal of master admins must never overlap.
select is(
  (select count(*)::integer from pg_proc p
    where p.oid in ('private.bootstrap_master_admin(text, boolean)'::regprocedure, 'private.guard_last_master()'::regprocedure)
      and p.prosrc ~ 'pg_advisory_xact_lock\(hashtextextended\(''scholea:last_master'', 0\)\)'),
  2, 'it takes the same lock as the last-master guard');

-- ===========================================================================
-- Nobody is a master admin until the owner says so (provision.test.ts 2)
-- ===========================================================================

select is(pg_temp.masters(), 0,
  'signing up makes nobody a master admin, not even the first account');
select is(session_user::text || '/' || current_user::text, 'postgres/postgres',
  'the calls below are made as the database owner, as from the SQL editor');

-- ===========================================================================
-- Accounts that cannot be promoted
-- ===========================================================================

select is(private.bootstrap_master_admin(t.email), format('{"created":false,"reason":"%s"}', t.reason)::jsonb,
         'refused: ' || t.why)
  from (values
    (1, 'bs-nobody@example.test',      'no-active-user-with-that-email',          'an address with no account'),
    (2, null,                          'no-active-user-with-that-email',          'no address'),
    (3, '',                            'no-active-user-with-that-email',          'an empty address'),
    (4, 'bs-suspended@example.test',   'no-active-user-with-that-email',          'a suspended account'),
    (5, 'bs-deleted@example.test',     'no-active-user-with-that-email',          'a deleted account'),
    (6, 'bs-unconfirmed@example.test', 'email-not-confirmed-or-password-not-set', 'an account that has not confirmed its address'),
    (7, 'bs-invited@example.test',     'email-not-confirmed-or-password-not-set', 'an invited account that never entered its code'),
    (8, 'bs-codeonly@example.test',    'email-not-confirmed-or-password-not-set', 'an invited account that entered its code but set no password'))
    t (n, email, reason, why)
 order by t.n;

-- Forcing skips the "a master admin exists" answer and nothing else.
select is(private.bootstrap_master_admin('bs-unconfirmed@example.test', true),
  '{"created":false,"reason":"email-not-confirmed-or-password-not-set"}'::jsonb,
  'force does not promote an unconfirmed account');
select is(private.bootstrap_master_admin('bs-suspended@example.test', true),
  '{"created":false,"reason":"no-active-user-with-that-email"}'::jsonb,
  'force does not promote a suspended account');
select is(private.bootstrap_master_admin('bs-nobody@example.test', true),
  '{"created":false,"reason":"no-active-user-with-that-email"}'::jsonb,
  'force does not create an account');

select is(pg_temp.masters(), 0, 'after every refusal there is still no master admin');
select is(pg_temp.provisioned(), 0, 'and no refusal was audited as a promotion');

-- ===========================================================================
-- The owner promotes their own account (provision.test.ts 1)
-- ===========================================================================

select is(
  private.bootstrap_master_admin(E'  Bs-Owner@Example.TEST \n'),
  jsonb_build_object('created', true, 'userId', tests.user_id('bs-owner@example.test'), 'email', 'bs-owner@example.test'),
  'the owner''s account is promoted; the address may be typed in any letter case, with spaces around it');
select is(pg_temp.role_of('bs-owner@example.test'), 'master_admin', 'the account is a master admin');
select is(pg_temp.masters(), 1, 'there is exactly one master admin');
select results_eq(
  $$ select actor_id, actor_email, target_type, target_id, before_data, after_data
       from public.audit_log
      where action = 'master.provisioned' and target_id = tests.user_id('bs-owner@example.test')::text $$,
  $$ values (null::uuid, null::text, 'user', tests.user_id('bs-owner@example.test')::text,
             '{"role":"researcher"}'::jsonb,
             '{"email":"bs-owner@example.test","role":"master_admin","forced":false}'::jsonb) $$,
  'audited as master.provisioned with no actor: the instance owner acted from SQL');
select results_eq(
  $$ select status, must_set_password, email from public.profiles where id = tests.user_id('bs-owner@example.test') $$,
  $$ values ('active', false, 'bs-owner@example.test') $$,
  'nothing else about the account changed: no new password, no forced reset');

-- A second call does nothing, whoever it names.
select is(private.bootstrap_master_admin('bs-owner@example.test'),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'a second call for the same account answers master-exists');
select is(private.bootstrap_master_admin('bs-second@example.test'),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'a call for another account answers master-exists (provision.test.ts 1)');
select is(private.bootstrap_master_admin('bs-second@example.test', false),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'force => false is the same as leaving it out');
select is(private.bootstrap_master_admin('bs-second@example.test', null),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'force => null does not force');
select is(private.bootstrap_master_admin('bs-nobody@example.test'),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'once a master admin exists the answer does not depend on the address');
select is(pg_temp.masters(), 1, 'there is still exactly one master admin');
select is(pg_temp.provisioned(), 1, 'and exactly one promotion in the audit log');
select is(pg_temp.role_of('bs-second@example.test'), 'researcher', 'the other account is still a researcher');

-- The new master admin can now do the rest from the app.
select tests.login_as('bs-owner@example.test');
select is(jsonb_typeof(public.master_list_admins() -> 'admins'), 'array',
  'the promoted owner reaches the master surface');
select is(public.admin_begin_invite('bs-colleague@example.test', 'admin', null, null, 'master') ->> 'role', 'admin',
  'and can invite the first admin');
select tests.logout();

-- ===========================================================================
-- The way back in: force
-- ===========================================================================
-- The only master admin is suspended (set here as the owner would find it; the
-- guard refuses to suspend the last usable one through any function).
update public.profiles set must_set_password = true where id = tests.user_id('bs-owner@example.test');
update public.profiles set status = 'suspended' where id = tests.user_id('bs-owner@example.test');
update public.profiles set must_set_password = false where id = tests.user_id('bs-owner@example.test');

select is(private.bootstrap_master_admin('bs-second@example.test'),
  '{"created":false,"reason":"master-exists"}'::jsonb,
  'a master admin who cannot sign in still counts as existing: a plain call does nothing');
select is(
  private.bootstrap_master_admin('bs-second@example.test', true),
  jsonb_build_object('created', true, 'userId', tests.user_id('bs-second@example.test'), 'email', 'bs-second@example.test'),
  'with force, another confirmed account is promoted');
select is(pg_temp.masters(), 2, 'the suspended master admin is left as it was');
select is(
  (select after_data from public.audit_log
    where action = 'master.provisioned' and target_id = tests.user_id('bs-second@example.test')::text),
  '{"email":"bs-second@example.test","role":"master_admin","forced":true}'::jsonb,
  'a forced promotion says so in the audit log');
select is(private.bootstrap_master_admin('bs-admin@example.test', true) ->> 'created', 'true',
  'with force, an admin can be promoted as well');
select is(
  (select before_data from public.audit_log
    where action = 'master.provisioned' and target_id = tests.user_id('bs-admin@example.test')::text),
  '{"role":"admin"}'::jsonb,
  'the audit row records the role the account had');

-- ===========================================================================
-- Not through the API
-- ===========================================================================

-- A signed-in researcher, a signed-in master admin, a visitor and the secret key.
select tests.login_as('bs-researcher@example.test');
select is(public.my_profile() -> 'user' ->> 'role', 'researcher', 'a researcher is signed in');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test') $$, '42501', null,
  'a signed-in researcher cannot run the bootstrap for themselves');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$, '42501', null,
  'nor with force');

select tests.login_as('bs-second@example.test');
select is(public.my_profile() -> 'user' ->> 'role', 'master_admin', 'a master admin is signed in');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$, '42501', null,
  'even a master admin cannot run the bootstrap through the API: promotion there is master_set_role');

select tests.as_anon();
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$, '42501', null,
  'a visitor without an account cannot run the bootstrap');

select tests.logout();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is(current_user::text, 'service_role', 'the next call is made as service_role, the role of the secret key');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$, '42501', null,
  'the secret key cannot run the bootstrap');
select tests.logout();

-- Second lock: suppose somebody grants it by mistake. The function still
-- refuses every caller that arrives through the API.
grant usage on schema private to anon, service_role;
grant execute on function private.bootstrap_master_admin(text, boolean) to anon, authenticated, service_role;

select tests.resume_as('bs-researcher@example.test');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$,
  '42501', 'bootstrap_master_admin: run from the SQL editor or psql as postgres',
  'granted by mistake: the function itself refuses a signed-in caller');
select tests.as_anon();
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$,
  '42501', 'bootstrap_master_admin: run from the SQL editor or psql as postgres',
  'granted by mistake: the function itself refuses a visitor');
select tests.logout();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$,
  '42501', 'bootstrap_master_admin: run from the SQL editor or psql as postgres',
  'granted by mistake: the function itself refuses the secret key');
select tests.logout();

-- An API role is refused even when no claims came with it.
set local role authenticated;
select is(current_user::text || '/' || coalesce(current_setting('request.jwt.claims', true), ''), 'authenticated/',
  'the next call is made as authenticated, with no claims at all');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$,
  '42501', 'bootstrap_master_admin: run from the SQL editor or psql as postgres',
  'granted by mistake: the function itself refuses an API role that carries no claims');
select tests.logout();

-- A request that reached the database with JWT claims is an API request,
-- whatever role it runs as.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(current_user::text, 'postgres', 'the next call runs as the owner, but carries API claims');
select throws_ok(
  $$ select private.bootstrap_master_admin('bs-researcher@example.test', true) $$,
  '42501', 'bootstrap_master_admin: run from the SQL editor or psql as postgres',
  'a call that carries API claims is refused even as the owner');
select tests.logout();

select is(pg_temp.role_of('bs-researcher@example.test'), 'researcher',
  'after every attempt through the API the account is still a researcher');
select is(pg_temp.masters(), 3, 'and the master admins are the three the owner made');

-- ===========================================================================
-- It never creates an account
-- ===========================================================================

select is((select count(*)::integer from auth.users), (select b.users from before_counts b),
  'no call created an account');
select is(pg_temp.provisioned(), 3, 'three promotions are in the audit log, one per account the owner promoted');

select * from finish();
rollback;
