-- Privileges: who may touch what, checked in the catalog and then again as a client.
--
-- The model: no API role can read or write any table. Everything a client reads
-- or changes goes through a security definer RPC that checks the caller first.
-- Row level security stays on every table as a second lock. Nothing is callable
-- unless a migration grants it by name.
--
-- The lists in this file are meant to be edited when the surface changes on
-- purpose. Each is fenced by a "LIST" comment. Adding to one is a security
-- decision, so say why in the change that does it.

begin;
select plan(121);

-- ===========================================================================
-- Tables
-- ===========================================================================

-- LIST: every table in public. A new table must get row level security and a
-- decision about who may read it, then be added here.
select set_eq(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') $$,
  $$ select unnest(array[
       'profiles',
       'audit_log',
       'instance_settings',
       'projects',
       'project_members',
       'project_invitations',
       'project_comments',
       'project_reviews',
       'step_ownership',
       'project_activity'
     ]) $$,
  'public holds exactly the known tables');

select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'row level security is enabled on every public table');

select is_empty(
  $$ select format('%s: %s on %s', r.rolname, p.priv, c.relname)
       from pg_class c
      cross join (values ('anon'), ('authenticated')) r (rolname)
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                         ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p (priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and has_table_privilege(r.rolname, c.oid, p.priv) $$,
  'anon and authenticated hold no write privilege on any public table');

select is_empty(
  $$ select format('%s: %s on a column of %s', r.rolname, p.priv, c.relname)
       from pg_class c
      cross join (values ('anon'), ('authenticated'), ('service_role')) r (rolname)
      cross join (values ('INSERT'), ('UPDATE'), ('REFERENCES')) p (priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and has_any_column_privilege(r.rolname, c.oid, p.priv) $$,
  'no API role holds a column-level write privilege on any public table');

select is_empty(
  $$ select format('%s: %s on %s', r.rolname, p.priv, c.relname)
       from pg_class c
      cross join (values ('anon'), ('service_role')) r (rolname)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                         ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p (priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and (has_table_privilege(r.rolname, c.oid, p.priv)
             or (p.priv = 'SELECT' and has_any_column_privilege(r.rolname, c.oid, 'SELECT'))) $$,
  'anon and service_role have no access to any public table');

-- authenticated may SELECT nothing either, not a table and not a column of
-- one. A table a client can select is a table the Data API will plan a query
-- for, and the planner's row estimate ("Prefer: count=planned") is made from
-- the whole table before any policy applies: it gives away how many rows there
-- are and what is in them. Clients read through the RPCs listed further down.
select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and (has_table_privilege('authenticated', c.oid, 'SELECT')
             or has_any_column_privilege('authenticated', c.oid, 'SELECT')) $$,
  'authenticated may SELECT no table in public: clients read through functions only');

-- A view, a materialized view or a foreign table would be one more thing the
-- Data API can plan a query for. There is none, and adding one needs the same
-- thought as granting a table.
select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'f') $$,
  'public holds no view, materialized view or foreign table');

select is_empty(
  $$ select format('%s on %s', r.rolname, c.relname)
       from pg_class c
      cross join (values ('anon'), ('authenticated'), ('service_role')) r (rolname)
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
        and (has_sequence_privilege(r.rolname, c.oid, 'USAGE')
             or has_sequence_privilege(r.rolname, c.oid, 'SELECT')
             or has_sequence_privilege(r.rolname, c.oid, 'UPDATE')) $$,
  'no API role can use a sequence in public');

-- ===========================================================================
-- Policies
-- ===========================================================================

select is_empty(
  $$ select format('%s on %s', pol.polname, c.relname)
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid
      where c.relnamespace = 'public'::regnamespace
        and (pol.polcmd <> 'r'
             or pol.polroles <> array[(select r.oid from pg_roles r where r.rolname = 'authenticated')]) $$,
  'every policy in public is SELECT-only and applies to authenticated only');

select policies_are('public', 'profiles',
  array['profiles_select_self', 'profiles_select_admin']);
