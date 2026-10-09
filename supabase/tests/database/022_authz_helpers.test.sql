-- The helpers every policy and RPC is built on: errors, time, the role matrix,
-- "is this caller still allowed", and the policies on profiles, audit_log and
-- instance_settings.
--
-- require_active() and require_role() are not callable by clients; RPCs call
-- them. Two throwaway definer functions stand in for an RPC here, so the
-- checks run exactly as they will in production: as "authenticated", with only
-- the JWT claims to go on.
--
-- Clients cannot read any table (010, 011). The policies are kept as a second
-- lock, and this file proves they still hold: it grants the three tables for
-- the length of its own transaction, as a mistaken migration would, and then
-- reads them as each kind of caller.

begin;
select plan(90);

grant select on public.profiles, public.audit_log, public.instance_settings to authenticated;

create function public._tap_require_active() returns uuid
language sql security definer set search_path = '' as $$ select private.require_active() $$;

create function public._tap_require_role(p_min text) returns text
language sql security definer set search_path = '' as $$ select (private.require_role(p_min)).role $$;

grant execute on function public._tap_require_active(), public._tap_require_role(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('az-researcher@example.test');
select tests.create_user('az-supervisor@example.test', 'supervisor');
select tests.create_user('az-admin@example.test', 'admin');
select tests.create_user('az-master@example.test', 'master_admin');
select tests.create_user('az-suspended@example.test');
select tests.create_user('az-suspended-admin@example.test', 'admin');
select tests.create_user('az-invited@example.test', 'admin', false);
select tests.create_user('az-deleted@example.test');
select tests.create_user('az-unconfirmed@example.test');

update public.profiles set name = 'Rosalind Researcher' where email = 'az-researcher@example.test';
update public.profiles set status = 'suspended'
 where email in ('az-suspended@example.test', 'az-suspended-admin@example.test');
update public.profiles set status = 'deleted', email = null where id = tests.user_id('az-deleted@example.test');
update auth.users set email_confirmed_at = null where id = tests.user_id('az-unconfirmed@example.test');

select private.write_audit(tests.user_id('az-master@example.test'), 'tap.authz_marker');

-- ===========================================================================
-- Pure helpers
-- ===========================================================================

select results_eq(
  $$ select r, private.role_rank(r)
       from unnest(array['researcher', 'supervisor', 'admin', 'master_admin', 'owner', '', null]) with ordinality as t (r, n)
      order by n $$,
  $$ values ('researcher', 0), ('supervisor', 1), ('admin', 2), ('master_admin', 3),
            ('owner', null), ('', null), (null, null) $$,
  'role_rank orders the four instance roles and gives null for anything else');

-- The legacy server's canManageRole matrix, cell by cell.
select results_eq(
  $$ select a, t, private.can_manage_role(a, t)
       from unnest(array['researcher', 'supervisor', 'admin', 'master_admin']) with ordinality as x (a, an)
      cross join unnest(array['researcher', 'supervisor', 'admin', 'master_admin']) with ordinality as y (t, tn)
      order by an, tn $$,
  $$ values
       ('researcher',   'researcher', false), ('researcher',   'supervisor', false),
       ('researcher',   'admin',      false), ('researcher',   'master_admin', false),
       ('supervisor',   'researcher', false), ('supervisor',   'supervisor', false),
       ('supervisor',   'admin',      false), ('supervisor',   'master_admin', false),
       ('admin',        'researcher', true),  ('admin',        'supervisor', true),
       ('admin',        'admin',      false), ('admin',        'master_admin', false),
       ('master_admin', 'researcher', true),  ('master_admin', 'supervisor', true),
       ('master_admin', 'admin',      true),  ('master_admin', 'master_admin', true) $$,
  'can_manage_role: a master admin manages anyone, an admin only researchers and supervisors, nobody else anyone');

select is(private.can_manage_role(null, 'researcher'), false, 'can_manage_role: an unknown actor manages nobody (false, not null)');
select is(private.can_manage_role('admin', null), false,      'can_manage_role: an admin cannot manage an unknown role (false, not null)');
select is(private.can_manage_role('owner', 'researcher'), false, 'can_manage_role: a project role is not an instance role');

select is(private.to_ms('2026-01-01 00:00:00+00'), 1767225600000, 'to_ms gives epoch milliseconds');
select is(private.to_ms('2026-01-01 00:00:00.0019+00'), 1767225600001, 'to_ms floors, as Date.getTime() does');
select is(private.to_ms('2026-01-01 05:00:00+05'), 1767225600000, 'to_ms does not depend on the time zone the instant was written in');
select is(private.to_ms(null), null, 'to_ms of null is null');

select tests.throws_code($$ select private.fail('conflict', 409) $$, 'conflict', 409,
  'fail raises the PostgREST error with its code and HTTP status');
select throws_ok(
  $$ select private.fail('invalid_input', 400, 'title is required') $$,
  'PGRST',
  '{"code": "invalid_input", "hint": null, "details": "title is required", "message": "invalid_input"}',
  'fail puts code, message, details and hint in the JSON body PostgREST forwards');

-- ===========================================================================
-- An active caller
-- ===========================================================================

select tests.login_as('az-researcher@example.test');

select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');
select ok(private.is_active(), 'active researcher: is_active');
select ok(not private.is_admin(), 'active researcher: not an admin');
select ok(not private.is_master(), 'active researcher: not a master admin');
select is(public._tap_require_active(), tests.user_id('az-researcher@example.test'),
  'active researcher: require_active returns their own id');
select is(public._tap_require_role('researcher'), 'researcher',
  'active researcher: require_role(researcher) returns their profile');
select tests.throws_code($$ select public._tap_require_role('supervisor') $$, 'forbidden', 403,
  'researcher: require_role(supervisor) is forbidden');
select tests.throws_code($$ select public._tap_require_role('admin') $$, 'forbidden', 403,
  'researcher: require_role(admin) is forbidden');
select tests.throws_code($$ select public._tap_require_role('master_admin') $$, 'forbidden', 403,
  'researcher: require_role(master_admin) is forbidden');
select throws_ok($$ select public._tap_require_role('owner') $$, 'P0001', 'require_role: unknown role owner',
  'require_role with a role that does not exist fails loudly instead of letting the caller through');
select throws_ok($$ select public._tap_require_role(null) $$, 'P0001', 'require_role: unknown role <null>',
  'require_role(null) fails loudly too');

-- Policies: a researcher sees their own profile and nothing administrative.
select results_eq(
  $$ select email, name, role, status from public.profiles $$,
  $$ values ('az-researcher@example.test', 'Rosalind Researcher', 'researcher', 'active') $$,
  'researcher: reads exactly one profile, their own');
select is_empty($$ select 1 from public.audit_log $$, 'researcher: reads no audit rows');
select is_empty($$ select 1 from public.instance_settings $$, 'researcher: reads no settings row');

select tests.login_as('az-supervisor@example.test');
select ok(private.is_active() and not private.is_admin() and not private.is_master(),
  'supervisor: active, and the instance role grants nothing administrative');
select is(public._tap_require_role('supervisor'), 'supervisor', 'supervisor: passes require_role(supervisor)');
select tests.throws_code($$ select public._tap_require_role('admin') $$, 'forbidden', 403,
  'supervisor: require_role(admin) is forbidden');
select is((select count(*)::integer from public.profiles), 1, 'supervisor: reads only their own profile');

select tests.login_as('az-admin@example.test');
select ok(private.is_active() and private.is_admin() and not private.is_master(),
  'admin: active, an admin, not a master admin');
select is(public._tap_require_role('admin'), 'admin', 'admin: passes require_role(admin)');
select is(public._tap_require_role('researcher'), 'admin', 'admin: passes a lower bar too (the check is "at least")');
select tests.throws_code($$ select public._tap_require_role('master_admin') $$, 'forbidden', 403,
  'admin: require_role(master_admin) is forbidden');
select is((select count(*)::integer from public.profiles where email like 'az-%@example.test'), 8,
  'admin: reads every profile that still has an email');
select is((select count(*)::integer from public.profiles where id = tests.user_id('az-deleted@example.test')), 1,
  'admin: reads deleted profiles too');
select is((select count(*)::integer from public.audit_log where action = 'tap.authz_marker'), 1,
  'admin: reads the audit log');
select is((select count(*)::integer from public.instance_settings), 1, 'admin: reads the settings row');

select tests.login_as('az-master@example.test');
select ok(private.is_active() and private.is_admin() and private.is_master(),
  'master admin: active, an admin and a master admin');
select is(public._tap_require_role('master_admin'), 'master_admin', 'master admin: passes require_role(master_admin)');
select is(public._tap_require_role('admin'), 'master_admin', 'master admin: passes require_role(admin)');
select cmp_ok((select count(*)::integer from public.profiles), '>=', 9, 'master admin: reads every profile');

-- ===========================================================================
-- A token whose session is gone (signed out, revoked, or suspended elsewhere)
-- ===========================================================================

select tests.logout();
delete from auth.sessions where user_id = tests.user_id('az-admin@example.test');
select tests.resume_as('az-admin@example.test');

select is(auth.uid(), tests.user_id('az-admin@example.test'), 'revoked: the token still names the admin');
select ok(not private.is_active(), 'revoked: not active');
select ok(not private.is_admin(), 'revoked: no longer an admin for any policy');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'revoked: require_active says unauthenticated');
select tests.throws_code($$ select public._tap_require_role('admin') $$, 'unauthenticated', 401,
  'revoked: require_role says unauthenticated, not forbidden');
