-- Projects: create, read, rename, delete, members, step ownership, activity.
--
-- Legacy parity (old server, projects.test.ts): the creator becomes the owner
-- and sees the project listed; non-members get 404 and learn nothing; only the
-- owner manages members; per-role permissions; step ownership only for actual
-- members; the contribution ledger; the last owner cannot be demoted or removed.
--
-- New here: create_project is idempotent on a client-chosen id, members can
-- leave, and there is no way to add a member by email (that is an invitation
-- now, see 045). Content sync is 040; comments and sign-offs are 050.

begin;
select plan(183);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- P1 the team project (created through the RPC below), P2 somebody else's,
-- P3 for deletion, P4 for the member who leaves.
select tests.create_user('pr-owner@example.test');
select tests.create_user('pr-editor@example.test');
select tests.create_user('pr-supervisor@example.test');
select tests.create_user('pr-viewer@example.test');
select tests.create_user('pr-outsider@example.test');
select tests.create_user('pr-admin@example.test', 'master_admin');
select tests.create_user('pr-suspended@example.test');
select tests.create_user('pr-invited@example.test', 'researcher', false);
select tests.create_user('pr-revoked@example.test');

update public.profiles set name = 'Olive Owner' where email = 'pr-owner@example.test';
update public.profiles set name = 'Edna Editor' where email = 'pr-editor@example.test';

create function pg_temp.add_member(p_project text, p_email text, p_role text, p_order integer)
returns void language sql as $$
  insert into public.project_members (project_id, user_id, role, added_at)
  values (p_project, tests.user_id(p_email), p_role, now() + make_interval(secs => p_order));
$$;

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;
grant execute on function pg_temp.keys(jsonb) to authenticated;

-- ===========================================================================
-- create_project
-- ===========================================================================

select tests.login_as('pr-owner@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(
  (public.create_project('proj_30000000-0000-4000-8000-000000000001', 'Shared SR', 'systematic-review') -> 'project')
    - 'created_at' - 'updated_at',
  jsonb_build_object(
    'id', 'proj_30000000-0000-4000-8000-000000000001', 'title', 'Shared SR', 'study_type', 'systematic-review',
    'owner_id', tests.user_id('pr-owner@example.test'), 'role', 'owner',
    'rev', 0, 'content_updated_at', null, 'collab_updated_at', null),
  'create_project: returns {project} with the client''s id, rev 0 and role owner');

select tests.as_owner();   -- a client cannot read a table: look at the stored rows as the owner
select results_eq(
  $$ select user_id, role, added_by from public.project_members
      where project_id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  $$ values (tests.user_id('pr-owner@example.test'), 'owner', tests.user_id('pr-owner@example.test')) $$,
  'create_project: the creator is the owner, and the only member');
select results_eq(
  $$ select actor_id, actor_name, action, detail from public.project_activity
      where project_id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  $$ values (tests.user_id('pr-owner@example.test'), 'Olive Owner', 'project.create', 'Shared SR') $$,
  'create_project: writes the project.create ledger entry');
select tests.as_client();
select is(
  public.list_my_projects() -> 'projects' -> 0 ->> 'role', 'owner',
  'the creator sees the project listed with the role owner (projects.test.ts 1)');

-- The same id again: the same project, nothing new.
select is(
  public.create_project('proj_30000000-0000-4000-8000-000000000001', 'Shared SR', 'systematic-review'),
  jsonb_build_object('project',
    (public.get_project('proj_30000000-0000-4000-8000-000000000001') -> 'project') || '{"role":"owner"}'::jsonb),
  'create_project: repeating the call with the same id returns the same project');
select is(
  public.create_project('proj_30000000-0000-4000-8000-000000000001', 'A different title', 'cohort') -> 'project' ->> 'title',
  'Shared SR',
  'create_project: a repeat does not overwrite the title or the study type');
select tests.as_owner();
select results_eq(
  $$ select (select count(*)::integer from public.projects where id = 'proj_30000000-0000-4000-8000-000000000001'),
            (select count(*)::integer from public.project_members where project_id = 'proj_30000000-0000-4000-8000-000000000001'),
            (select count(*)::integer from public.project_activity where project_id = 'proj_30000000-0000-4000-8000-000000000001') $$,
  $$ values (1, 1, 1) $$,
  'create_project: a repeat adds no project, no membership and no ledger entry');
select tests.as_client();

