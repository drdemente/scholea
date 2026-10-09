-- Changing the email of an account that is in use is a master admin's action
-- (migration 20).
--
-- An admin email change takes effect at once and without a code. Whoever reads
-- the new mailbox can then use "Forgot password" to get into the account, and
-- the address the account had before is not told. So:
--
--   * an account that is IN USE (its address is confirmed and its password is
--     set) can only be moved by a master admin. An admin is refused with
--     forbidden (HTTP 403, detail master_admin_required), nothing is recorded
--     and nothing is audited;
--   * an account NOBODY CAN USE YET (invited and no password set, or signed up
--     and never confirmed) can still be corrected by an admin, inside the role
--     matrix: researchers and supervisors only;
--   * a master admin may change any account, as before;
--   * everybody else is refused as before, and what the function answers a
--     master admin, which is what the Edge Function "admin" relies on, is
--     unchanged.
--
-- Who gets into the admin functions at all is 060. What an address that an
-- administrator set is worth, and who is recorded as having changed it, is 026.
--
-- Auth is simulated by writing to auth.users the way it does, which fires the
-- real triggers. The pg_temp helpers marked SECURITY DEFINER let the test look
-- at (or act on) the database as its owner while a client stays signed in.

begin;
select plan(58);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create temp table ids (k text primary key, id uuid not null);
grant select on ids to authenticated, anon;

create function pg_temp.id(p_key text) returns uuid language sql stable as $$
  select i.id from ids i where i.k = p_key;
$$;

create function pg_temp.mk(p_key text, p_email text, p_role text default 'researcher', p_password_set boolean default true)
returns void language sql as $$
  insert into ids values (p_key, tests.create_user(p_email, p_role, p_password_set));
$$;

-- The call under test, aimed at a fixture. Left out, the new address is one
-- that nobody has.
create function pg_temp.change(p_key text, p_email text default null) returns text language sql stable as $$
  select format('select public.admin_begin_email_change(%L, %L)',
                pg_temp.id(p_key), coalesce(p_email, 'em-new-for-' || p_key || '@example.test'));
$$;

-- Run a statement as the current caller and say how it ended: 'ok', or the
-- backend's own refusal as "code status", followed by its detail when it gave
-- one. Any other error is named by its SQLSTATE. Whatever the statement did is
-- undone before returning.
create function pg_temp.probe(p_sql text) returns text
language plpgsql as $$
declare
  v_state   text;
  v_message text;
  v_detail  text;
begin
  begin
    execute p_sql;
    raise exception 'undo' using errcode = 'TAP01';
  exception
    when sqlstate 'TAP01' then
      return 'ok';
    when others then
      get stacked diagnostics
        v_state   = returned_sqlstate,
        v_message = message_text,
        v_detail  = pg_exception_detail;
      if v_state = 'PGRST' then
        return concat_ws(' ', v_message::jsonb ->> 'code', v_detail::jsonb ->> 'status', v_message::jsonb ->> 'details');
      end if;
      return v_state;
  end;
end
$$;

-- What the database holds about an account, read as the owner.
create function pg_temp.account(p_key text)
returns table (email text, role text, status text, must_set_password boolean, confirmed boolean, unproven boolean)
language sql stable security definer as $$
  select p.email, p.role, p.status, p.must_set_password, p.email_confirmed_at is not null, p.email_unproven
    from public.profiles p where p.id = (select i.id from ids i where i.k = p_key);
$$;

-- The email changes waiting for one of the fixtures: who asked, for whom, which address.
create function pg_temp.intents()
returns table (actor text, target text, email text)
language sql stable security definer as $$
  select (select i.k from ids i where i.id = n.actor_id),
         (select i.k from ids i where i.id = n.target_id),
         n.email
    from private.admin_intents n
   where n.kind = 'email_change' and n.target_id in (select i.id from ids i)
   order by 2, 1, 3;
$$;