select policies_are('public', 'audit_log',           array['audit_select_admin']);
select policies_are('public', 'instance_settings',   array['settings_select_admin']);
select policies_are('public', 'projects',            array['projects_select_member']);
select policies_are('public', 'project_members',     array['members_select_member']);
select policies_are('public', 'project_comments',    array['comments_select_member']);
select policies_are('public', 'project_reviews',     array['reviews_select_member']);
select policies_are('public', 'step_ownership',      array['ownership_select_member']);
select policies_are('public', 'project_activity',    array['activity_select_member']);
select policies_are('public', 'project_invitations',
  array['invitations_select_invitee', 'invitations_select_owner']);

-- ===========================================================================
-- The private schema
-- ===========================================================================

select ok(has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated can resolve names in private (policies call helpers there)');
select ok(not has_schema_privilege('anon', 'private', 'USAGE')
          and not has_schema_privilege('service_role', 'private', 'USAGE'),
  'anon and service_role cannot resolve names in private');
select ok(not has_schema_privilege('anon', 'private', 'CREATE')
          and not has_schema_privilege('authenticated', 'private', 'CREATE')
          and not has_schema_privilege('authenticated', 'public', 'CREATE')
          and not has_schema_privilege('anon', 'public', 'CREATE'),
  'no client role can create objects in public or private');

-- LIST: every table in private. There is no table of stored secrets: the
-- instance keeps no shared API keys.
select set_eq(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p') $$,
  $$ values ('admin_intents'),        -- an administrator's authorised, not yet executed Auth action
            ('invitation_tally')      -- one row per project invitation made, for the daily limit
  $$,
  'private holds exactly the known tables: the admin intents and the invitation tally');

select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'row level security is enabled on every private table, with no policy: a second lock');

select is_empty(
  $$ select format('%s: %s on private.%s', r.rolname, p.priv, c.relname)
       from pg_class c
      cross join (values ('anon'), ('authenticated'), ('service_role')) r (rolname)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                         ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p (priv)
      where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p')
        and has_table_privilege(r.rolname, c.oid, p.priv) $$,
  'no API role holds any privilege on a private table');

-- ===========================================================================
-- Functions
-- ===========================================================================

select is_empty(
  $$ select p.pronamespace::regnamespace || '.' || p.proname
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and p.prosecdef
        and not coalesce('search_path=""' = any (p.proconfig), false) $$,
  'every SECURITY DEFINER function in public and private pins search_path to empty');

select is_empty(
  $$ select p.pronamespace::regnamespace || '.' || p.proname
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and not coalesce('search_path=""' = any (p.proconfig), false) $$,
  'every function in public and private pins search_path to empty, definer or not');

select is_empty(
  $$ select p.pronamespace::regnamespace || '.' || p.proname || ' owned by ' || pg_get_userbyid(p.proowner)
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and p.prosecdef
        and pg_get_userbyid(p.proowner) <> 'postgres' $$,
  'every SECURITY DEFINER function in public and private is owned by postgres');

-- LIST (anon allow-list): functions in public that a caller with NO account may
-- run. Written as name(argument types). Add a function here only when it is
-- meant to be public, and say why.
select set_eq(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  $$ select unnest(array[
       -- ANON ALLOW-LIST START
       -- The organisation name, support contact, accent and offered study
       -- types: five values every visitor of the app is shown anyway.
       'get_public_instance()'
       -- ANON ALLOW-LIST END
     ]::text[]) $$,
  'anon can execute only the allow-listed functions in public');