-- Id format.
select tests.throws_code(
         format('select public.create_project(%L, ''x'', ''rct'')', t.id), 'invalid_input', 400,
         'create_project: refuses an id that ' || t.why)
  from (values
         ('my-project',                                         'is not proj_<uuid>'),
         ('30000000-0000-4000-8000-0000000000aa',               'has no proj_ prefix'),
         ('proj_300000000000400080000000000000aa',              'has a uuid without dashes'),
         ('proj_30000000-0000-4000-8000-0000000000AA',          'is upper case'),
         ('proj_30000000-0000-4000-8000-0000000000aa ',         'ends in a space'),
         (E'proj_30000000-0000-4000-8000-0000000000aa\n',       'ends in a newline'),
         ('proj_30000000-0000-4000-8000-0000000000aa-extra',    'has extra characters'),
         ('',                                                   'is empty'),
         (null,                                                 'is missing')
       ) t (id, why);

select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000a1', '', 'rct') $$, 'invalid_input', 400,
  'create_project: an empty title is refused');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000a1', null, 'rct') $$, 'invalid_input', 400,
  'create_project: a missing title is refused');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000a1', repeat('t', 301), 'rct') $$, 'invalid_input', 400,
  'create_project: a title over 300 characters is refused');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000a1', 'x', '') $$, 'invalid_input', 400,
  'create_project: an empty study type is refused');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000a1', 'x', repeat('s', 101)) $$, 'invalid_input', 400,
  'create_project: a study type over 100 characters is refused');
select tests.as_owner();
select is_empty(
  $$ select 1 from public.projects where id like 'proj_30000000-0000-4000-8000-0000000000a%' $$,
  'create_project: none of the refused calls created anything');
select tests.as_client();

select is(
  char_length(public.create_project('proj_30000000-0000-4000-8000-000000000003', repeat('t', 300), repeat('s', 100))
              -> 'project' ->> 'title'), 300,
  'create_project: 300 and 100 characters are accepted');

-- Somebody else's id.
select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-000000000001', 'Mine now', 'rct') $$, 'conflict', 409,
  'create_project: an id that belongs to someone else''s project is a conflict');
select lives_ok(
  $$ select public.create_project('proj_30000000-0000-4000-8000-000000000002', 'Private project', 'cohort') $$,
  'create_project: the outsider creates their own project');

-- Scene: the team joins P1 (in production through an accepted invitation).
select tests.logout();
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-editor@example.test',     'editor',     1);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-supervisor@example.test', 'supervisor', 2);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-viewer@example.test',     'viewer',     3);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-suspended@example.test',  'owner',      4);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-invited@example.test',    'owner',      5);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-revoked@example.test',    'owner',      6);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000003', 'pr-editor@example.test',     'editor',     1);
update public.profiles set status = 'suspended' where email = 'pr-suspended@example.test';
update public.projects set updated_at = '2026-02-01 00:00:00+00' where id = 'proj_30000000-0000-4000-8000-000000000001';
update public.projects set updated_at = '2026-03-01 00:00:00+00' where id = 'proj_30000000-0000-4000-8000-000000000003';

select tests.login_as('pr-editor@example.test');
select tests.throws_code(
  $$ select public.create_project('proj_30000000-0000-4000-8000-000000000001', 'Shared SR', 'systematic-review') $$,
  'conflict', 409,
  'create_project: a member who is not an owner cannot claim the id either');

-- ===========================================================================
-- list_my_projects
-- ===========================================================================

select is(
  pg_temp.keys(public.list_my_projects() -> 'projects' -> 0),
  'collab_updated_at,content_updated_at,created_at,id,owner_id,rev,role,study_type,title,updated_at',
  'list_my_projects: each row has exactly the ten documented keys, and no content');
select results_eq(
  $$ select p ->> 'id', p ->> 'role', (p ->> 'updated_at')::bigint
       from jsonb_array_elements(public.list_my_projects() -> 'projects') with ordinality as t (p, n)
      order by n $$,
  $$ values ('proj_30000000-0000-4000-8000-000000000003', 'editor', 1772323200000::bigint),
            ('proj_30000000-0000-4000-8000-000000000001', 'editor', 1769904000000::bigint) $$,
  'list_my_projects: the caller''s projects, most recently touched first, with the caller''s own role');