-- Every audit row by or about one of the fixtures.
create function pg_temp.audit_rows() returns integer language sql stable security definer as $$
  select count(*)::integer from public.audit_log a
   where a.actor_id in (select i.id from ids i) or a.target_id in (select i.id::text from ids i);
$$;

-- The newest audit row about an account, with the actor as a fixture key.
create function pg_temp.last_audit(p_key text)
returns table (actor text, action text, before_data jsonb, after_data jsonb)
language sql stable security definer as $$
  select (select i.k from ids i where i.id = a.actor_id), a.action, a.before_data, a.after_data
    from public.audit_log a
   where a.target_type = 'user' and a.target_id = (select i.id::text from ids i where i.k = p_key)
   order by a.created_at desc, a.id desc
   limit 1;
$$;

-- What the Auth admin API does to change an address: it writes email alone.
create function pg_temp.auth_sets_email(p_key text, p_email text) returns void language sql security definer as $$
  update auth.users set email = p_email where id = (select i.id from ids i where i.k = p_key);
$$;

-- What Auth does when an invited person types the invitation code: a throwaway
-- password in one statement, the confirmation in the next. Nobody knows that
-- password, so the account still has none of its own.
create function pg_temp.auth_invite_code_typed(p_key text) returns void language plpgsql security definer as $$
begin
  update auth.users
     set confirmation_token = '',
         encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
   where id = (select i.id from ids i where i.k = p_key);
  update auth.users set email_confirmed_at = now() where id = (select i.id from ids i where i.k = p_key);
end $$;

-- ... and when they then choose a password.
create function pg_temp.auth_sets_password(p_key text) returns void language sql security definer as $$
  update auth.users
     set encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
   where id = (select i.id from ids i where i.k = p_key);
$$;

-- What Auth does when somebody who signed up types the confirmation code.
create function pg_temp.auth_confirms(p_key text) returns void language sql security definer as $$
  update auth.users set confirmation_token = '', email_confirmed_at = now()
   where id = (select i.id from ids i where i.k = p_key);
$$;

grant execute on all functions in schema pg_temp to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- The callers.
select pg_temp.mk('master',     'em-master@example.test',     'master_admin');
select pg_temp.mk('admin',      'em-admin@example.test',      'admin');
select pg_temp.mk('researcher', 'em-researcher@example.test');
select pg_temp.mk('supervisor', 'em-supervisor@example.test', 'supervisor');

-- Accounts in use: the address is confirmed and the password is set.
select pg_temp.mk('res',   'em-res@example.test');
select pg_temp.mk('sup',   'em-sup@example.test',   'supervisor');
select pg_temp.mk('adm',   'em-adm@example.test',   'admin');
select pg_temp.mk('mas',   'em-mas@example.test',   'master_admin');
select pg_temp.mk('susp',  'em-susp@example.test');
select pg_temp.mk('moved', 'em-moved-before@example.test');
-- Suspended: still somebody's account, with their data in it.
update public.profiles set status = 'suspended' where id = pg_temp.id('susp');
-- Its address was set from outside and its holder has not typed a code since.
select pg_temp.auth_sets_email('moved', 'em-moved@example.test');

-- Accounts nobody can use yet.
select pg_temp.mk('invited',     'em-invited@example.test',     'researcher', false);
select pg_temp.mk('invited_sup', 'em-invited-sup@example.test', 'supervisor', false);
select pg_temp.mk('typed',       'em-typed@example.test',       'researcher', false);
select pg_temp.mk('unconfirmed', 'em-unconfirmed@example.test');
select pg_temp.mk('invited_adm', 'em-invited-adm@example.test', 'admin', false);
-- Typed the invitation code and stopped before choosing a password.
select pg_temp.auth_invite_code_typed('typed');
-- Signed up with a password, code not entered yet.
update auth.users set email_confirmed_at = null where id = pg_temp.id('unconfirmed');

