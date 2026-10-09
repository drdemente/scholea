-- Administration of accounts: what each admin and master admin function does.
--
-- Legacy parity (old server, admin.test.ts): inviting a user gives an account
-- that must still set a password, and a second invitation to the same address
-- is refused; suspending revokes live sessions at once and the account cannot
-- get back in; a soft delete keeps the audit trail; the master surface creates
-- admins and protects the last master admin.
--
-- New here: the last-master protection also holds on the admin surface, where
-- the legacy server had none, and only master admins who can actually sign in
-- count as "another master admin".
--
-- Who is let in at all is 060. Settings are 075.
--
-- Auth is simulated by writing to auth.users the way it does, which fires the
-- real triggers. The pg_temp helpers marked SECURITY DEFINER let the test look
-- at (or act on) the database as its owner while a client stays signed in.

begin;
select plan(268);

-- ---------------------------------------------------------------------------
-- Helpers
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

-- The fixtures in a list of users, in the order the list has them. Accounts
-- that are not fixtures of this file (a developer's own) are skipped.
create function pg_temp.keys_of(p_list jsonb, p_prefix text default '') returns text language sql stable as $$
  select coalesce(string_agg(i.k, ',' order by t.n), '')
    from jsonb_array_elements(p_list) with ordinality as t (u, n)
    join ids i on i.id = (t.u ->> 'id')::uuid
   where i.k like p_prefix || '%';
$$;

create function pg_temp.obj_keys(p jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;

create function pg_temp.profile(p_key text)
returns table (email text, name text, institution text, role text, status text, must_set_password boolean)
language sql stable security definer as $$
  select p.email, p.name, p.institution, p.role, p.status, p.must_set_password
    from public.profiles p where p.id = (select i.id from ids i where i.k = p_key);
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

create function pg_temp.audit_count(p_key text) returns integer language sql stable security definer as $$
  select count(*)::integer from public.audit_log a
   where a.target_id = (select i.id::text from ids i where i.k = p_key);
$$;

create function pg_temp.session_count(p_key text) returns integer language sql stable security definer as $$
  select count(*)::integer from auth.sessions s where s.user_id = (select i.id from ids i where i.k = p_key);
$$;

create function pg_temp.refresh_token_count(p_key text) returns integer language sql stable security definer as $$
  select count(*)::integer from auth.refresh_tokens t
   where t.user_id = (select i.id::text from ids i where i.k = p_key);
$$;

-- A refresh token for one of the account's sessions, as Auth keeps them.
create function pg_temp.add_refresh_token(p_key text) returns void language sql security definer as $$
  insert into auth.refresh_tokens (instance_id, token, user_id, session_id, revoked, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', 'tap-' || gen_random_uuid(), s.user_id::text, s.id, false, now(), now()
    from auth.sessions s
   where s.user_id = (select i.id from ids i where i.k = p_key)
   limit 1;
$$;

create function pg_temp.intents(p_email text)
returns table (kind text, actor text, target text, payload jsonb, fresh boolean)
language sql stable security definer as $$
  select n.kind,
         (select i.k from ids i where i.id = n.actor_id),
         (select i.k from ids i where i.id = n.target_id),
         n.payload,
         n.created_at > now() - interval '1 minute'
    from private.admin_intents n where n.email = p_email;
$$;

-- Which of these addresses have an intent recorded, in alphabetical order.
create function pg_temp.have_intents(variadic p_emails text[]) returns text[]
language sql stable security definer as $$
  select coalesce(array_agg(n.email order by n.email), '{}')
    from private.admin_intents n where n.email = any (p_emails);
$$;

-- What Auth does when it sends an invitation: a new user with no password.
create function pg_temp.auth_invite(p_key text, p_email text, p_meta jsonb default '{}')
returns void language plpgsql security definer as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, invited_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, '', now(),
          '{"provider":"email","providers":["email"]}'::jsonb, p_meta, now(), now());
  insert into ids values (p_key, v_id);
end $$;

-- What the Auth admin API does to change an address.
create function pg_temp.auth_set_email(p_key text, p_email text) returns void language sql security definer as $$
  update auth.users set email = p_email where id = (select i.id from ids i where i.k = p_key);
$$;

-- What Auth does when an invited person types their invitation code.
create function pg_temp.auth_confirm(p_key text) returns void language sql security definer as $$
  update auth.users set email_confirmed_at = now() where id = (select i.id from ids i where i.k = p_key);
$$;

grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select pg_temp.mk('master',  'ad-master@example.test',  'master_admin');
select pg_temp.mk('master2', 'ad-master2@example.test', 'master_admin');
select pg_temp.mk('admin',   'ad-admin@example.test',   'admin');
select pg_temp.mk('admin2',  'ad-admin2@example.test',  'admin');
select pg_temp.mk('res',     'ad-res@example.test');
select pg_temp.mk('victim',  'ad-victim@example.test');
select pg_temp.mk('revoke',  'ad-revoke@example.test');
select pg_temp.mk('doomed',  'ad-doomed@example.test', 'supervisor');
select pg_temp.mk('mdoomed', 'ad-mdoomed@example.test', 'admin');
select pg_temp.mk('selfsign','ad-selfsign@example.test');
select pg_temp.mk('gone',    'ad-gone@example.test');

-- Signed up with a password, code not entered yet.
update auth.users set email_confirmed_at = null where id = pg_temp.id('selfsign');
-- Deleted all the way: Auth soft-deleted the user, which obfuscates the address
-- there and marks the profile.
update auth.users set deleted_at = now(), email = 'obfuscated-ad-gone', encrypted_password = null
 where id = pg_temp.id('gone');

-- Six accounts for the list, L1 the oldest and L6 the newest.
select pg_temp.mk('L1', 'ad-adlist-alice@example.test');
select pg_temp.mk('L2', 'ad-adlist-bob@example.test', 'supervisor');
select pg_temp.mk('L3', 'ad-adlist-carol@example.test');
select pg_temp.mk('L4', 'ad-adlist-dave@example.test', 'admin');
select pg_temp.mk('L5', 'ad-adlist-erin@example.test');
select pg_temp.mk('L6', 'ad-adlist-frank@example.test', 'researcher', false);

update public.profiles set name = 'Alice Zephyr',        institution = 'North College' where id = pg_temp.id('L1');
update public.profiles set name = 'Bob 100%_sure',       institution = 'South_Inst'    where id = pg_temp.id('L2');
update public.profiles set name = 'Carol\Slash',         institution = 'Under!score', status = 'suspended'
 where id = pg_temp.id('L3');
update public.profiles set name = 'Dave'                                                where id = pg_temp.id('L4');
-- L5 is a delete that stopped half way: the profile is marked, Auth still holds the address.
update public.profiles set name = 'Erin Adlist-Deleted', status = 'deleted', email = null where id = pg_temp.id('L5');
update public.profiles p
   set created_at = '2026-01-01 00:00:00+00'::timestamptz + make_interval(mins => substr(i.k, 2)::integer)
  from ids i
 where i.id = p.id and i.k ~ '^L[1-6]$';
update auth.users set last_sign_in_at = '2026-03-01 12:00:00+00' where id = pg_temp.id('L1');

-- More accounts than one answer holds. They are the oldest, so they are the
-- ones an unfiltered list cuts off.
select count(*) as cap_fixtures
  from (select tests.create_user('ad-adcap-' || g || '@example.test', 'researcher', false)
          from generate_series(1, 1001) g) made;
update public.profiles set created_at = '2025-01-01 00:00:00+00' where email like 'ad-adcap-%@example.test';

-- ===========================================================================
-- admin_list_users
-- ===========================================================================

select tests.login_as('ad-admin@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(pg_temp.obj_keys(public.admin_list_users('adlist')), 'total,users',
  'admin_list_users: returns {users, total}');
select is(pg_temp.keys_of(public.admin_list_users('adlist') -> 'users', 'L'), 'L6,L4,L3,L2,L1',
  'admin_list_users: newest first, and deleted accounts are left out by default');
select is(public.admin_list_users('adlist') -> 'total', '5'::jsonb,
  'admin_list_users: total counts the accounts that match');

select is(
  (select u from jsonb_array_elements(public.admin_list_users('adlist-alice') -> 'users') u),
  jsonb_build_object(
    'id',                pg_temp.id('L1'),
    'email',             'ad-adlist-alice@example.test',
    'name',              'Alice Zephyr',
    'institution',       'North College',
    'role',              'researcher',
    'status',            'active',
    'mustResetPassword', false,
    'lastLoginAt',       1772366400000,
    'createdAt',         1767225660000,
    'emailConfirmed',    true),
  'admin_list_users: each entry is the User object, with times in epoch milliseconds');

select is(pg_temp.keys_of(public.admin_list_users() -> 'users', 'L'), 'L6,L4,L3,L2,L1',
  'admin_list_users: with no arguments, everyone who is not deleted');
select is(pg_temp.keys_of(public.admin_list_users('', '', '') -> 'users', 'L'), 'L6,L4,L3,L2,L1',
  'admin_list_users: empty strings mean "no filter"');
select is(public.admin_list_users('   ') -> 'total', public.admin_list_users() -> 'total',
  'admin_list_users: a search text of spaces is no search');

-- Filters.
select is(pg_temp.keys_of(public.admin_list_users('adlist', 'active') -> 'users', 'L'), 'L6,L4,L2,L1',
  'admin_list_users: status active');
select is(pg_temp.keys_of(public.admin_list_users('adlist', 'suspended') -> 'users', 'L'), 'L3',
  'admin_list_users: status suspended');
select is(pg_temp.keys_of(public.admin_list_users(null, 'deleted') -> 'users', 'L'), 'L5',
  'admin_list_users: deleted accounts are listed only when asked for');
select is(public.admin_list_users('adlist', 'deleted') -> 'users' -> 0 ->> 'email', '',
  'admin_list_users: a deleted account has an empty email, and is found by its name');
select is(pg_temp.keys_of(public.admin_list_users('adlist', null, 'supervisor') -> 'users', 'L'), 'L2',
  'admin_list_users: role filter');
select is(pg_temp.keys_of(public.admin_list_users(p_role => 'admin') -> 'users', 'L'), 'L4',
  'admin_list_users: role filter on its own');
select is(pg_temp.keys_of(public.admin_list_users('adlist', 'active', 'researcher') -> 'users', 'L'), 'L6,L1',
  'admin_list_users: all three together');

-- The search covers email, name and institution, in any letter case.
select is(pg_temp.keys_of(public.admin_list_users('ADLIST-BOB@EXAMPLE') -> 'users', 'L'), 'L2',
  'admin_list_users: search matches the email, whatever the letter case');
select is(pg_temp.keys_of(public.admin_list_users('zephyr') -> 'users', 'L'), 'L1',
  'admin_list_users: search matches the name');
select is(pg_temp.keys_of(public.admin_list_users('  north col ') -> 'users', 'L'), 'L1',
  'admin_list_users: search matches the institution, and the text is trimmed');

-- The text is matched as written. An unescaped % or _ would match every account.
select is(pg_temp.keys_of(public.admin_list_users('%') -> 'users', 'L'), 'L2',
  'admin_list_users: % finds a literal percent sign, it is not a wildcard');
select is(pg_temp.keys_of(public.admin_list_users('_') -> 'users', 'L'), 'L2',
  'admin_list_users: _ finds a literal underscore, it is not a wildcard');
select is(pg_temp.keys_of(public.admin_list_users('100%_s') -> 'users', 'L'), 'L2',
  'admin_list_users: a text with both is still literal');
select is(pg_temp.keys_of(public.admin_list_users('a%e') -> 'users', 'L'), '',
  'admin_list_users: "a%e" does not match "Alice" or "Dave"');
select is(pg_temp.keys_of(public.admin_list_users('!') -> 'users', 'L'), 'L3',
  'admin_list_users: the escape character itself is literal');
select is(pg_temp.keys_of(public.admin_list_users('!!') -> 'users', 'L'), '',
  'admin_list_users: and is not doubled');
select is(pg_temp.keys_of(public.admin_list_users('l\s') -> 'users', 'L'), 'L3',
  'admin_list_users: a backslash is literal too');
select is(pg_temp.keys_of(public.admin_list_users($q$'; drop table public.profiles; --$q$) -> 'users', 'L'), '',
  'admin_list_users: a quote in the search text is just text');

-- The cap.
select is(jsonb_array_length(public.admin_list_users('ad-adcap-') -> 'users'), 1000,
  'admin_list_users: at most 1000 accounts are returned');
select is(public.admin_list_users('ad-adcap-') -> 'total', '1001'::jsonb,
  'admin_list_users: total still counts them all, so the client can ask for a narrower search');

select tests.throws_code($$ select public.admin_list_users(null, 'banana') $$, 'invalid_input', 400,
  'admin_list_users: an unknown status is refused');
select tests.throws_code($$ select public.admin_list_users(null, null, 'owner') $$, 'invalid_input', 400,
  'admin_list_users: an unknown role is refused');
select tests.throws_code($$ select public.admin_list_users(repeat('x', 201)) $$, 'invalid_input', 400,
  'admin_list_users: a search text over 200 characters is refused');
select is(public.admin_list_users(repeat('x', 200)) -> 'users', '[]'::jsonb,
  'admin_list_users: 200 characters are accepted, and no match is an empty list');

-- ===========================================================================
-- admin_get_user
-- ===========================================================================

select is(
  public.admin_get_user(pg_temp.id('L1')),
  jsonb_build_object('user', (select u from jsonb_array_elements(public.admin_list_users('adlist-alice') -> 'users') u)),
  'admin_get_user: {user} with the same User object the list gives');
select is(public.admin_get_user(pg_temp.id('master')) -> 'user' ->> 'role', 'master_admin',
  'admin_get_user: an admin may read a master admin''s account (reading is not managing)');
select is(public.admin_get_user(pg_temp.id('L6')) -> 'user' -> 'mustResetPassword', 'true'::jsonb,
  'admin_get_user: an invited account that has not set a password says so');
select tests.throws_code($$ select public.admin_get_user(gen_random_uuid()) $$, 'not_found', 404,
  'admin_get_user: an unknown id is not_found');
select tests.throws_code($$ select public.admin_get_user(pg_temp.id('L5')) $$, 'not_found', 404,
  'admin_get_user: a deleted account is not_found');
select tests.throws_code($$ select public.admin_get_user(null) $$, 'not_found', 404,
  'admin_get_user: no id is not_found');

-- ===========================================================================
-- admin_update_user
-- ===========================================================================

select is(
  (public.admin_update_user(pg_temp.id('res'), '{"name":"  Rosalind Res \n","institution":" Kings "}') -> 'user')
    - 'createdAt' - 'lastLoginAt',
  jsonb_build_object(
    'id', pg_temp.id('res'), 'email', 'ad-res@example.test', 'name', 'Rosalind Res', 'institution', 'Kings',
    'role', 'researcher', 'status', 'active', 'mustResetPassword', false, 'emailConfirmed', true),
  'admin_update_user: returns {user} with the new name and institution, trimmed');
select results_eq(
  $$ select * from pg_temp.audit('res') $$,
  $$ values ('admin', 'admin.user_updated',
             '{"name":"","institution":"","role":"researcher"}'::jsonb,
             '{"name":"Rosalind Res","institution":"Kings","role":"researcher"}'::jsonb) $$,
  'admin_update_user: one audit row, admin.user_updated, with the three values before and after');

select is(public.admin_update_user(pg_temp.id('res'), '{"role":"supervisor"}') -> 'user' ->> 'role', 'supervisor',
  'admin_update_user: an admin can make a researcher a supervisor');
select results_eq(
  $$ select name, institution, role from pg_temp.profile('res') $$,
  $$ values ('Rosalind Res', 'Kings', 'supervisor') $$,
  'admin_update_user: a key that is left out keeps its value');
select is(
  (select array[before_data ->> 'role', after_data ->> 'role'] from pg_temp.audit('res') offset 1),
  array['researcher', 'supervisor'],
  'admin_update_user: the role change is audited with the role before and after');

-- Nothing to change: nothing is written.
select is(public.admin_update_user(pg_temp.id('res'), '{}') -> 'user' ->> 'name', 'Rosalind Res',
  'admin_update_user: an empty patch is accepted and returns the account');
select is(
  public.admin_update_user(pg_temp.id('res'), '{"name":" Rosalind Res ","institution":"Kings","role":"supervisor"}')
    -> 'user' ->> 'role', 'supervisor',
  'admin_update_user: sending the current values is accepted');
select is(pg_temp.audit_count('res'), 2,
  'admin_update_user: a patch that changes nothing writes no audit row');

select is(public.admin_update_user(pg_temp.id('res'), '{"name":"","institution":""}') -> 'user' ->> 'name', '',
  'admin_update_user: an empty string clears the value');
select is(
  char_length(public.admin_update_user(pg_temp.id('res'),
    jsonb_build_object('name', '  ' || repeat('n', 200) || '  ')) -> 'user' ->> 'name'), 200,
  'admin_update_user: 200 characters are accepted, counted after trimming');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('res'), jsonb_build_object('name', repeat('n', 201))) $$,
  'invalid_input', 400, 'admin_update_user: a name over 200 characters is refused');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('res'), jsonb_build_object('institution', repeat('i', 201))) $$,
  'invalid_input', 400, 'admin_update_user: an institution over 200 characters is refused');