select is(
  (public.list_my_projects() -> 'projects' -> 1) - 'role',
  public.get_project('proj_30000000-0000-4000-8000-000000000001') -> 'project',
  'list_my_projects: apart from role, a row is the same Project object get_project returns');

select tests.login_as('pr-outsider@example.test');
select results_eq(
  $$ select p ->> 'id' from jsonb_array_elements(public.list_my_projects() -> 'projects') p $$,
  $$ values ('proj_30000000-0000-4000-8000-000000000002') $$,
  'list_my_projects: nobody else''s project is listed');

select tests.login_as('pr-admin@example.test');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb,
  'list_my_projects: an instance master admin is in no project by virtue of the role');

-- ===========================================================================
-- get_project
-- ===========================================================================

select tests.login_as('pr-viewer@example.test');
select is(pg_temp.keys(public.get_project('proj_30000000-0000-4000-8000-000000000001')), 'members,project,role',
  'get_project: returns {project, role, members}');
select is(public.get_project('proj_30000000-0000-4000-8000-000000000001') ->> 'role', 'viewer',
  'get_project: role is the caller''s role on the project');
select is(
  pg_temp.keys(public.get_project('proj_30000000-0000-4000-8000-000000000001') -> 'project'),
  'collab_updated_at,content_updated_at,created_at,id,owner_id,rev,study_type,title,updated_at',
  'get_project: the Project object never carries the content');
select is(jsonb_array_length(public.get_project('proj_30000000-0000-4000-8000-000000000001') -> 'members'), 7,
  'get_project: includes the member list');

-- Not a member: 404, whether or not the project exists (projects.test.ts 2).
select tests.login_as('pr-outsider@example.test');
select tests.throws_code($$ select public.get_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'get_project: a non-member gets not_found');
select tests.throws_code($$ select public.get_project('proj_99999999-9999-4999-8999-999999999999') $$, 'not_found', 404,
  'get_project: exactly what a project that does not exist gives');
select tests.throws_code($$ select public.get_project(null) $$, 'not_found', 404,
  'get_project: a null id is not_found too');

select tests.login_as('pr-admin@example.test');
select tests.throws_code($$ select public.get_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'get_project: an instance master admin who is not a member gets not_found');

-- ===========================================================================
-- list_project_members
-- ===========================================================================

select tests.login_as('pr-viewer@example.test');
select is(
  pg_temp.keys(public.list_project_members('proj_30000000-0000-4000-8000-000000000001') -> 'members' -> 0),
  'added_at,email,name,project_id,role,user_id',
  'list_project_members: each member has exactly the six documented keys');
select results_eq(
  $$ select m ->> 'email', m ->> 'name', m ->> 'role'
       from jsonb_array_elements(public.list_project_members('proj_30000000-0000-4000-8000-000000000001') -> 'members')
            with ordinality as t (m, n)
      order by n $$,
  $$ values ('pr-owner@example.test',      'Olive Owner', 'owner'),
            ('pr-editor@example.test',     'Edna Editor', 'editor'),
            ('pr-supervisor@example.test', '',            'supervisor'),
            ('pr-viewer@example.test',     '',            'viewer'),
            ('pr-suspended@example.test',  '',            'owner'),
            ('pr-invited@example.test',    '',            'owner'),
            ('pr-revoked@example.test',    '',            'owner') $$,
  'list_project_members: every member with email, name and role, oldest membership first');
select throws_ok($$ select email from public.profiles $$, '42501', null,
  'a member still cannot read a co-member''s profile row, or any profile row: the list is all they get');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  $$ select public.list_project_members('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'list_project_members: a non-member gets not_found, so emails are not exposed');

-- ===========================================================================
-- update_project_title
-- ===========================================================================

select tests.login_as('pr-editor@example.test');
select is(
  public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Renamed by the editor') -> 'project' ->> 'title',
  'Renamed by the editor',
  'update_project_title: an editor can rename, and gets {project} back');

select tests.login_as('pr-owner@example.test');
select is(
  public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Shared SR') -> 'project' ->> 'title',
  'Shared SR',
  'update_project_title: the owner can rename');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', '') $$, 'invalid_input', 400,
  'update_project_title: an empty title is refused');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', null) $$, 'invalid_input', 400,
  'update_project_title: a missing title is refused');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', repeat('t', 301)) $$, 'invalid_input', 400,
  'update_project_title: a title over 300 characters is refused');