select is((select count(*)::integer from public.profiles), 1,
  'revoked: the admin reads only their own profile now');
select is_empty($$ select 1 from public.audit_log $$, 'revoked: reads no audit rows');
select is_empty($$ select 1 from public.instance_settings $$, 'revoked: reads no settings row');

-- A fresh sign-in makes the same account whole again.
select tests.login_as('az-admin@example.test');
select ok(private.is_admin(), 'signed in again: an admin once more');

-- A session id that belongs to somebody else does not count.
select tests.login_as('az-master@example.test');
select tests.logout();
select tests._present(
  tests.user_id('az-researcher@example.test'), 'az-researcher@example.test',
  (select s.session_id from tests.issued_sessions s where s.email = 'az-master@example.test'));
select ok(not private.is_active(), 'another user''s session id: not active');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'another user''s session id: unauthenticated');

-- No session id in the token at all.
select tests.logout();
select tests._present(tests.user_id('az-researcher@example.test'), 'az-researcher@example.test', null);
select ok(not private.is_active(), 'no session id claim: not active');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'no session id claim: unauthenticated');

-- A token for a user that does not exist.
select tests.logout();
select tests._present(gen_random_uuid(), 'az-ghost@example.test', gen_random_uuid());
select ok(not private.is_active(), 'unknown user: not active');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'unknown user: unauthenticated');
select is_empty($$ select 1 from public.profiles $$, 'unknown user: reads no profile');