-- Only the three keys. Email and status have their own functions.
select tests.throws_code(format('select public.admin_update_user(pg_temp.id(''res''), %L)', t.patch),
         'invalid_input', 400, 'admin_update_user: refused, ' || t.why)
  from (values
    (1, '{"email":"ad-other@example.test"}',  'the email is not changed here'),
    (2, '{"status":"suspended"}',             'the status is not changed here'),
    (3, '{"must_set_password":false}',        'the password flag is never a client''s to set'),
    (4, '{"name":"x","id":"00000000-0000-4000-8000-000000000000"}', 'an id in the patch'),
    (5, '{"mustResetPassword":false}',        'the camel-case password flag'),
    (6, '[]',                                 'a patch that is a list'),
    (7, '"name"',                             'a patch that is a string'),
    (8, 'null',                               'a patch that is JSON null'),
    (9, '{"name":5}',                         'a name that is a number'),
    (10, '{"role":null}',                     'a role that is null'),
    (11, '{"role":["admin"]}',                'a role that is a list')) t (n, patch, why)
 order by t.n;
select tests.throws_code($$ select public.admin_update_user(pg_temp.id('res'), null) $$, 'invalid_input', 400,
  'admin_update_user: refused, no patch at all');

select tests.throws_code(format('select public.admin_update_user(pg_temp.id(''res''), %L)', t.patch),
         'invalid_role', 400, 'admin_update_user: invalid_role for ' || t.patch)
  from (values (1, '{"role":"owner"}'), (2, '{"role":""}'), (3, '{"role":"Admin"}'), (4, '{"role":"editor"}')) t (n, patch)
 order by t.n;