select tests.login_as('pr-viewer@example.test');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Nope') $$, 'forbidden', 403,
  'update_project_title: a viewer cannot rename (projects.test.ts 4)');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', '') $$, 'forbidden', 403,
  'update_project_title: the role is checked before the input');

select tests.login_as('pr-supervisor@example.test');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Nope') $$, 'forbidden', 403,
  'update_project_title: a supervisor cannot rename');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Nope') $$, 'not_found', 404,
  'update_project_title: a non-member gets not_found');

select tests.logout();
select is((select title from public.projects where id = 'proj_30000000-0000-4000-8000-000000000001'), 'Shared SR',
  'update_project_title: none of the refused calls renamed the project');

-- ===========================================================================
-- Step ownership
-- ===========================================================================

select tests.login_as('pr-owner@example.test');
select is(
  public.set_step_owner('proj_30000000-0000-4000-8000-000000000001', 'screening', tests.user_id('pr-editor@example.test')),
  jsonb_build_object('ownership', jsonb_build_array(jsonb_build_object(
    'project_id', 'proj_30000000-0000-4000-8000-000000000001', 'step_id', 'screening',
    'owner_id', tests.user_id('pr-editor@example.test')))),
  'set_step_owner: the owner assigns a step to a member and gets {ownership}, the whole list');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', 'screening',
         tests.user_id('pr-outsider@example.test')),
  'owner_not_a_member', 400,
  'set_step_owner: a step cannot be given to someone who is not a member (projects.test.ts 6)');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', 'screening',
         gen_random_uuid()),
  'owner_not_a_member', 400,
  'set_step_owner: nor to a user that does not exist');
select tests.throws_code(
  $$ select public.set_step_owner('proj_30000000-0000-4000-8000-000000000001', 'screening', null) $$, 'invalid_input', 400,
  'set_step_owner: an owner must be given');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', '',
         tests.user_id('pr-editor@example.test')),
  'invalid_input', 400, 'set_step_owner: an empty step id is refused');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', repeat('s', 201),
         tests.user_id('pr-editor@example.test')),
  'invalid_input', 400, 'set_step_owner: a step id over 200 characters is refused');

select tests.login_as('pr-editor@example.test');
select is(
  jsonb_array_length(public.set_step_owner('proj_30000000-0000-4000-8000-000000000001', 'extraction',
                                           tests.user_id('pr-viewer@example.test')) -> 'ownership'), 2,
  'set_step_owner: an editor can assign steps too');
select is(
  public.set_step_owner('proj_30000000-0000-4000-8000-000000000001', 'screening', tests.user_id('pr-owner@example.test'))
    -> 'ownership',
  jsonb_build_array(
    jsonb_build_object('project_id', 'proj_30000000-0000-4000-8000-000000000001', 'step_id', 'extraction',
                       'owner_id', tests.user_id('pr-viewer@example.test')),
    jsonb_build_object('project_id', 'proj_30000000-0000-4000-8000-000000000001', 'step_id', 'screening',
                       'owner_id', tests.user_id('pr-owner@example.test'))),
  'set_step_owner: assigning a step again replaces its owner; a step has one');

select tests.login_as('pr-viewer@example.test');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', 'screening',
         tests.user_id('pr-viewer@example.test')),
  'forbidden', 403, 'set_step_owner: a viewer cannot assign steps');
select is(
  jsonb_array_length(public.list_step_ownership('proj_30000000-0000-4000-8000-000000000001') -> 'ownership'), 2,
  'list_step_ownership: any member can read who owns which step');

select tests.login_as('pr-supervisor@example.test');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', 'screening',
         tests.user_id('pr-supervisor@example.test')),
  'forbidden', 403, 'set_step_owner: a supervisor cannot assign steps');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001', 'screening',
         tests.user_id('pr-outsider@example.test')),
  'not_found', 404, 'set_step_owner: a non-member gets not_found');
select tests.throws_code(
  $$ select public.list_step_ownership('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'list_step_ownership: a non-member gets not_found, not an empty list');
select is(public.list_step_ownership('proj_30000000-0000-4000-8000-000000000002'), '{"ownership":[]}'::jsonb,
  'list_step_ownership: a member of a project with no step owners gets an empty list');

-- ===========================================================================
-- set_project_member_role
-- ===========================================================================

select tests.login_as('pr-editor@example.test');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-editor@example.test'), 'owner'),
  'forbidden', 403,
  'set_project_member_role: an editor cannot promote themselves (only the owner manages members, projects.test.ts 3)');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test'), 'editor'),
  'forbidden', 403, 'set_project_member_role: an editor cannot change anyone else either');