-- Two accounts that come into use during the test.
select pg_temp.mk('joining', 'em-joining@example.test', 'researcher', false);
select pg_temp.mk('signing', 'em-signing@example.test');
update auth.users set email_confirmed_at = null where id = pg_temp.id('signing');

-- Deleted all the way.
select pg_temp.mk('gone', 'em-gone@example.test');
update auth.users set deleted_at = now(), email = 'obfuscated-em-gone', encrypted_password = null
 where id = pg_temp.id('gone');

select results_eq(
  $$ select i.k, a.role, a.status, a.must_set_password, a.confirmed, a.unproven
       from ids i cross join lateral pg_temp.account(i.k) a
      where i.k in ('res', 'sup', 'adm', 'mas', 'susp', 'moved',
                    'invited', 'invited_sup', 'typed', 'unconfirmed', 'invited_adm')
      order by a.must_set_password or not a.confirmed, i.k $$,
  $$ values ('adm',         'admin',        'active',    false, true,  false),
            ('mas',         'master_admin', 'active',    false, true,  false),
            ('moved',       'researcher',   'active',    false, true,  true),
            ('res',         'researcher',   'active',    false, true,  false),
            ('sup',         'supervisor',   'active',    false, true,  false),
            ('susp',        'researcher',   'suspended', false, true,  false),
            ('invited',     'researcher',   'active',    true,  false, false),
            ('invited_adm', 'admin',        'active',    true,  false, false),
            ('invited_sup', 'supervisor',   'active',    true,  false, false),
            ('typed',       'researcher',   'active',    true,  true,  false),
            ('unconfirmed', 'researcher',   'active',    false, false, false) $$,
  '(scene) six accounts in use: confirmed and with a password. Five that nobody can use yet: no password, or never confirmed');

create temp table before_refusals as
select (select count(*)::integer from pg_temp.intents()) as intents, pg_temp.audit_rows() as audit_rows;
grant select on before_refusals to authenticated;

-- ===========================================================================
-- 1. An admin and an account in use: refused
-- ===========================================================================

select tests.login_as('em-admin@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select tests.throws_code(pg_temp.change('res'), 'forbidden', 403,
  'an admin may not change the email of a researcher whose account is in use: forbidden, HTTP 403');
select is(pg_temp.probe(pg_temp.change('res')), 'forbidden 403 master_admin_required',
  'the refusal carries the detail master_admin_required');
select tests.throws_code(pg_temp.change('sup'), 'forbidden', 403,
  'nor of a supervisor whose account is in use');

select results_eq(
  $$ select t.k, pg_temp.probe(pg_temp.change(t.k))
       from unnest(array['res', 'sup', 'susp', 'moved']) with ordinality as t (k, n)
      order by t.n $$,
  $$ values ('res',   'forbidden 403 master_admin_required'),
            ('sup',   'forbidden 403 master_admin_required'),
            ('susp',  'forbidden 403 master_admin_required'),
            ('moved', 'forbidden 403 master_admin_required') $$,
  'in use is in use: a researcher, a supervisor, a suspended account, and one whose address its holder has not proven');

-- The role matrix is asked first and answers without that detail, as before.
select results_eq(
  $$ select t.k, pg_temp.probe(pg_temp.change(t.k))
       from unnest(array['adm', 'mas', 'admin']) with ordinality as t (k, n)
      order by t.n $$,
  $$ values ('adm', 'forbidden 403'), ('mas', 'forbidden 403'), ('admin', 'forbidden 403') $$,
  'an admin, a master admin and the caller''s own account are refused by the role matrix, as before');