select tests.throws_code(
  $$ select public.admin_update_user(gen_random_uuid(), '{"name":"Nobody"}') $$, 'not_found', 404,
  'admin_update_user: an unknown id is not_found');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('gone'), '{"name":"Ghost"}') $$, 'not_found', 404,
  'admin_update_user: a deleted account is not_found');

select results_eq(
  $$ select email, status, must_set_password from pg_temp.profile('res') $$,
  $$ values ('ad-res@example.test', 'active', false) $$,
  'admin_update_user: email, status and the password flag are untouched by all of the above');

-- ===========================================================================
-- Inviting (admin.test.ts "creates a user ... forced reset", "duplicate")
-- ===========================================================================

select is(
  public.admin_begin_invite(E' Ad-New@Example.test \n', 'supervisor', '  New Person ', ' New Inst '),
  '{"ok":true,"email":"ad-new@example.test","role":"supervisor"}'::jsonb,
  'admin_begin_invite: returns the address as recorded (trimmed, lower case) and the role');
select results_eq(
  $$ select * from pg_temp.intents('ad-new@example.test') $$,
  $$ values ('invite', 'admin', null::text,
             '{"role":"supervisor","name":"New Person","institution":"New Inst","surface":"admin"}'::jsonb, true) $$,
  'admin_begin_invite: records the intent with the caller as actor');
select tests.as_owner();   -- a client cannot read a table: look at the stored rows as the owner
select is_empty(
  $$ select 1 from public.profiles where email = 'ad-new@example.test' $$,
  'admin_begin_invite: creates no account by itself');
select is_empty(
  $$ select 1 from public.audit_log where actor_id = pg_temp.id('admin') and action like '%created' $$,
  'admin_begin_invite: writes no audit row, because nothing has happened yet');
select tests.as_client();

-- Asking again before Auth has acted replaces the intent.
select is(
  public.admin_begin_invite('ad-new@example.test', 'researcher') ->> 'role', 'researcher',
  'admin_begin_invite: can be repeated for the same address');
select results_eq(
  $$ select payload from pg_temp.intents('ad-new@example.test') $$,
  $$ values ('{"role":"researcher","surface":"admin"}'::jsonb) $$,
  'admin_begin_invite: the newer intent replaces the older one, and an empty name is left to the invitation');
select is(
  public.admin_begin_invite('ad-new@example.test', 'supervisor', 'New Person', 'New Inst') ->> 'role', 'supervisor',
  'admin_begin_invite: and again');

-- Auth sends the invitation: the user appears, with no password.
select pg_temp.auth_invite('newbie', 'Ad-New@Example.test',
  '{"name":"Metadata Name","role":"master_admin","status":"suspended"}');

select results_eq(
  $$ select * from pg_temp.profile('newbie') $$,
  $$ values ('ad-new@example.test', 'New Person', 'New Inst', 'supervisor', 'active', true) $$,
  'invite: the new account has the role and name the admin chose, and must still set a password');
select results_eq(
  $$ select * from pg_temp.audit('newbie') $$,
  $$ values ('admin', 'admin.user_created', null::jsonb,
             '{"email":"ad-new@example.test","role":"supervisor","invited":true}'::jsonb) $$,
  'invite: audited as admin.user_created by the admin who invited, in the same transaction as the account');
select is_empty($$ select 1 from pg_temp.intents('ad-new@example.test') $$,
  'invite: the intent is used up');
select is(
  (public.admin_get_user(pg_temp.id('newbie')) -> 'user') - 'id' - 'createdAt',
  '{"email":"ad-new@example.test","name":"New Person","institution":"New Inst","role":"supervisor",
    "status":"active","mustResetPassword":true,"lastLoginAt":null,"emailConfirmed":false}'::jsonb,
  'invite: admin_get_user shows the invited account, mustResetPassword true (admin.test.ts 1)');

-- An address that already has an account is refused, whatever state it is in.
select tests.throws_code(format('select public.admin_begin_invite(%L, ''researcher'')', t.email),
         'email_taken', 409, 'admin_begin_invite: email_taken for ' || t.why)
  from (values
    (1, 'ad-new@example.test',          'the address just invited (admin.test.ts 1, duplicate)'),
    (2, 'ad-res@example.test',          'an existing account'),
    (3, ' AD-RES@Example.TEST ',        'an existing account in another letter case'),
    (4, 'ad-adlist-frank@example.test', 'somebody who was invited before'),
    (5, 'ad-selfsign@example.test',     'somebody who signed up and has not confirmed yet'),
    (6, 'ad-adlist-carol@example.test', 'a suspended account'),
    (7, 'ad-admin@example.test',        'the caller''s own address'),
    (8, 'ad-adlist-erin@example.test',  'an account whose delete stopped half way: Auth still holds the address'))
    t (n, email, why)
 order by t.n;
select is(
  pg_temp.have_intents('ad-res@example.test', 'ad-adlist-frank@example.test', 'ad-selfsign@example.test'),
  '{}'::text[],
  'admin_begin_invite: a refused invitation records no intent');
select results_eq(
  $$ select status, email from pg_temp.profile('gone') $$, $$ values ('deleted', null::text) $$,
  'a fully deleted account: Auth''s soft delete marked the profile');