-- LIST (the client surface): every function in public a signed-in caller may
-- run. This is the whole API of the backend: there is no table to read. A new
-- RPC must be granted in its migration and added here; each one starts with
-- the identity check (the two exceptions are named further down).
select set_eq(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  $$ select unnest(array[
       -- CLIENT RPC LIST START
       -- self and instance
       'my_profile()',
       'my_account()',                    -- the caller's own record, whatever state the account is in
       'update_my_profile(text, text)',
       'get_public_instance()',
       -- projects
       'list_my_projects()',
       'create_project(text, text, text)',
       'get_project(text)',
       'update_project_title(text, text)',
       'delete_project(text)',
       'get_project_content(text)',
       'put_project_content(text, text, integer, bigint, text)',
       'list_project_members(text)',
       'set_project_member_role(text, uuid, text)',
       'remove_project_member(text, uuid)',
       'leave_project(text)',
       'list_step_ownership(text)',
       'set_step_owner(text, text, uuid)',
       'get_project_activity(text, integer)',
       -- comments and reviews
       'list_project_comments(text, text)',
       'add_project_comment(text, text, text, uuid)',
       'list_project_reviews(text)',
       'set_project_review(text, text, text, text)',
       -- invitations
       'invite_project_member(text, text, text)',
       'list_project_invitations(text)',
       'cancel_project_invitation(uuid)',
       'list_my_invitations()',
       'accept_project_invitation(uuid)',
       'decline_project_invitation(uuid)',
       -- administration (each one checks the caller's instance role itself)
       'admin_list_users(text, text, text)',
       'admin_get_user(uuid)',
       'admin_update_user(uuid, jsonb)',
       'admin_revoke_sessions(uuid)',
       'admin_list_audit(integer, text, text, text, uuid, text, bigint, bigint)',
       'master_list_admins()',
       'master_set_role(uuid, text)',
       'admin_get_settings()',
       'admin_update_settings(jsonb)',
       -- administration, the steps the Edge Function "admin" starts with
       'admin_begin_invite(text, text, text, text, text)',
       'admin_begin_email_change(uuid, text)',
       'admin_check_user_action(uuid, text, text)',
       'admin_set_user_status(uuid, text, text)',
       'admin_soft_delete_user(uuid, text)'
       -- CLIENT RPC LIST END
     ]) $$,
  'authenticated can execute exactly the listed functions in public');

-- The secret key maps to service_role. It is for the Auth admin API only
-- (invite, change an email, ban, soft delete). The Edge Function "admin" calls
-- every RPC with the caller's own token, so service_role needs nothing in the
-- database: no function here, none in private (asserted below), no table
-- (asserted above). A leaked secret key reads and changes nothing through the
-- Data API.
select is_empty(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('service_role', p.oid, 'EXECUTE') $$,
  'service_role can execute no function in public');

-- Every function a client can call says who may call it: none is left on the
-- implicit grant to PUBLIC.
select is_empty(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and a.grantee = 0 and a.privilege_type = 'EXECUTE' $$,
  'no function in public or private is granted to PUBLIC');

-- has_function_privilege() counts a grant to PUBLIC, so this also proves that
-- nothing in private is executable by PUBLIC.
select is_empty(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      where p.pronamespace = 'private'::regnamespace
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
             or has_function_privilege('service_role', p.oid, 'EXECUTE')) $$,
  'no function in private is executable by anon, service_role or PUBLIC');

-- LIST (private helpers): what a signed-in caller may run in private. Only
-- what a policy evaluates, and the policies are kept as a second lock (see
-- 023). Each returns a fact about the caller and nothing else: is the caller
-- active, an admin, a master admin, which projects are they in, which address
-- have they confirmed. Everything else in private is reachable only from
-- security definer functions. The private schema is not exposed by the Data
-- API, so none of these can be called over HTTP either.
select set_eq(
  $$ select p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
       from pg_proc p
      where p.pronamespace = 'private'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  $$ select unnest(array[
       -- PRIVATE HELPER LIST START
       'is_active()',
       'is_admin()',
       'is_master()',
       'my_project_ids()',
       'current_confirmed_email()'
       -- PRIVATE HELPER LIST END
     ]) $$,
  'authenticated can execute only the listed helpers in private');

-- Every client function is SECURITY DEFINER and does its own authorisation.
-- A security invoker function could only read what the caller can select, and
-- the caller can select nothing; granting a table to make one work would bring
-- back the leak described at the top of this file.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and not p.prosecdef $$,
  'no client function is SECURITY INVOKER');

-- No client function is callable with positional or named arguments that pick
-- an overload: one name, one signature.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
      group by p.proname
     having count(*) > 1 $$,
  'no function in public is overloaded');