-- Whatever the new address is, the answer is the same. An admin learns nothing
-- about addresses from an account they may not move, and a request that would
-- change nothing is refused like any other.
select results_eq(
  $$ select t.what, pg_temp.probe(pg_temp.change('res', t.email))
       from (values (1, 'an address nobody has',               'em-free@example.test'),
                    (2, 'an address that belongs to somebody', 'em-sup@example.test'),
                    (3, 'the address of an invited account',   'em-invited@example.test'),
                    (4, 'the address the account already has', 'em-res@example.test'),
                    (5, 'the same in another letter case',     ' EM-RES@Example.test ')) t (n, what, email)
      order by t.n $$,
  $$ values ('an address nobody has',               'forbidden 403 master_admin_required'),
            ('an address that belongs to somebody', 'forbidden 403 master_admin_required'),
            ('the address of an invited account',   'forbidden 403 master_admin_required'),
            ('the address the account already has', 'forbidden 403 master_admin_required'),
            ('the same in another letter case',     'forbidden 403 master_admin_required') $$,
  'the refusal comes before the address is looked up: never email_taken, and "no change" is refused too');

-- What is checked before the account is looked at stays as it was.
select tests.throws_code(pg_temp.change('res', 'nonsense'), 'invalid_input', 400,
  'not an address is invalid_input, as before');
select tests.throws_code(
  $$ select public.admin_begin_email_change(gen_random_uuid(), 'em-any@example.test') $$, 'not_found', 404,
  'an unknown id is not_found, as before');
select tests.throws_code(pg_temp.change('gone'), 'not_found', 404,
  'a deleted account is not_found, as before');

-- Nothing was written by any of it.
select is((select count(*)::integer from pg_temp.intents()), (select intents from before_refusals),
  'refused: no intent row was written');
select is((select intents from before_refusals), 0, '(control) and there was none to begin with');
select is(pg_temp.audit_rows(), (select audit_rows from before_refusals),
  'refused: nothing was audited');
select results_eq(
  $$ select i.k, a.email from ids i cross join lateral pg_temp.account(i.k) a
      where i.k in ('res', 'sup', 'susp', 'moved') order by i.k $$,
  $$ values ('moved', 'em-moved@example.test'), ('res', 'em-res@example.test'),
            ('sup', 'em-sup@example.test'), ('susp', 'em-susp@example.test') $$,
  'refused: every account still has the address it had');

-- ===========================================================================
-- 2. An admin and an account nobody can use yet: allowed
-- ===========================================================================

select is(
  public.admin_begin_email_change(pg_temp.id('invited'), ' EM-Invited-Fixed@Example.test '),
  '{"ok":true,"changed":true,"email":"em-invited-fixed@example.test","emailConfirmed":false}'::jsonb,
  'an admin may correct the address of an invited account that has no password yet');
select is(
  public.admin_begin_email_change(pg_temp.id('invited_sup'), 'em-invited-sup-fixed@example.test') ->> 'changed', 'true',
  'whether it was invited as a researcher or as a supervisor');
select is(
  public.admin_begin_email_change(pg_temp.id('typed'), 'em-typed-fixed@example.test'),
  '{"ok":true,"changed":true,"email":"em-typed-fixed@example.test","emailConfirmed":true}'::jsonb,
  'and of an invited person who typed the code but has not chosen a password: confirmed, and still nobody''s to use');
select is(
  public.admin_begin_email_change(pg_temp.id('unconfirmed'), 'em-unconfirmed-fixed@example.test'),
  '{"ok":true,"changed":true,"email":"em-unconfirmed-fixed@example.test","emailConfirmed":false}'::jsonb,
  'an admin may correct the address of a sign-up that was never confirmed');
select results_eq(
  $$ select * from pg_temp.intents() $$,
  $$ values ('admin', 'invited',     'em-invited-fixed@example.test'),
            ('admin', 'invited_sup', 'em-invited-sup-fixed@example.test'),
            ('admin', 'typed',       'em-typed-fixed@example.test'),
            ('admin', 'unconfirmed', 'em-unconfirmed-fixed@example.test') $$,
  'each of those requests is recorded, in the admin''s name');

-- The role matrix still comes first: not in use does not mean anybody's to manage.
select is(pg_temp.probe(pg_temp.change('invited_adm')), 'forbidden 403',
  'an invited admin is not an admin''s to manage, password or no password');