select is(public.admin_begin_invite('ad-gone@example.test', 'researcher') ->> 'ok', 'true',
  'admin_begin_invite: the address of a fully deleted account is free again');

select tests.throws_code(format('select public.admin_begin_invite(%L, ''researcher'')', t.email),
         'invalid_input', 400, 'admin_begin_invite: invalid_input for ' || t.why)
  from (values
    (1, 'not-an-address',            'text without an @'),
    (2, 'ad-x@nodot',                'a domain without a dot'),
    (3, 'ad x@example.test',         'an address with a space'),
    (4, 'ad-x@@example.test',        'two @ signs'),
    (5, '',                          'an empty address'),
    (6, repeat('a', 242) || '@example.test', 'an address of 255 characters')) t (n, email, why)
 order by t.n;
select tests.throws_code($$ select public.admin_begin_invite(null, 'researcher') $$, 'invalid_input', 400,
  'admin_begin_invite: invalid_input for no address');
select tests.throws_code(
  $$ select public.admin_begin_invite('ad-long@example.test', 'researcher', repeat('n', 201)) $$,
  'invalid_input', 400, 'admin_begin_invite: a name over 200 characters is refused');
select tests.throws_code(
  $$ select public.admin_begin_invite('ad-long@example.test', 'researcher', null, repeat('i', 201)) $$,
  'invalid_input', 400, 'admin_begin_invite: an institution over 200 characters is refused');
select tests.throws_code(
  $$ select public.admin_begin_invite('ad-long@example.test', 'researcher', null, null, 'root') $$,
  'invalid_input', 400, 'admin_begin_invite: an unknown surface is refused');
select tests.throws_code(
  $$ select public.admin_begin_invite('ad-long@example.test', 'researcher', null, null, null) $$,
  'invalid_input', 400, 'admin_begin_invite: a null surface is refused');
select tests.throws_code($$ select public.admin_begin_invite('ad-long@example.test', null) $$, 'invalid_role', 400,
  'admin_begin_invite: the role is required on the admin surface');
select is(pg_temp.have_intents('ad-long@example.test'), '{}'::text[],
  'admin_begin_invite: none of the refused calls recorded an intent');

-- Intents nobody acted on are cleared away by the next one.
select tests.logout();
insert into private.admin_intents (kind, actor_id, email, payload, created_at)
values ('invite', pg_temp.id('admin'), 'ad-stale@example.test', '{"role":"admin"}', now() - interval '6 minutes'),
       ('invite', pg_temp.id('admin'), 'ad-fresh@example.test', '{"role":"researcher"}', now() - interval '4 minutes');
select tests.resume_as('ad-admin@example.test');
select is(public.admin_begin_invite('ad-next@example.test', 'researcher') ->> 'ok', 'true',
  'admin_begin_invite: another invitation');
select is(
  pg_temp.have_intents('ad-stale@example.test', 'ad-fresh@example.test', 'ad-next@example.test'),
  array['ad-fresh@example.test', 'ad-next@example.test'],
  'admin_begin_invite: intents older than five minutes are removed, newer ones are kept');

-- Another administrator asking for an address that already has a waiting
-- intent records their own. Nobody's request is replaced or changed by
-- somebody else's (which request Auth's invitation then uses is decided when
-- the account appears: 026).
select tests.login_as('ad-master@example.test');
select is(public.admin_begin_invite('ad-fresh@example.test', 'supervisor') ->> 'role', 'supervisor',
  'admin_begin_invite: an address that already has a waiting intent');
select results_eq(
  $$ select actor, payload, fresh from pg_temp.intents('ad-fresh@example.test') order by actor $$,
  $$ values ('admin',  '{"role":"researcher"}'::jsonb, false),
            ('master', '{"role":"supervisor","surface":"admin"}'::jsonb, true) $$,
  'admin_begin_invite: the other administrator''s intent is untouched, and the caller has one of their own');

-- The master surface (admin.test.ts "creates admins").
select is(
  public.admin_begin_invite('ad-newadmin@example.test', null, 'Second Admin', null, 'master'),
  '{"ok":true,"email":"ad-newadmin@example.test","role":"admin"}'::jsonb,
  'admin_begin_invite (master surface): the role defaults to admin');
select pg_temp.auth_invite('newadmin', 'ad-newadmin@example.test');
select results_eq(
  $$ select name, role, must_set_password from pg_temp.profile('newadmin') $$,
  $$ values ('Second Admin', 'admin', true) $$,
  'invite (master surface): the new account is an admin');
select results_eq(
  $$ select actor, action, after_data from pg_temp.audit('newadmin') $$,
  $$ values ('master', 'master.admin_created',
             '{"email":"ad-newadmin@example.test","role":"admin","invited":true}'::jsonb) $$,
  'invite (master surface): audited as master.admin_created');
select is(
  public.admin_begin_invite('ad-newmaster@example.test', 'master_admin', null, null, 'master') ->> 'role',
  'master_admin', 'admin_begin_invite (master surface): a master admin can invite another master admin');
select tests.throws_code(
  $$ select public.admin_begin_invite('ad-notadmin@example.test', 'researcher', null, null, 'master') $$,
  'invalid_role', 400, 'admin_begin_invite (master surface): only admin tier roles');
-- A master admin using the admin surface is audited as the admin surface.
select is(public.admin_begin_invite('ad-viaadmin@example.test', 'admin') ->> 'role', 'admin',
  'admin_begin_invite: a master admin may invite an admin on the admin surface too');
select pg_temp.auth_invite('viaadmin', 'ad-viaadmin@example.test');
select results_eq(
  $$ select actor, action from pg_temp.audit('viaadmin') $$,
  $$ values ('master', 'admin.user_created') $$,
  'invite: the surface, not the caller''s role, names the audit action');

-- ===========================================================================
-- Changing an email address
-- ===========================================================================
-- The change takes effect at once, and whoever reads the new mailbox can then
-- get into the account with "Forgot password". So the address of an account
-- that is in use (confirmed, password set) is a master admin's to change. An
-- admin may still correct the address of an account nobody can use yet. Both
-- halves are shown once here; the rule itself is pinned in 067. What the
-- function does is then tested as a master admin, on an account in use.

select tests.login_as('ad-admin@example.test');

select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), 'ad-res-moved@example.test') $$, 'forbidden', 403,
  'admin_begin_email_change: an admin may not change the address of an account that is in use');
select is(pg_temp.have_intents('ad-res-moved@example.test'), '{}'::text[],
  'admin_begin_email_change: and the refusal records no intent');
select is(
  public.admin_begin_email_change(pg_temp.id('L6'), 'ad-frank-typo@example.test'),
  '{"ok":true,"changed":true,"email":"ad-frank-typo@example.test","emailConfirmed":false}'::jsonb,
  'admin_begin_email_change: an admin may correct the address of an invited account that has no password yet, and the answer says when the account has not confirmed its address');
select is(
  public.admin_begin_email_change(pg_temp.id('selfsign'), 'ad-selfsign-typo@example.test') ->> 'changed', 'true',
  'admin_begin_email_change: and of somebody who signed up and never confirmed');

select tests.login_as('ad-master@example.test');

select is(
  public.admin_begin_email_change(pg_temp.id('res'), ' AD-Res-Moved@Example.test '),
  '{"ok":true,"changed":true,"email":"ad-res-moved@example.test","emailConfirmed":true}'::jsonb,
  'admin_begin_email_change: returns the address as recorded, and that the account is confirmed');
select results_eq(
  $$ select kind, actor, target, payload from pg_temp.intents('ad-res-moved@example.test') $$,
  $$ values ('email_change', 'master', 'res', '{}'::jsonb) $$,
  'admin_begin_email_change: records the intent for that account');
select is((select email from pg_temp.profile('res')), 'ad-res@example.test',
  'admin_begin_email_change: changes nothing by itself');

-- The Auth admin API changes the address.
select is(pg_temp.audit_count('res'), 4, 'four audit rows about this account so far');
select pg_temp.auth_set_email('res', 'ad-res-moved@example.test');
select is((select email from pg_temp.profile('res')), 'ad-res-moved@example.test',
  'email change: the profile follows Auth');