-- Every function a client can call begins by establishing who is calling.
-- my_profile() spells the check out (it must answer before a password is set);
-- everything else goes through require_active() or require_role().
--
-- LIST: the two functions without it. get_public_instance() shows five public
-- values to everyone. my_account() returns the caller's OWN record to a caller
-- who is suspended, deleted or signed out everywhere: the app asks it why it
-- was locked out. It is checked on its own below.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and p.proname not in ('get_public_instance', 'my_account')
        and p.prosrc !~ 'private\.require_active\(\)|private\.require_role\(|private\.session_is_live\(\)' $$,
  'every client function carries the identity check (get_public_instance and my_account are the exceptions)');

-- my_account() names no id but the caller's and takes no argument that could.
select ok(
  (select p.pronargs = 0
          and p.prosrc ~ 'where p\.id = \(select auth\.uid\(\)\)'
          and p.prosrc !~* 'audit_log|project|auth\.users|admin_intents'
     from pg_proc p
    where p.oid = 'public.my_account()'::regprocedure),
  'my_account() takes no argument and reads one row: the profile whose id is the caller''s');

-- The administration functions are granted to every signed-in caller, as all
-- client functions are, so each must check the instance role itself.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname ~ '^(admin|master)_'
        and p.prosrc !~ 'private\.require_role\(|private\.is_admin\(\)|private\.is_master\(\)' $$,
  'every admin_ and master_ function checks the caller''s instance role');
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname ~ '^master_'
        and p.prosrc !~ 'private\.require_role\(''master_admin''\)|private\.is_master\(\)' $$,
  'every master_ function requires a master admin');

-- The first master admin is made from the SQL editor, never through the API.
select is_empty(
  $$ select r.rolname
       from (values ('anon'), ('authenticated'), ('service_role'), ('authenticator')) r (rolname)
      where has_function_privilege(r.rolname, 'private.bootstrap_master_admin(text, boolean)', 'EXECUTE') $$,
  'no API role can execute the master admin bootstrap');

-- ===========================================================================
-- What the definer functions rely on
-- ===========================================================================

select ok(has_table_privilege('postgres', 'auth.sessions', 'SELECT'),
  'postgres can read auth.sessions (session liveness check)');
select ok(has_table_privilege('postgres', 'auth.sessions', 'DELETE'),
  'postgres can delete from auth.sessions (revoke sessions)');
select ok(has_table_privilege('postgres', 'auth.users', 'SELECT'),
  'postgres can read auth.users (confirmed email)');
select ok(has_table_privilege('postgres', 'auth.one_time_tokens', 'SELECT'),
  'postgres can read auth.one_time_tokens (which address a one-time code was sent to)');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_trigger t
     join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr)
    where t.tgrelid = 'auth.users'::regclass and t.tgname = 'scholea_on_auth_user_updated'),
  'confirmation_token,deleted_at,email,email_confirmed_at,encrypted_password,last_sign_in_at,recovery_token',
  'the profile sync trigger watches exactly the columns it reads, the two that hold a one-time code among them');

select has_trigger('auth', 'users', 'scholea_on_auth_user_created', 'auth.users has the profile creation trigger');
select has_trigger('auth', 'users', 'scholea_on_auth_user_updated', 'auth.users has the profile sync trigger');
select has_trigger('public', 'profiles', 'profiles_guard_last_master', 'profiles has the last master admin guard');
select has_trigger('public', 'audit_log', 'audit_log_no_update_or_delete', 'audit_log rejects update and delete');
select has_trigger('public', 'audit_log', 'audit_log_no_truncate', 'audit_log rejects truncate');

-- ===========================================================================
-- As a signed-in client
-- ===========================================================================

select tests.create_user('priv-user@example.test');
select tests.login_as('priv-user@example.test');

select is(current_user::text, 'authenticated', 'the checks below run as authenticated, not as the table owner');

-- One assertion per table and verb. Permission is checked before any row or
-- constraint is looked at, so the statements need not make sense.
select throws_ok(
         format('insert into public.%I default values', t), '42501', null,
         format('a client cannot insert into %s', t))
  from unnest(array['profiles', 'audit_log', 'instance_settings', 'projects', 'project_members',
                    'project_invitations', 'project_comments', 'project_reviews',
                    'step_ownership', 'project_activity']) t;