select tests.login_as('pr-supervisor@example.test');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test'), 'editor'),
  'forbidden', 403, 'set_project_member_role: a supervisor cannot manage members');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-outsider@example.test'), 'owner'),
  'not_found', 404, 'set_project_member_role: a non-member gets not_found');

select tests.login_as('pr-owner@example.test');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test'), 'admin'),
  'invalid_role', 400, 'set_project_member_role: an instance role is not a project role');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, null)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test')),
  'invalid_role', 400, 'set_project_member_role: a role must be given');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-outsider@example.test'), 'editor'),
  'not_a_member', 404,
  'set_project_member_role: this is not a way to add someone, the target must be a member already');
select tests.throws_code(
  $$ select public.set_project_member_role('proj_30000000-0000-4000-8000-000000000001', null, 'editor') $$,
  'not_a_member', 404, 'set_project_member_role: a null target is not a member');

select results_eq(
  $$ select m ->> 'email', m ->> 'role'
       from jsonb_array_elements(
              public.set_project_member_role('proj_30000000-0000-4000-8000-000000000001',
                                             tests.user_id('pr-viewer@example.test'), 'editor') -> 'members') m
      where m ->> 'email' in ('pr-viewer@example.test', 'pr-owner@example.test')
      order by 1 $$,
  $$ values ('pr-owner@example.test', 'owner'), ('pr-viewer@example.test', 'editor') $$,
  'set_project_member_role: the owner changes a role and gets {members}, the whole list');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test'), 'viewer'),
  'set_project_member_role: and back again');

-- ===========================================================================
-- The last owner (projects.test.ts 8)
-- ===========================================================================
-- P2 has one owner, the outsider. On P1 the three extra owners are removed
-- first, so the owner is alone there too.

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000002',
         tests.user_id('pr-outsider@example.test'), 'editor'),
  'last_owner', 409, 'last owner: the only owner cannot demote themselves');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000002',
         tests.user_id('pr-outsider@example.test')),
  'last_owner', 409, 'last owner: the only owner cannot remove themselves');
select tests.throws_code(
  $$ select public.leave_project('proj_30000000-0000-4000-8000-000000000002') $$,
  'last_owner', 409, 'last owner: the only owner cannot leave');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000002',
         tests.user_id('pr-outsider@example.test'), 'owner'),
  'last owner: setting the only owner to owner again is not a demotion');

-- An owner who cannot use the app right now still counts as an owner; what
-- happens to a project whose only owner is suspended or deleted is deferred.
select tests.login_as('pr-owner@example.test');
select is(
  public.remove_project_member('proj_30000000-0000-4000-8000-000000000001', tests.user_id('pr-suspended@example.test')),
  '{"ok":true}'::jsonb, 'remove_project_member: an owner can remove another owner while one remains; returns {ok: true}');
select lives_ok(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-invited@example.test')),
  'remove_project_member: and another');
select lives_ok(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-revoked@example.test')),
  'remove_project_member: and the last extra one');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-owner@example.test'), 'editor'),
  'last_owner', 409, 'last owner: now alone on the team project, the owner cannot step down');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-owner@example.test')),
  'last_owner', 409, 'last owner: nor remove themselves');

-- Hand over, then step down.
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-editor@example.test'), 'owner'),
  'hand-over: the owner makes the editor a second owner');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-owner@example.test'), 'editor'),
  'hand-over: with a second owner in place, the first can step down');
select tests.throws_code(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-owner@example.test'), 'owner'),
  'forbidden', 403, 'hand-over: having stepped down, they cannot make themselves owner again');

select tests.login_as('pr-editor@example.test');
select tests.throws_code(
  $$ select public.leave_project('proj_30000000-0000-4000-8000-000000000001') $$,
  'last_owner', 409, 'hand-over: the new owner is now the last one and cannot leave');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-owner@example.test'), 'owner'),
  'hand-over: the new owner gives ownership back');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-editor@example.test'), 'editor'),
  'hand-over: and steps down, which restores the original roles');

-- ===========================================================================
-- remove_project_member
-- ===========================================================================