-- The rest of the function is as it was for these accounts.
select tests.throws_code(pg_temp.change('invited', 'em-res@example.test'), 'email_taken', 409,
  'for an account an admin may move, an address that belongs to somebody is email_taken, as before');
select is(
  public.admin_begin_email_change(pg_temp.id('unconfirmed'), 'EM-Unconfirmed@example.test') -> 'changed', 'false'::jsonb,
  'and the address it already has is "changed: false", as before');

-- Auth makes the two changes. Each is recorded as the admin's.
select pg_temp.auth_sets_email('invited', 'em-invited-fixed@example.test');
select results_eq(
  $$ select email, must_set_password, confirmed, unproven from pg_temp.account('invited') $$,
  $$ values ('em-invited-fixed@example.test', true, false, true) $$,
  'invited account: the profile follows Auth, and the account is still waiting for its code');
select results_eq(
  $$ select * from pg_temp.last_audit('invited') $$,
  $$ values ('admin', 'admin.user_updated',
             '{"email":"em-invited@example.test"}'::jsonb, '{"email":"em-invited-fixed@example.test"}'::jsonb) $$,
  'invited account: audited as admin.user_updated by the admin, with the address before and after');
select pg_temp.auth_sets_email('unconfirmed', 'em-unconfirmed-fixed@example.test');
select results_eq(
  $$ select a.email, a.confirmed, l.actor, l.action
       from pg_temp.account('unconfirmed') a, pg_temp.last_audit('unconfirmed') l $$,
  $$ values ('em-unconfirmed-fixed@example.test', false, 'admin', 'admin.user_updated') $$,
  'unconfirmed sign-up: the same, and it stays unconfirmed');

-- ===========================================================================
-- 3. The moment an account comes into use, it is out of an admin's reach
-- ===========================================================================

-- An invitation, step by step.
select is(pg_temp.probe(pg_temp.change('joining')), 'ok',
  'invited, code not typed: an admin may move it');
select pg_temp.auth_invite_code_typed('joining');
select results_eq(
  $$ select must_set_password, confirmed from pg_temp.account('joining') $$, $$ values (true, true) $$,
  '(scene) the invited person types the code: confirmed, no password of their own yet');
select is(pg_temp.probe(pg_temp.change('joining')), 'ok',
  'code typed, no password yet: an admin may still move it');
select pg_temp.auth_sets_password('joining');
select results_eq(
  $$ select must_set_password, confirmed from pg_temp.account('joining') $$, $$ values (false, true) $$,
  '(scene) they choose a password: the account is in use');
select is(pg_temp.probe(pg_temp.change('joining')), 'forbidden 403 master_admin_required',
  'password chosen: an admin may no longer move it');

-- A sign-up.
select is(pg_temp.probe(pg_temp.change('signing')), 'ok',
  'signed up, never confirmed: an admin may move it');
select pg_temp.auth_confirms('signing');
select is(pg_temp.probe(pg_temp.change('signing')), 'forbidden 403 master_admin_required',
  'confirmed: an admin may no longer move it');

-- ===========================================================================
-- 4. A master admin: any account
-- ===========================================================================

select tests.login_as('em-master@example.test');

select is(public.admin_begin_email_change(pg_temp.id('sup'), 'em-sup-moved@example.test') ->> 'changed', 'true',
  'a master admin may change the email of a supervisor whose account is in use');
select is(public.admin_begin_email_change(pg_temp.id('adm'), 'em-adm-moved@example.test') ->> 'changed', 'true',
  'of an admin');
select is(public.admin_begin_email_change(pg_temp.id('mas'), 'em-mas-moved@example.test') ->> 'changed', 'true',
  'and of another master admin');