-- Role "authenticated" with no claims at all.
select tests.logout();
set local role authenticated;
select is(auth.uid(), null, 'no claims: there is no caller');
select ok(not private.is_active() and not private.is_admin() and not private.is_master(), 'no claims: nothing is true');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'no claims: unauthenticated');
select is_empty($$ select 1 from public.profiles $$, 'no claims: reads no profile');
reset role;

-- ===========================================================================
-- Suspended
-- ===========================================================================

select tests.login_as('az-suspended@example.test');
select ok(not private.is_active(), 'suspended: not active even with a live session');
select tests.throws_code($$ select public._tap_require_active() $$, 'account_suspended', 403,
  'suspended with a live session: account_suspended');
select tests.throws_code($$ select public._tap_require_role('researcher') $$, 'account_suspended', 403,
  'suspended: require_role reports the suspension, not the role');
select results_eq(
  $$ select email, status from public.profiles $$,
  $$ values ('az-suspended@example.test', 'suspended') $$,
  'suspended: can still read their own profile, which is how the app tells them why');

select tests.logout();
delete from auth.sessions where user_id = tests.user_id('az-suspended@example.test');
select tests.resume_as('az-suspended@example.test');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'suspended and sessions revoked (what an admin suspension does): unauthenticated');
select results_eq(
  $$ select status from public.profiles $$, $$ values ('suspended') $$,
  'suspended and sessions revoked: the old token still reads its own status');