select tests.login_as('pr-editor@example.test');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test')),
  'forbidden', 403, 'remove_project_member: an editor cannot remove a member');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-editor@example.test')),
  'forbidden', 403, 'remove_project_member: not even themselves (that is leave_project)');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test')),
  'not_found', 404, 'remove_project_member: a non-member gets not_found');

select tests.login_as('pr-owner@example.test');
select tests.throws_code(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-outsider@example.test')),
  'not_a_member', 404, 'remove_project_member: the target must be a member');

-- The viewer owns the step "extraction" (assigned above).
select lives_ok(
  format('select public.remove_project_member(%L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-viewer@example.test')),
  'remove_project_member: the owner removes the viewer');
select is(
  public.list_step_ownership('proj_30000000-0000-4000-8000-000000000001') -> 'ownership',
  jsonb_build_array(jsonb_build_object(
    'project_id', 'proj_30000000-0000-4000-8000-000000000001', 'step_id', 'screening',
    'owner_id', tests.user_id('pr-owner@example.test'))),
  'remove_project_member: the steps the removed member owned are released');

select tests.login_as('pr-viewer@example.test');
select tests.throws_code($$ select public.get_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'remove_project_member: the removed member is a stranger to the project from the next call on');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb,
  'remove_project_member: and no longer has it listed');

-- ===========================================================================
-- leave_project
-- ===========================================================================

select tests.login_as('pr-outsider@example.test');
select tests.throws_code($$ select public.leave_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'leave_project: a non-member gets not_found');

select tests.login_as('pr-supervisor@example.test');
select is(public.leave_project('proj_30000000-0000-4000-8000-000000000001'), '{"ok":true}'::jsonb,
  'leave_project: a member who is not an owner leaves; returns {ok: true}');
select tests.throws_code($$ select public.leave_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'leave_project: leaving twice is not_found, they are no longer a member');
select tests.throws_code($$ select public.get_project('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'leave_project: after leaving, the project is gone for them');

-- One of two owners may leave.
select tests.login_as('pr-owner@example.test');
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000001',
         tests.user_id('pr-editor@example.test'), 'owner'),
  'leave_project: (scene) a second owner');
select is(public.leave_project('proj_30000000-0000-4000-8000-000000000001'), '{"ok":true}'::jsonb,
  'leave_project: an owner can leave while another owner remains');
select tests.logout();
select results_eq(
  $$ select tests.user_id('pr-editor@example.test') = user_id, role from public.project_members
      where project_id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  $$ values (true, 'owner') $$,
  'leave_project: the project is left with its remaining owner');
select results_eq(
  $$ select owner_id from public.projects where id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  $$ values (tests.user_id('pr-owner@example.test')) $$,
  'leave_project: owner_id keeps naming the creator; authority is the member role');
select is_empty(
  $$ select 1 from public.step_ownership where project_id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  'leave_project: the steps the leaver owned are released');

-- Scene: the owner is brought back, as an invitation would.
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-owner@example.test',      'owner',      10);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-supervisor@example.test', 'supervisor', 11);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-viewer@example.test',     'viewer',     12);
update public.project_members set role = 'editor'
 where project_id = 'proj_30000000-0000-4000-8000-000000000001' and user_id = tests.user_id('pr-editor@example.test');

-- ===========================================================================
-- get_project_activity
-- ===========================================================================