select results_eq(
  $$ select t.k, pg_temp.probe(pg_temp.change(t.k))
       from unnest(array['res', 'sup', 'adm', 'mas', 'susp', 'moved', 'joining', 'signing',
                         'invited', 'invited_sup', 'typed', 'unconfirmed', 'invited_adm']) with ordinality as t (k, n)
      order by t.n $$,
  $$ values ('res', 'ok'), ('sup', 'ok'), ('adm', 'ok'), ('mas', 'ok'), ('susp', 'ok'), ('moved', 'ok'),
            ('joining', 'ok'), ('signing', 'ok'),
            ('invited', 'ok'), ('invited_sup', 'ok'), ('typed', 'ok'), ('unconfirmed', 'ok'), ('invited_adm', 'ok') $$,
  'a master admin may change any account: in use or not, whatever its role, as before');

-- ===========================================================================
-- 5. Everybody else: refused, as before
-- ===========================================================================

select tests.login_as('em-researcher@example.test');
select tests.throws_code(pg_temp.change('res'), 'forbidden', 403,
  'a researcher is refused for an account in use: forbidden, HTTP 403');
select tests.throws_code(pg_temp.change('invited'), 'forbidden', 403,
  'and for an account nobody can use yet');
select results_eq(
  $$ select distinct pg_temp.probe(pg_temp.change(t.k))
       from unnest(array['res', 'sup', 'adm', 'mas', 'invited', 'unconfirmed', 'gone', 'researcher']) as t (k) $$,
  $$ values ('forbidden 403') $$,
  'a researcher gets one answer for every account, with no detail: nothing tells an account in use from one that is not');
select is(pg_temp.probe($$ select public.admin_begin_email_change(null, null) $$), 'forbidden 403',
  'the role is checked before any argument is looked at');

select tests.login_as('em-supervisor@example.test');
select results_eq(
  $$ select distinct pg_temp.probe(pg_temp.change(t.k))
       from unnest(array['res', 'sup', 'adm', 'mas', 'invited', 'unconfirmed', 'gone', 'supervisor']) as t (k) $$,
  $$ values ('forbidden 403') $$,
  'the instance role "supervisor" is no administrator: the same single answer');

select tests.as_anon();
select throws_ok(pg_temp.change('res'), '42501', null, 'a visitor without an account cannot call the function at all');
select throws_ok(pg_temp.change('invited'), '42501', null, 'not for an invited account either');
select tests.logout();

-- Redefining the function gave nobody new access to it.
select results_eq(
  $$ select t.role, has_function_privilege(t.role, 'public.admin_begin_email_change(uuid, text)', 'EXECUTE')
       from unnest(array['anon', 'authenticated', 'service_role']) with ordinality as t (role, n)
      order by t.n $$,
  $$ values ('anon', false), ('authenticated', true), ('service_role', false) $$,
  'only signed-in users may call it; the function itself then decides (and the secret key''s role cannot)');

-- ===========================================================================
-- 6. What the Edge Function relies on is unchanged for a master admin
-- ===========================================================================
-- The function "admin" calls admin_begin_email_change(p_user_id, p_new_email)
-- with the caller's token, reads changed and email from the answer, asks Auth
-- to set that address when changed is true, and answers with admin_get_user.

select is(
  (select array[p.prosecdef::text, pg_get_function_result(p.oid), array_to_string(p.proargnames, ','),
                array_to_string(p.proconfig, ',')]
     from pg_proc p where p.oid = 'public.admin_begin_email_change(uuid, text)'::regprocedure),
  array['true', 'jsonb', 'p_user_id,p_new_email', 'search_path=""'],
  'same name, same two arguments, same result type, still a definer function with an empty search path');

select tests.login_as('em-master@example.test');
select is(
  public.admin_begin_email_change(p_user_id => pg_temp.id('res'), p_new_email => ' EM-Res-Moved@Example.test '),
  '{"ok":true,"changed":true,"email":"em-res-moved@example.test","emailConfirmed":true}'::jsonb,
  'step 1: {ok, changed, email, emailConfirmed}, with the address as recorded (trimmed, lower case)');