select results_eq(
  $$ select actor, action, before_data, after_data from pg_temp.audit('res') offset 4 $$,
  $$ values ('master', 'admin.user_updated',
             '{"email":"ad-res@example.test"}'::jsonb, '{"email":"ad-res-moved@example.test"}'::jsonb) $$,
  'email change: audited as admin.user_updated by the master admin who asked, with the address before and after');
select is_empty($$ select 1 from pg_temp.intents('ad-res-moved@example.test') $$,
  'email change: the intent is used up');

select is(
  public.admin_begin_email_change(pg_temp.id('res'), 'AD-RES-MOVED@example.test'),
  '{"ok":true,"changed":false,"email":"ad-res-moved@example.test","emailConfirmed":true}'::jsonb,
  'admin_begin_email_change: the address the account already has is "changed: false"');
select is_empty($$ select 1 from pg_temp.intents('ad-res-moved@example.test') $$,
  'admin_begin_email_change: and records no intent');
select is(public.admin_begin_email_change(pg_temp.id('res'), 'ad-gone@example.test') ->> 'changed', 'true',
  'admin_begin_email_change: the address of a deleted account is free');

-- A waiting intent for the same new address is NOT taken over. It names another
-- administrator and another account, and it stays as it is: otherwise one
-- request could point somebody else's at a different account and take that
-- administrator out of the audit record (026).
select tests.logout();
insert into private.admin_intents (kind, actor_id, target_id, email, created_at)
values ('email_change', pg_temp.id('master2'), pg_temp.id('L1'), 'ad-contested@example.test', now() - interval '4 minutes');
select tests.resume_as('ad-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('res'), 'ad-contested@example.test') ->> 'changed', 'true',
  'admin_begin_email_change: an address that already has a waiting intent');
select results_eq(
  $$ select actor, target, fresh from pg_temp.intents('ad-contested@example.test') order by actor $$,
  $$ values ('master', 'res', true), ('master2', 'L1', false) $$,
  'admin_begin_email_change: the other intent is untouched, and the caller has one of their own for their own target');

select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), 'AD-Victim@example.test') $$, 'email_taken', 409,
  'admin_begin_email_change: an address that belongs to another account is email_taken');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), 'ad-adlist-frank@example.test') $$, 'email_taken', 409,
  'admin_begin_email_change: so is the address of an invited account');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), 'ad-adlist-erin@example.test') $$, 'email_taken', 409,
  'admin_begin_email_change: and an address Auth still holds for a half-deleted account');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), 'nonsense') $$, 'invalid_input', 400,
  'admin_begin_email_change: not an address is invalid_input');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('res'), null) $$, 'invalid_input', 400,
  'admin_begin_email_change: no address is invalid_input');
select tests.throws_code(
  $$ select public.admin_begin_email_change(gen_random_uuid(), 'ad-any@example.test') $$, 'not_found', 404,
  'admin_begin_email_change: an unknown id is not_found');
select tests.throws_code(
  $$ select public.admin_begin_email_change(pg_temp.id('gone'), 'ad-any@example.test') $$, 'not_found', 404,
  'admin_begin_email_change: a deleted account is not_found');
select is(pg_temp.have_intents('ad-any@example.test'), '{}'::text[],
  'admin_begin_email_change: a refused change records no intent');

-- The rest of this file is the admin again.
select tests.login_as('ad-admin@example.test');

-- ===========================================================================
-- admin_check_user_action
-- ===========================================================================

select is(
  public.admin_check_user_action(pg_temp.id('L6'), 'resend_invite'),
  jsonb_build_object('ok', true, 'user', public.admin_get_user(pg_temp.id('L6')) -> 'user'),
  'admin_check_user_action: resend_invite is allowed for an account still waiting for its code, and returns it');
select is(
  public.admin_check_user_action(pg_temp.id('L6'), 'resend_invite') -> 'user' ->> 'email',
  'ad-adlist-frank@example.test',
  'admin_check_user_action: the answer carries the address to send to');

select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('res'), 'resend_invite') $$, 'not_pending', 409,
  'admin_check_user_action: resend_invite for an account with a password is not_pending');
select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('selfsign'), 'resend_invite') $$, 'not_pending', 409,
  'admin_check_user_action: resend_invite for somebody who signed up themselves is not_pending');
-- The invited person entered the code and stopped before choosing a password.
select pg_temp.auth_confirm('newbie');
select is(
  (select array[u ->> 'mustResetPassword', u ->> 'emailConfirmed']
     from (select public.admin_get_user(pg_temp.id('newbie')) -> 'user' as u) x),
  array['true', 'true'],
  'an invited person who entered the code but chose no password: confirmed, and still without a password');
select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('newbie'), 'resend_invite') $$, 'not_pending', 409,
  'admin_check_user_action: their code is used up, so resend_invite is not_pending (they use Forgot password)');

select is(public.admin_check_user_action(pg_temp.id('L3'), 'activate') -> 'user' ->> 'status', 'suspended',
  'admin_check_user_action: activate is allowed for a suspended account');
select is(public.admin_check_user_action(pg_temp.id('res'), 'activate') ->> 'ok', 'true',
  'admin_check_user_action: and for an active one (activating twice is harmless)');
select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('gone'), 'activate') $$, 'not_found', 404,
  'admin_check_user_action: a deleted account is not_found');
select tests.throws_code(
  $$ select public.admin_check_user_action(gen_random_uuid(), 'resend_invite') $$, 'not_found', 404,
  'admin_check_user_action: an unknown id is not_found');
select tests.throws_code(format('select public.admin_check_user_action(pg_temp.id(''res''), %L)', t.action),
         'invalid_input', 400, 'admin_check_user_action: unknown action ' || t.action)
  from unnest(array['suspend', 'delete', 'update_email', 'invite_user', '']) with ordinality as t (action, n)
 order by t.n;
select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('res'), null) $$, 'invalid_input', 400,
  'admin_check_user_action: no action is invalid_input');
select tests.throws_code(
  $$ select public.admin_check_user_action(pg_temp.id('res'), 'activate', 'root') $$, 'invalid_input', 400,
  'admin_check_user_action: an unknown surface is invalid_input');
select results_eq(
  $$ select status, (select count(*)::integer from pg_temp.audit('L3')) from pg_temp.profile('L3') $$,
  $$ values ('suspended', 0) $$,
  'admin_check_user_action: only checks. Nothing is changed and nothing is audited');

-- ===========================================================================
-- Suspending (admin.test.ts "suspending a user revokes their active sessions immediately")
-- ===========================================================================

-- The victim is signed in on two devices.
select tests.login_as('ad-victim@example.test');
select tests.login_as('ad-victim@example.test');
select pg_temp.add_refresh_token('victim');
select is(public.my_profile() -> 'user' ->> 'status', 'active', 'the victim is signed in and active');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb, 'and can use the app');
select is(array[pg_temp.session_count('victim'), pg_temp.refresh_token_count('victim')], array[2, 1],
  'the victim has two sessions and a refresh token');

select tests.login_as('ad-admin@example.test');
select is(
  public.admin_set_user_status(pg_temp.id('victim'), 'suspended'),
  '{"ok":true,"revokedSessions":2}'::jsonb,
  'admin_set_user_status: suspending returns the number of sessions it revoked');
select is((select status from pg_temp.profile('victim')), 'suspended', 'suspend: the account is suspended');
select is(array[pg_temp.session_count('victim'), pg_temp.refresh_token_count('victim')], array[0, 0],
  'suspend: every session and refresh token of the account is gone');
select results_eq(
  $$ select * from pg_temp.audit('victim') $$,
  $$ values ('admin', 'admin.user_suspended', null::jsonb, '{"revokedSessions":2}'::jsonb) $$,
  'suspend: audited as admin.user_suspended with the number of revoked sessions');