select tests.login_as('pr-viewer@example.test');
select is(pg_temp.keys(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001')), 'contributors,entries',
  'get_project_activity: returns {entries, contributors}');
select is(
  pg_temp.keys(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') -> 'entries' -> 0),
  'action,actor_id,actor_name,created_at,detail,id,project_id',
  'get_project_activity: each entry has exactly the seven documented keys');
select results_eq(
  $$ select e ->> 'action', e ->> 'detail', e ->> 'actor_name'
       from jsonb_array_elements(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') -> 'entries')
            with ordinality as t (e, n)
      order by n $$,
  $$ values ('ownership.set',  'screening',  'Edna Editor'),
            ('ownership.set',  'extraction', 'Edna Editor'),
            ('ownership.set',  'screening',  'Olive Owner'),
            ('project.create', 'Shared SR',  'Olive Owner') $$,
  'get_project_activity: who did what, newest first; any member can read it (role changes and removals are not ledger entries)');
select is(
  public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') -> 'contributors',
  jsonb_build_array(
    jsonb_build_object('actor', 'Edna Editor', 'actorId', tests.user_id('pr-editor@example.test'), 'count', 2,
      'lastAt', public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') -> 'entries' -> 0 -> 'created_at'),
    jsonb_build_object('actor', 'Olive Owner', 'actorId', tests.user_id('pr-owner@example.test'), 'count', 2,
      'lastAt', public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') -> 'entries' -> 2 -> 'created_at')),
  'get_project_activity: contributors are counted by account, busiest first, the most recent first among equals');

select is(
  jsonb_array_length(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001', 3) -> 'entries'), 3,
  'get_project_activity: p_limit limits the entries');
select is(
  public.get_project_activity('proj_30000000-0000-4000-8000-000000000001', 3) -> 'contributors' -> 1 -> 'count', '1'::jsonb,
  'get_project_activity: contributors summarise the returned entries only');
select is(
  jsonb_array_length(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001', 0) -> 'entries'), 1,
  'get_project_activity: a limit below 1 is treated as 1');
select is(
  jsonb_array_length(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001', null) -> 'entries'), 4,
  'get_project_activity: a null limit means the default');
select is(
  jsonb_array_length(public.get_project_activity('proj_30000000-0000-4000-8000-000000000001', 100000) -> 'entries'), 4,
  'get_project_activity: an absurd limit is accepted (and capped at 1000)');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code(
  $$ select public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'get_project_activity: a non-member gets not_found, not an empty ledger');

-- ===========================================================================
-- Who is refused
-- ===========================================================================
-- The three accounts below are OWNERS of the team project again, so every
-- refusal is about the caller's account and not about their project role.

select tests.logout();
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-suspended@example.test', 'owner', 20);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-invited@example.test',   'owner', 21);
select pg_temp.add_member('proj_30000000-0000-4000-8000-000000000001', 'pr-revoked@example.test',   'owner', 22);

create temp table rpc_calls (n integer generated always as identity primary key, name text, sql text);
grant select on rpc_calls to authenticated, anon;
insert into rpc_calls (name, sql) values
  ('list_my_projects',        $$ select public.list_my_projects() $$),
  ('create_project',          $$ select public.create_project('proj_30000000-0000-4000-8000-0000000000ff', 'Refused', 'rct') $$),
  ('get_project',             $$ select public.get_project('proj_30000000-0000-4000-8000-000000000001') $$),
  ('update_project_title',    $$ select public.update_project_title('proj_30000000-0000-4000-8000-000000000001', 'Refused') $$),
  ('list_project_members',    $$ select public.list_project_members('proj_30000000-0000-4000-8000-000000000001') $$),
  ('set_project_member_role', format('select public.set_project_member_role(%L, %L, %L)',
                                'proj_30000000-0000-4000-8000-000000000001', tests.user_id('pr-editor@example.test'), 'owner')),
  ('remove_project_member',   format('select public.remove_project_member(%L, %L)',
                                'proj_30000000-0000-4000-8000-000000000001', tests.user_id('pr-editor@example.test'))),
  ('leave_project',           $$ select public.leave_project('proj_30000000-0000-4000-8000-000000000001') $$),
  ('list_step_ownership',     $$ select public.list_step_ownership('proj_30000000-0000-4000-8000-000000000001') $$),
  ('set_step_owner',          format('select public.set_step_owner(%L, %L, %L)',
                                'proj_30000000-0000-4000-8000-000000000001', 'refused', tests.user_id('pr-editor@example.test'))),
  ('get_project_activity',    $$ select public.get_project_activity('proj_30000000-0000-4000-8000-000000000001') $$),
  ('delete_project',          $$ select public.delete_project('proj_30000000-0000-4000-8000-000000000001') $$);

select tests.login_as('pr-suspended@example.test');
select tests.throws_code(c.sql, 'account_suspended', 403, c.name || ': refused for a suspended account')
  from rpc_calls c order by c.n;

select tests.login_as('pr-invited@example.test');
select tests.throws_code(c.sql, 'password_reset_required', 403, c.name || ': refused until the invited person sets a password')
  from rpc_calls c order by c.n;

select tests.login_as('pr-revoked@example.test');
select is(public.get_project('proj_30000000-0000-4000-8000-000000000001') ->> 'role', 'owner',
  'revoked: (scene) the account works while its session exists');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('pr-revoked@example.test');
select tests.resume_as('pr-revoked@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(c.sql, '42501', null, c.name || ': not callable without an account')
  from rpc_calls c order by c.n;

select tests.logout();
select results_eq(
  $$ select (select count(*)::integer from public.projects where id = 'proj_30000000-0000-4000-8000-000000000001' and title = 'Shared SR'),
            (select count(*)::integer from public.project_members where project_id = 'proj_30000000-0000-4000-8000-000000000001'),
            (select role from public.project_members
              where project_id = 'proj_30000000-0000-4000-8000-000000000001' and user_id = tests.user_id('pr-editor@example.test')),
            (select count(*)::integer from public.step_ownership where step_id = 'refused'),
            (select count(*)::integer from public.projects where id = 'proj_30000000-0000-4000-8000-0000000000ff') $$,
  $$ values (1, 7, 'editor', 0, 0) $$,
  'none of the refused calls changed anything');

-- ===========================================================================
-- delete_project
-- ===========================================================================
-- P3 belongs to the owner, with the editor as a member.

select tests.login_as('pr-editor@example.test');
select tests.throws_code($$ select public.delete_project('proj_30000000-0000-4000-8000-000000000003') $$, 'forbidden', 403,
  'delete_project: an editor cannot delete the project');

select tests.login_as('pr-outsider@example.test');
select tests.throws_code($$ select public.delete_project('proj_30000000-0000-4000-8000-000000000003') $$, 'not_found', 404,
  'delete_project: a non-member gets not_found');
select tests.throws_code($$ select public.delete_project('proj_99999999-9999-4999-8999-999999999999') $$, 'not_found', 404,
  'delete_project: so does a project that does not exist');

select tests.login_as('pr-owner@example.test');
select lives_ok(
  format('select public.set_step_owner(%L, %L, %L)', 'proj_30000000-0000-4000-8000-000000000003', 'protocol',
         tests.user_id('pr-editor@example.test')),
  'delete_project: (scene) a step owner on the project');
select is(public.delete_project('proj_30000000-0000-4000-8000-000000000003'), '{"ok":true}'::jsonb,
  'delete_project: the owner deletes it; returns {ok: true}');
select tests.throws_code($$ select public.delete_project('proj_30000000-0000-4000-8000-000000000003') $$, 'not_found', 404,
  'delete_project: deleting it again is not_found');
select tests.logout();
select is_empty(
  $$ select 1 from public.projects         where id         = 'proj_30000000-0000-4000-8000-000000000003'
     union all
     select 1 from public.project_members  where project_id = 'proj_30000000-0000-4000-8000-000000000003'
     union all
     select 1 from public.step_ownership   where project_id = 'proj_30000000-0000-4000-8000-000000000003'
     union all
     select 1 from public.project_activity where project_id = 'proj_30000000-0000-4000-8000-000000000003' $$,
  'delete_project: the project, its members, step owners and ledger are gone');
select is((select count(*)::integer from public.projects where id = 'proj_30000000-0000-4000-8000-000000000001'), 1,
  'delete_project: other projects are untouched');

-- ===========================================================================
-- No back door into a project
-- ===========================================================================

select hasnt_function('public', 'add_project_member', 'there is no add_project_member function');
-- The only statements that create a membership are in the two functions that
-- are meant to: creating your own project, and accepting an invitation.
select set_eq(
  $$ select p.pronamespace::regnamespace || '.' || p.proname
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and p.prosrc ~* 'insert\s+into\s+public\.project_members' $$,
  $$ values ('public.create_project'), ('public.accept_project_invitation') $$,
  'a membership is created in exactly two places: create_project and accept_project_invitation');
select is_empty(
  $$ select p.pronamespace::regnamespace || '.' || p.proname
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and p.prosrc ~* 'update\s+public\.project_members'
        and p.proname <> 'set_project_member_role' $$,
  'a member''s role is changed in exactly one place: set_project_member_role');

select tests.login_as('pr-outsider@example.test');
select throws_ok(
  format('insert into public.project_members (project_id, user_id, role) values (%L, %L, %L)',
         'proj_30000000-0000-4000-8000-000000000001', tests.user_id('pr-outsider@example.test'), 'owner'),
  '42501', null, 'a client cannot add themselves to a project by writing to the table');
select throws_ok(
  $$ update public.projects set owner_id = auth.uid() where id = 'proj_30000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'a client cannot make themselves the creator of a project by writing to the table');
select tests.logout();

select * from finish();
rollback;