select results_eq(
  $$ select actor, email from pg_temp.intents() where target = 'res' $$,
  $$ values ('master', 'em-res-moved@example.test') $$,
  'step 1: the intent is recorded in the master admin''s name');
select is((select email from pg_temp.account('res')), 'em-res@example.test',
  'step 1: changes nothing by itself');

select pg_temp.auth_sets_email('res', 'em-res-moved@example.test');
select results_eq(
  $$ select * from pg_temp.last_audit('res') $$,
  $$ values ('master', 'admin.user_updated',
             '{"email":"em-res@example.test"}'::jsonb, '{"email":"em-res-moved@example.test"}'::jsonb) $$,
  'step 2, Auth sets the address: audited as admin.user_updated by the master admin, with the address before and after');
select is_empty($$ select 1 from pg_temp.intents() where target = 'res' $$,
  'step 2: the intent is used up');
select is(
  (public.admin_get_user(pg_temp.id('res')) -> 'user') - 'id' - 'createdAt' - 'lastLoginAt',
  '{"email":"em-res-moved@example.test","name":"","institution":"","role":"researcher","status":"active",
    "mustResetPassword":false,"emailConfirmed":false}'::jsonb,
  'step 3: the account the function answers with has the new address, not yet confirmed by its holder');

select is(
  public.admin_begin_email_change(pg_temp.id('res'), 'EM-RES-MOVED@example.test'),
  '{"ok":true,"changed":false,"email":"em-res-moved@example.test","emailConfirmed":true}'::jsonb,
  'the address the account already has is "changed: false", so Auth is not asked');
select is_empty($$ select 1 from pg_temp.intents() where target = 'res' $$,
  'and no intent is recorded for it');

select results_eq(
  $$ select t.what, pg_temp.probe(t.sql)
       from (values
         (1, 'an address that belongs to somebody', pg_temp.change('res', 'EM-Sup@example.test')),
         (2, 'the address of an invited account',   pg_temp.change('res', 'em-invited-sup@example.test')),
         (3, 'not an address',                      pg_temp.change('res', 'nonsense')),
         (4, 'no address',                          format('select public.admin_begin_email_change(%L, null)', pg_temp.id('res'))),
         (5, 'an unknown id',                       $q$ select public.admin_begin_email_change(gen_random_uuid(), 'em-any@example.test') $q$),
         (6, 'no id',                               $q$ select public.admin_begin_email_change(null, 'em-any@example.test') $q$),
         (7, 'a deleted account',                   pg_temp.change('gone'))) t (n, what, sql)
      order by t.n $$,
  $$ values ('an address that belongs to somebody', 'email_taken 409'),
            ('the address of an invited account',   'email_taken 409'),
            ('not an address',                      'invalid_input 400'),
            ('no address',                          'invalid_input 400'),
            ('an unknown id',                       'not_found 404'),
            ('no id',                               'not_found 404'),
            ('a deleted account',                   'not_found 404') $$,
  'the refusals a master admin can meet are the ones the function always had, with the same codes and statuses');

-- ===========================================================================
-- 7. An admin who becomes a master admin, and one who stops being one
-- ===========================================================================
-- The role is read from the database on every call.

select tests.login_as('em-admin@example.test');
select is(pg_temp.probe(pg_temp.change('susp')), 'forbidden 403 master_admin_required',
  '(control) the admin is refused for an account in use');
select tests.logout();
update public.profiles set role = 'master_admin' where id = pg_temp.id('admin');
select tests.resume_as('em-admin@example.test');
select is(pg_temp.probe(pg_temp.change('susp')), 'ok',
  'promoted to master admin: the same token may now move it');
select tests.logout();
update public.profiles set role = 'admin' where id = pg_temp.id('admin');
select tests.resume_as('em-admin@example.test');
select is(pg_temp.probe(pg_temp.change('susp')), 'forbidden 403 master_admin_required',
  'demoted again: refused again, at once');
select tests.logout();

select * from finish();
rollback;