select throws_ok(
         format('update public.%I set %I = %I', t.name, t.col, t.col), '42501', null,
         format('a client cannot update %s', t.name))
  from (values ('profiles', 'role'), ('audit_log', 'action'), ('instance_settings', 'org_name'),
               ('projects', 'title'), ('project_members', 'role'), ('project_invitations', 'status'),
               ('project_comments', 'body'), ('project_reviews', 'status'),
               ('step_ownership', 'owner_id'), ('project_activity', 'detail')) t (name, col);

select throws_ok(
         format('delete from public.%I', t), '42501', null,
         format('a client cannot delete from %s', t))
  from unnest(array['profiles', 'audit_log', 'instance_settings', 'projects', 'project_members',
                    'project_invitations', 'project_comments', 'project_reviews',
                    'step_ownership', 'project_activity']) t;

select throws_ok(
         format('select * from public.%I', t), '42501', null,
         format('a client cannot read %s', t))
  from unnest(array['profiles', 'audit_log', 'instance_settings', 'projects', 'project_members',
                    'project_invitations', 'project_comments', 'project_reviews',
                    'step_ownership', 'project_activity']) t;

-- What "Prefer: count=planned" asks for: a plan, with its row estimate. No
-- plan is made for a table the caller may not select, so no estimate leaks.
select throws_ok(
         format('explain (format json) select * from public.%I', t), '42501', null,
         format('a client cannot have a query on %s planned (no row estimate)', t))
  from unnest(array['profiles', 'audit_log', 'instance_settings', 'projects', 'project_members',
                    'project_invitations', 'project_comments', 'project_reviews',
                    'step_ownership', 'project_activity']) t;
select throws_ok(
  $$ explain (format json) select * from public.profiles where email < 'm' $$, '42501', null,
  'a client cannot have a filtered query planned either (no estimate from the column statistics)');
select throws_ok($$ select * from private.admin_intents $$, '42501', null,
  'a client cannot read admin intents');
select throws_ok(
  $$ select private.write_audit(auth.uid(), 'forged.entry', 'user', 'x', null, null) $$, '42501', null,
  'a client cannot write an audit row through the helper');
select throws_ok(
  $$ select private.log_activity('proj_00000000-0000-4000-8000-000000000000', auth.uid(), 'forged', null) $$,
  '42501', null,
  'a client cannot write a ledger row through the helper');
select throws_ok($$ select private.require_role('master_admin') $$, '42501', null,
  'a client cannot call the role check directly');

select tests.logout();

-- ===========================================================================
-- As a caller with no account
-- ===========================================================================

select tests.as_anon();
select is(current_user::text, 'anon', 'the checks below run as anon');

select throws_ok(
         format('select * from public.%I', t), '42501', null,
         format('anon cannot read %s', t))
  from unnest(array['profiles', 'audit_log', 'instance_settings', 'projects', 'project_members',
                    'project_invitations', 'project_comments', 'project_reviews',
                    'step_ownership', 'project_activity']) t;

select throws_ok($$ select private.is_active() $$, '42501', null,
  'anon cannot call a private helper');

select tests.logout();

-- ===========================================================================
-- Default privileges: new objects start closed
-- ===========================================================================

create function public._tap_probe() returns integer language sql set search_path = '' as 'select 1';
create table public._tap_probe_table (id integer);

select ok(not has_function_privilege('anon', 'public._tap_probe()', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public._tap_probe()', 'EXECUTE')
          and not has_function_privilege('service_role', 'public._tap_probe()', 'EXECUTE'),
  'a new function in public is executable by no API role (and not by PUBLIC) until granted');

select is_empty(
  $$ select format('%s: %s', r.rolname, p.priv)
       from (values ('anon'), ('authenticated'), ('service_role')) r (rolname)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                         ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p (priv)
      where has_table_privilege(r.rolname, 'public._tap_probe_table', p.priv) $$,
  'a new table in public is granted to no API role');

select * from finish();
rollback;