-- The victim's very next request, with the token they already hold.
select tests.resume_as('ad-victim@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'suspend: the victim''s live session is dead at once (admin.test.ts 2)');
select tests.throws_code($$ select public.list_my_projects() $$, 'unauthenticated', 401,
  'suspend: and so is their access to data');
select is(public.my_account() ->> 'status', 'suspended',
  'suspend: the dead token can still read why, from its own account record');
select throws_ok($$ select status from public.profiles $$, '42501', null,
  'suspend: and it cannot read the profiles table, like any other client');

-- If Auth let them sign in again (the ban is the Edge Function's second step).
select tests.login_as('ad-victim@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'account_suspended', 403,
  'suspend: a new sign-in is told the account is suspended (admin.test.ts 2)');
select tests.throws_code($$ select public.list_my_projects() $$, 'account_suspended', 403,
  'suspend: and reads nothing');

-- Suspending again finishes the job: the session that appeared is removed.
select tests.login_as('ad-admin@example.test');
select is(
  public.admin_set_user_status(pg_temp.id('victim'), 'suspended'),
  '{"ok":true,"revokedSessions":1}'::jsonb,
  'suspend, repeated: removes a session that appeared in between');
select is(
  public.admin_set_user_status(pg_temp.id('victim'), 'suspended'),
  '{"ok":true,"revokedSessions":0}'::jsonb,
  'suspend, repeated with nothing left to do: still ok');
select results_eq(
  $$ select action, after_data from pg_temp.audit('victim') $$,
  $$ values ('admin.user_suspended', '{"revokedSessions":2}'::jsonb),
            ('admin.user_suspended', '{"revokedSessions":1}'::jsonb) $$,
  'suspend, repeated: audited only when it revoked something');

-- A session that appeared while the account was suspended is of no use to
-- anybody until the account is activated, and activating does not remove it.
select tests.login_as('ad-victim@example.test');
select tests.login_as('ad-admin@example.test');
select is(
  public.admin_set_user_status(pg_temp.id('victim'), 'active'),
  '{"ok":true,"revokedSessions":0}'::jsonb,
  'admin_set_user_status: activating');
select is(pg_temp.session_count('victim'), 1, 'activate: revokes nothing');
select is(public.admin_set_user_status(pg_temp.id('victim'), 'active') ->> 'ok', 'true',
  'activate, repeated: still ok');
select results_eq(
  $$ select action, before_data, after_data from pg_temp.audit('victim') offset 2 $$,
  $$ values ('admin.user_activated', null::jsonb, null::jsonb) $$,
  'activate: audited once as admin.user_activated');
select tests.login_as('ad-victim@example.test');
select is(public.my_profile() -> 'user' ->> 'status', 'active',
  'activate: the person can sign in and use the app again');

select tests.login_as('ad-admin@example.test');
select tests.throws_code(format('select public.admin_set_user_status(pg_temp.id(''victim''), %L)', t.status),
         'invalid_input', 400, 'admin_set_user_status: status ' || t.status || ' is invalid_input')
  from unnest(array['deleted', 'banned', 'Active', '']) with ordinality as t (status, n)
 order by t.n;
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('victim'), null) $$, 'invalid_input', 400,
  'admin_set_user_status: no status is invalid_input');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('victim'), 'suspended', 'root') $$, 'invalid_input', 400,
  'admin_set_user_status: an unknown surface is invalid_input');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('gone'), 'active') $$, 'not_found', 404,
  'admin_set_user_status: a deleted account cannot be brought back');
select tests.throws_code(
  $$ select public.admin_set_user_status(gen_random_uuid(), 'suspended') $$, 'not_found', 404,
  'admin_set_user_status: an unknown id is not_found');
select is((select status from pg_temp.profile('victim')), 'active',
  'admin_set_user_status: the refused calls changed nothing');

-- ===========================================================================
-- admin_revoke_sessions
-- ===========================================================================

select tests.login_as('ad-revoke@example.test');
select tests.login_as('ad-admin@example.test');
select is(public.admin_revoke_sessions(pg_temp.id('revoke')), '{"ok":true,"revoked":1}'::jsonb,
  'admin_revoke_sessions: returns the number of sessions removed');
select tests.resume_as('ad-revoke@example.test');
select tests.throws_code($$ select public.list_my_projects() $$, 'unauthenticated', 401,
  'revoke: the old token is refused at once');
select tests.login_as('ad-revoke@example.test');
select is(public.my_profile() -> 'user' ->> 'status', 'active',
  'revoke: the account is not suspended, the person can sign in again');

select tests.login_as('ad-admin@example.test');
select is(public.admin_revoke_sessions(pg_temp.id('revoke')) -> 'revoked', '1'::jsonb,
  'admin_revoke_sessions: and again');
select is(public.admin_revoke_sessions(pg_temp.id('revoke')) -> 'revoked', '0'::jsonb,
  'admin_revoke_sessions: with no session left, zero');
select results_eq(
  $$ select * from pg_temp.audit('revoke') $$,
  $$ values ('admin', 'admin.sessions_revoked', null::jsonb, '{"revoked":1}'::jsonb),
            ('admin', 'admin.sessions_revoked', null::jsonb, '{"revoked":1}'::jsonb),
            ('admin', 'admin.sessions_revoked', null::jsonb, '{"revoked":0}'::jsonb) $$,
  'admin_revoke_sessions: every call is audited as admin.sessions_revoked with the count');
select tests.throws_code(
  $$ select public.admin_revoke_sessions(pg_temp.id('gone')) $$, 'not_found', 404,
  'admin_revoke_sessions: a deleted account is not_found');
select tests.throws_code(
  $$ select public.admin_revoke_sessions(gen_random_uuid()) $$, 'not_found', 404,
  'admin_revoke_sessions: an unknown id is not_found');

-- ===========================================================================
-- Soft delete (admin.test.ts "soft-deletes (retains audit)")
-- ===========================================================================

select tests.login_as('ad-doomed@example.test');
-- The account is in use, so the pending email change is a master admin's.
select tests.login_as('ad-master@example.test');
select is(public.admin_begin_email_change(pg_temp.id('doomed'), 'ad-doomed-new@example.test') ->> 'changed', 'true',
  'an email change is pending for the account about to be deleted');
select tests.login_as('ad-admin@example.test');

select is(public.admin_soft_delete_user(pg_temp.id('doomed')), '{"ok":true}'::jsonb,
  'admin_soft_delete_user: returns {ok: true}');
select results_eq(
  $$ select email, role, status from pg_temp.profile('doomed') $$,
  $$ values (null::text, 'supervisor', 'deleted') $$,
  'soft delete: the profile is kept, marked deleted, without its email');
select is(pg_temp.session_count('doomed'), 0, 'soft delete: the account''s sessions are gone');
select is_empty($$ select 1 from pg_temp.intents('ad-doomed-new@example.test') $$,
  'soft delete: a pending email change for the account is dropped');
select results_eq(
  $$ select * from pg_temp.audit('doomed') $$,
  $$ values ('admin', 'admin.user_deleted', '{"email":"ad-doomed@example.test","role":"supervisor"}'::jsonb, null::jsonb) $$,
  'soft delete: audited as admin.user_deleted with the email and role the account had');

select is(pg_temp.keys_of(public.admin_list_users('ad-doomed') -> 'users'), '',
  'soft delete: the account is no longer listed (admin.test.ts 3)');
select is(pg_temp.keys_of(public.admin_list_users(null, 'deleted') -> 'users', 'doomed'), 'doomed',
  'soft delete: it appears among the deleted accounts');
select tests.throws_code($$ select public.admin_get_user(pg_temp.id('doomed')) $$, 'not_found', 404,
  'soft delete: admin_get_user no longer finds it');
select ok(
  (select array_agg(e ->> 'action') @> array['admin.user_created', 'admin.user_deleted']
     from jsonb_array_elements(public.admin_list_audit(1000) -> 'entries') e),
  'the audit log holds the invitation and the deletion (admin.test.ts 3)');

select tests.resume_as('ad-doomed@example.test');
select tests.throws_code($$ select public.my_profile() $$, 'unauthenticated', 401,
  'soft delete: the deleted person''s token is refused at once');

-- Deleting again is how a half-finished delete is completed. It changes nothing here.
select tests.login_as('ad-admin@example.test');
select is(public.admin_soft_delete_user(pg_temp.id('doomed')), '{"ok":true}'::jsonb,
  'soft delete, repeated: still {ok: true}');