select tests.login_as('az-suspended-admin@example.test');
select ok(not private.is_admin(), 'suspended admin: not an admin');
select is((select count(*)::integer from public.profiles), 1, 'suspended admin: reads only their own profile');
select is_empty($$ select 1 from public.audit_log $$, 'suspended admin: reads no audit rows');
select is_empty($$ select 1 from public.instance_settings $$, 'suspended admin: reads no settings row');

-- ===========================================================================
-- Invited, password not set yet
-- ===========================================================================

select tests.login_as('az-invited@example.test');
select ok(not private.is_active(), 'invited: not active until a password is set');
select ok(not private.is_admin(), 'invited admin: the role is worth nothing until a password is set');
select tests.throws_code($$ select public._tap_require_active() $$, 'password_reset_required', 403,
  'invited: password_reset_required');
select tests.throws_code($$ select public._tap_require_role('admin') $$, 'password_reset_required', 403,
  'invited admin: require_role reports the missing password');
select results_eq(
  $$ select email, role, must_set_password from public.profiles $$,
  $$ values ('az-invited@example.test', 'admin', true) $$,
  'invited: reads their own profile, which is how the app knows to ask for a password');
select is_empty($$ select 1 from public.audit_log $$, 'invited admin: reads no audit rows yet');

-- Setting the password (as Auth would) opens the account without a new sign-in.
select tests.logout();
update auth.users
   set email_confirmed_at = now()
 where id = tests.user_id('az-invited@example.test');
update auth.users
   set encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
 where id = tests.user_id('az-invited@example.test');
select tests.resume_as('az-invited@example.test');
select ok(private.is_active() and private.is_admin(), 'invited admin: active and an admin once the password is set');
select is(public._tap_require_role('admin'), 'admin', 'invited admin: now passes require_role(admin)');

-- ===========================================================================
-- Deleted
-- ===========================================================================

select tests.login_as('az-deleted@example.test');
select ok(not private.is_active(), 'deleted: not active');
select tests.throws_code($$ select public._tap_require_active() $$, 'unauthenticated', 401,
  'deleted: unauthenticated, the account is gone');

-- ===========================================================================
-- The confirmed email
-- ===========================================================================

select tests.login_as('az-researcher@example.test');
select is(private.current_confirmed_email(), 'az-researcher@example.test',
  'current_confirmed_email: the caller''s confirmed address');

select tests.login_as('az-unconfirmed@example.test');
select is(private.current_confirmed_email(), null,
  'current_confirmed_email: null while the address is unconfirmed');

-- It is read from auth.users, not from the token. The holder changes their own
-- address: Auth moves email_change into email once the emailed code is typed.
select tests.logout();
update auth.users set email_change = 'az-researcher-moved@example.test'
 where id = tests.user_id('az-researcher@example.test');
update auth.users set email = email_change, email_change = ''
 where id = tests.user_id('az-researcher@example.test');
select tests.resume_as('az-researcher@example.test');
select is(auth.jwt() ->> 'email', 'az-researcher@example.test', 'email change: the old token still carries the old address');
select is(private.current_confirmed_email(), 'az-researcher-moved@example.test',
  'current_confirmed_email: follows auth.users, not the address in the token');

-- An address somebody else put there (the admin API writes email alone) is not
-- a confirmed address, although Auth still holds the account as confirmed.
select tests.logout();
update auth.users set email = 'az-researcher-set-by-admin@example.test'
 where id = tests.user_id('az-researcher-moved@example.test');
select isnt((select email_confirmed_at from auth.users where email = 'az-researcher-set-by-admin@example.test'), null,
  '(scene) Auth still holds the account as confirmed after an administrator changed its address');
select tests.resume_as('az-researcher@example.test');
select is(private.current_confirmed_email(), null,
  'current_confirmed_email: null for an address the holder has not proven (026)');

-- ===========================================================================
-- Without an account
-- ===========================================================================

select tests.as_anon();
select throws_ok($$ select private.is_active() $$, '42501', null, 'anon cannot ask whether it is active');
select throws_ok($$ select public._tap_require_active() $$, '42501', null,
  'anon cannot call a function it was not granted, definer or not');

select tests.logout();

-- The owner of the database is not a client: with no claims, nothing is "active".
select ok(not private.is_active() and not private.is_admin() and not private.is_master(),
  'as the owner with no claims: the helpers describe a caller, and there is none');

select * from finish();
rollback;