select is(pg_temp.audit_count('doomed'), 1, 'soft delete, repeated: no second audit row');
-- Then Auth soft-deletes its own row, which finds nothing left to do.
select tests.logout();
select lives_ok(
  $$ update auth.users set deleted_at = now(), email = 'obfuscated-doomed', encrypted_password = null
      where id = pg_temp.id('doomed') $$,
  'soft delete: Auth''s own delete afterwards is harmless');
select is(pg_temp.audit_count('doomed'), 1, 'soft delete: and adds nothing to the audit log');

select tests.resume_as('ad-admin@example.test');
select tests.throws_code(
  $$ select public.admin_soft_delete_user(gen_random_uuid()) $$, 'not_found', 404,
  'admin_soft_delete_user: an unknown id is not_found');
select tests.throws_code(
  $$ select public.admin_soft_delete_user(pg_temp.id('res'), 'root') $$, 'invalid_input', 400,
  'admin_soft_delete_user: an unknown surface is invalid_input');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('doomed'), '{"name":"Back"}') $$, 'not_found', 404,
  'a deleted account cannot be edited');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('doomed'), 'active') $$, 'not_found', 404,
  'a deleted account cannot be activated: the delete is not reversible');

-- ===========================================================================
-- The master surface: same functions, master.* audit actions
-- ===========================================================================

select tests.login_as('ad-master@example.test');
select is(public.admin_set_user_status(pg_temp.id('mdoomed'), 'suspended', 'master') ->> 'ok', 'true',
  'master surface: suspend an admin');
select is(public.admin_set_user_status(pg_temp.id('mdoomed'), 'active', 'master') ->> 'ok', 'true',
  'master surface: activate an admin');
select is(public.admin_soft_delete_user(pg_temp.id('mdoomed'), 'master'), '{"ok":true}'::jsonb,
  'master surface: delete an admin');
select results_eq(
  $$ select * from pg_temp.audit('mdoomed') $$,
  $$ values ('master', 'master.admin_suspended', null::jsonb, '{"revokedSessions":0}'::jsonb),
            ('master', 'master.admin_activated', null::jsonb, null::jsonb),
            ('master', 'master.admin_deleted', '{"email":"ad-mdoomed@example.test","role":"admin"}'::jsonb, null::jsonb) $$,
  'master surface: audited as master.admin_suspended, master.admin_activated and master.admin_deleted');

-- ===========================================================================
-- master_list_admins and master_set_role
-- ===========================================================================

select tests.logout();
update public.profiles p
   set created_at = '2026-02-01 00:00:00+00'::timestamptz + make_interval(mins => t.n)
  from (values ('admin', 1), ('admin2', 2), ('master', 3), ('master2', 4), ('L4', 5), ('newadmin', 6), ('viaadmin', 7)) t (k, n)
 where p.id = pg_temp.id(t.k);
select tests.resume_as('ad-master@example.test');

select is(pg_temp.obj_keys(public.master_list_admins()), 'admins', 'master_list_admins: returns {admins}');
select is(
  pg_temp.keys_of(public.master_list_admins() -> 'admins'),
  'viaadmin,newadmin,L4,admin2,admin,master2,master',
  'master_list_admins: admins first, then master admins, newest first in each; no researcher, no deleted admin');
select is(
  (select u from jsonb_array_elements(public.master_list_admins() -> 'admins') u
    where u ->> 'id' = pg_temp.id('admin')::text),
  public.admin_get_user(pg_temp.id('admin')) -> 'user',
  'master_list_admins: each entry is the User object');

select is(public.master_set_role(pg_temp.id('res'), 'admin') -> 'user' ->> 'role', 'admin',
  'master_set_role: promotes anybody, here a supervisor to admin');
select is(
  (select array[actor, action, before_data::text, after_data::text] from pg_temp.audit('res') offset 5),
  array['master', 'master.role_changed', '{"role": "supervisor"}', '{"role": "admin"}'],
  'master_set_role: audited as master.role_changed with the role before and after');
select is(public.master_set_role(pg_temp.id('res'), 'admin') -> 'user' ->> 'role', 'admin',
  'master_set_role: setting the role the account has is accepted');
select is(pg_temp.audit_count('res'), 6, 'master_set_role: and writes no audit row');
select is(public.master_set_role(pg_temp.id('res'), 'researcher') -> 'user' ->> 'role', 'researcher',
  'master_set_role: demotes an admin');
select is(public.master_set_role(pg_temp.id('master2'), 'admin') -> 'user' ->> 'role', 'admin',
  'master_set_role: demotes another master admin while one more remains');
select is(public.master_set_role(pg_temp.id('master2'), 'master_admin') -> 'user' ->> 'role', 'master_admin',
  'master_set_role: and promotes them back');

select tests.throws_code(format('select public.master_set_role(pg_temp.id(''res''), %L)', t.role),
         'invalid_role', 400, 'master_set_role: invalid_role for "' || t.role || '"')
  from unnest(array['owner', '', 'Master_Admin']) with ordinality as t (role, n)
 order by t.n;
select tests.throws_code($$ select public.master_set_role(pg_temp.id('res'), null) $$, 'invalid_role', 400,
  'master_set_role: no role is invalid_role');
select tests.throws_code($$ select public.master_set_role(gen_random_uuid(), 'admin') $$, 'not_found', 404,
  'master_set_role: an unknown id is not_found');
select tests.throws_code($$ select public.master_set_role(pg_temp.id('gone'), 'admin') $$, 'not_found', 404,
  'master_set_role: a deleted account is not_found');

-- ===========================================================================
-- admin_list_audit
-- ===========================================================================

select tests.logout();
select count(*) as filler from (select private.write_audit(null, 'tap.fill') from generate_series(1, 1005)) made;
select private.write_audit(pg_temp.id('admin'), 'tap.first', 'user', 'target-1', '{"a":1}', '{"a":2}');
select private.write_audit(null, 'tap.second');
select private.write_audit(pg_temp.id('master'), 'tap.third');
select tests.resume_as('ad-admin@example.test');

select is(
  (select array_agg(e ->> 'action' order by n)
     from jsonb_array_elements(public.admin_list_audit(3) -> 'entries') with ordinality as t (e, n)),
  array['tap.third', 'tap.second', 'tap.first'],
  'admin_list_audit: newest first, in the order things happened');
select is(
  (public.admin_list_audit(3) -> 'entries' -> 2) - 'id' - 'createdAt',
  jsonb_build_object(
    'actorId', pg_temp.id('admin'), 'actorEmail', 'ad-admin@example.test', 'action', 'tap.first',
    'targetType', 'user', 'targetId', 'target-1', 'before', '{"a":1}'::jsonb, 'after', '{"a":2}'::jsonb),
  'admin_list_audit: an entry carries actor, action, target, before and after');
select is(
  pg_temp.obj_keys(public.admin_list_audit(1) -> 'entries' -> 0),
  'action,actorEmail,actorId,after,before,createdAt,id,targetId,targetType',
  'admin_list_audit: exactly the nine legacy keys');
select is(jsonb_typeof(public.admin_list_audit(1) -> 'entries' -> 0 -> 'createdAt'), 'number',
  'admin_list_audit: createdAt is epoch milliseconds');
select is(
  public.admin_list_audit(2) -> 'entries' -> 1,
  jsonb_build_object('id', (public.admin_list_audit(2) -> 'entries' -> 1 ->> 'id')::uuid,
    'actorId', null, 'actorEmail', null, 'action', 'tap.second', 'targetType', null, 'targetId', null,
    'before', null, 'after', null,
    'createdAt', (public.admin_list_audit(2) -> 'entries' -> 1 -> 'createdAt')),
  'admin_list_audit: an entry with no actor (the instance owner) has nulls, not missing keys');

select results_eq(
  $$ select t.lim, jsonb_array_length(public.admin_list_audit(t.lim) -> 'entries')
       from unnest(array[1, 2, 200, 1000, 1001, 5000, 0, -5, null]::integer[]) with ordinality as t (lim, n)
      order by t.n $$,
  $$ values (1, 1), (2, 2), (200, 200), (1000, 1000), (1001, 1000), (5000, 1000), (0, 1), (-5, 1), (null, 200) $$,
  'admin_list_audit: the limit is kept between 1 and 1000, and no limit means 200');
select is(jsonb_array_length(public.admin_list_audit() -> 'entries'), 200,
  'admin_list_audit: 200 entries by default');

-- ===========================================================================
-- A caller who was demoted or suspended while their call waited
-- ===========================================================================
-- Every function that changes something locks the caller's own profile together
-- with the account it acts on, then looks at the caller again. One session
-- cannot wait on itself, so the helper is handed the caller "as they were when
-- the call began" while the database already says otherwise.
select tests.logout();

select is(
  (private.admin_target((select p from public.profiles p where p.id = pg_temp.id('admin')), pg_temp.id('L1'))).email,
  'ad-adlist-alice@example.test',
  'a caller who is still what they were gets the account they asked for');
-- Began the call as a master admin, is an admin by the time the lock is theirs.
select tests.throws_code(
  $$ select private.admin_target(
       (select jsonb_populate_record(p, '{"role":"master_admin"}') from public.profiles p where p.id = pg_temp.id('admin')),
       pg_temp.id('L4')) $$,
  'forbidden', 403,
  'a caller demoted while the call waited is refused, although the role they had could manage the target');
-- Began the call active, is suspended by the time the lock is theirs.
update public.profiles set status = 'suspended' where id = pg_temp.id('admin2');
select tests.throws_code(
  $$ select private.admin_target(
       (select jsonb_populate_record(p, '{"status":"active"}') from public.profiles p where p.id = pg_temp.id('admin2')),
       pg_temp.id('L1')) $$,
  'forbidden', 403,
  'a caller suspended while the call waited is refused');
select tests.throws_code(
  $$ select private.admin_confirm_actor(
       (select jsonb_populate_record(p, '{"status":"active"}') from public.profiles p where p.id = pg_temp.id('admin2'))) $$,
  'forbidden', 403,
  'and so are the functions that act on no account (inviting, settings)');
-- Began the call, and the profile is gone by the time the lock would be theirs.
select tests.throws_code(
  $$ select private.admin_target(
       (select jsonb_populate_record(p, jsonb_build_object('id', gen_random_uuid()))
          from public.profiles p where p.id = pg_temp.id('admin')),
       pg_temp.id('L1')) $$,
  'forbidden', 403,
  'a caller whose profile no longer exists is refused');
update public.profiles set status = 'active' where id = pg_temp.id('admin2');

-- No function that changes something skips the second look.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname ~ '^(admin|master)_'
        and p.prosecdef and p.provolatile = 'v'
        and p.prosrc !~ 'private\.admin_(target|confirm_actor)\(' $$,
  'every admin and master function that writes confirms the caller under the lock');

-- ===========================================================================
-- The last master admin (admin.test.ts "protects the last master from lockout")
-- ===========================================================================
-- ad-master becomes the only master admin who can sign in. Three more master
-- admins exist and none of them counts: one is suspended, one was invited and
-- never set a password, one never confirmed their address. Every other master
-- admin (ad-master2, and any in a developer's database) is made unusable for
-- the length of this transaction; must_set_password is not a column the guard
-- watches.
select tests.logout();
select pg_temp.mk('m_susp',   'ad-m-suspended@example.test',   'master_admin');
select pg_temp.mk('m_inv',    'ad-m-invited@example.test',     'master_admin', false);
select pg_temp.mk('m_unconf', 'ad-m-unconfirmed@example.test', 'master_admin');
update public.profiles set status = 'suspended' where id = pg_temp.id('m_susp');
update auth.users set email_confirmed_at = null where id = pg_temp.id('m_unconf');
update public.profiles
   set must_set_password = true
 where role = 'master_admin'
   and id not in (pg_temp.id('master'), pg_temp.id('m_susp'), pg_temp.id('m_inv'), pg_temp.id('m_unconf'));

select results_eq(
  $$ select i.k, p.status, p.must_set_password, p.email_confirmed_at is not null
       from public.profiles p join ids i on i.id = p.id
      where p.role = 'master_admin' and i.k in ('master', 'm_susp', 'm_inv', 'm_unconf')
      order by i.k $$,
  $$ values ('m_inv',    'active',    true,  false),
            ('m_susp',   'suspended', false, true),
            ('m_unconf', 'active',    false, false),
            ('master',   'active',    false, true) $$,
  'last master: one usable master admin, beside a suspended, an invited and an unconfirmed one');

select tests.login_as('ad-master@example.test');

-- The master surface, as the legacy server guarded it.
select tests.throws_code(
  $$ select public.master_set_role(pg_temp.id('master'), 'admin') $$, 'last_master_admin', 409,
  'last master: cannot demote themselves on the master surface (admin.test.ts 5)');
select tests.throws_code(
  $$ select public.admin_soft_delete_user(pg_temp.id('master'), 'master') $$, 'last_master_admin', 409,
  'last master: cannot delete themselves on the master surface (admin.test.ts 5)');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('master'), 'suspended', 'master') $$, 'last_master_admin', 409,
  'last master: cannot suspend themselves on the master surface');

-- The admin surface, where the legacy server had no guard at all.
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('master'), 'suspended') $$, 'last_master_admin', 409,
  'last master: cannot suspend themselves through the admin surface (legacy bypass, closed)');
select tests.throws_code(
  $$ select public.admin_soft_delete_user(pg_temp.id('master')) $$, 'last_master_admin', 409,
  'last master: cannot delete themselves through the admin surface (legacy bypass, closed)');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('master'), '{"role":"admin"}') $$, 'last_master_admin', 409,
  'last master: cannot demote themselves through the admin surface (legacy bypass, closed)');
select tests.throws_code(
  $$ select public.admin_update_user(pg_temp.id('master'), '{"name":"Still Me","role":"researcher"}') $$,
  'last_master_admin', 409,
  'last master: a patch that also renames them is refused as a whole');

select results_eq(
  $$ select name, role, status from pg_temp.profile('master') $$,
  $$ values ('', 'master_admin', 'active') $$,
  'last master: after every refused attempt they are untouched');
select cmp_ok(pg_temp.session_count('master'), '>=', 1,
  'last master: a refused suspension revoked none of their sessions');
select is(public.my_profile() -> 'user' ->> 'role', 'master_admin',
  'last master: and they are still signed in');
select is_empty(
  $$ select 1 from pg_temp.audit('master') where action not like 'tap.%' $$,
  'last master: the refused attempts wrote no audit row');

-- What the last master admin can still do.
select is(public.admin_update_user(pg_temp.id('master'), '{"name":"The Master"}') -> 'user' ->> 'name', 'The Master',
  'last master: can still rename themselves');
select is(public.master_set_role(pg_temp.id('m_susp'), 'admin') -> 'user' ->> 'role', 'admin',
  'last master: can demote a master admin who does not count');
select is(public.admin_set_user_status(pg_temp.id('m_unconf'), 'suspended', 'master') ->> 'ok', 'true',
  'last master: can suspend one, too');
select tests.throws_code(
  $$ select public.master_set_role(pg_temp.id('master'), 'admin') $$, 'last_master_admin', 409,
  'last master: and is still protected afterwards');

-- A second master admin who can sign in makes the first removable.
select tests.logout();
update public.profiles set must_set_password = false where id = pg_temp.id('master2');
select tests.resume_as('ad-master@example.test');

select is(public.admin_update_user(pg_temp.id('master'), '{"role":"admin"}') -> 'user' ->> 'role', 'admin',
  'with a second usable master admin, the first can step down through the admin surface');
select tests.throws_code($$ select public.master_list_admins() $$, 'forbidden', 403,
  'having stepped down, they are an admin: the master surface is closed to them at once');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('master2'), 'suspended') $$, 'forbidden', 403,
  'and they cannot touch the remaining master admin');

select tests.login_as('ad-master2@example.test');
select tests.throws_code(
  $$ select public.admin_set_user_status(pg_temp.id('master2'), 'suspended') $$, 'last_master_admin', 409,
  'the remaining master admin is now the last one, and is protected in turn');
select tests.throws_code(
  $$ select public.admin_soft_delete_user(pg_temp.id('master2'), 'master') $$, 'last_master_admin', 409,
  'on either surface');

select tests.logout();

select * from finish();
rollback;
