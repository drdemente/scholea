-- Projects and collaboration: table rules, the private project helpers, the
-- collab_updated_at stamp, and who can read what.
--
-- The RPCs that read and write these tables come in later migrations. Here
-- rows are written as the owner of the database to set the scene.
--
-- Clients cannot read any table (010, 011). The "who can read what" part of
-- this file is about the policies, which are kept as a second lock: it grants
-- the tables for a while inside its own transaction, as a mistaken migration
-- would, and then reads them as each kind of signed-in client.

begin;
select plan(85);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- p1: the team project.  p2: somebody else's.  p3: for the ledger tests.
create temp table p (k text primary key, id text not null);
insert into p values
  ('p1', 'proj_11111111-1111-4111-8111-111111111111'),
  ('p2', 'proj_22222222-2222-4222-8222-222222222222'),
  ('p3', 'proj_33333333-3333-4333-8333-333333333333');

select tests.create_user('cf-owner@example.test');
select tests.create_user('cf-editor@example.test');
select tests.create_user('cf-supervisor@example.test');
select tests.create_user('cf-viewer@example.test');
select tests.create_user('cf-outsider@example.test');
select tests.create_user('cf-admin@example.test', 'admin');
select tests.create_user('cf-suspended@example.test');
select tests.create_user('cf-invited@example.test', 'researcher', false);
select tests.create_user('cf-invitee@example.test');
select tests.create_user('cf-unconfirmed@example.test');

update public.profiles set name = 'Olive Owner' where email = 'cf-owner@example.test';
update auth.users set email_confirmed_at = null where id = tests.user_id('cf-unconfirmed@example.test');

insert into public.projects (id, title, study_type, owner_id) values
  ('proj_11111111-1111-4111-8111-111111111111', 'Team project', 'rct', tests.user_id('cf-owner@example.test')),
  ('proj_22222222-2222-4222-8222-222222222222', 'Private project', 'cohort', tests.user_id('cf-outsider@example.test')),
  ('proj_33333333-3333-4333-8333-333333333333', 'Ledger project', 'rct', tests.user_id('cf-owner@example.test'));

insert into public.project_members (project_id, user_id, role) values
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-owner@example.test'),      'owner'),
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-editor@example.test'),     'editor'),
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-supervisor@example.test'), 'supervisor'),
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-viewer@example.test'),     'viewer'),
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-suspended@example.test'),  'editor'),
  ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-invited@example.test'),    'editor'),
  ('proj_22222222-2222-4222-8222-222222222222', tests.user_id('cf-outsider@example.test'),   'owner'),
  ('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'),      'owner'),
  ('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-editor@example.test'),     'editor');

update public.profiles set status = 'suspended' where email = 'cf-suspended@example.test';

-- ===========================================================================
-- collab_updated_at: moves on every comment and review, and only forwards
-- ===========================================================================

create temp table stamps (n integer primary key, at timestamptz);

select is((select collab_updated_at from public.projects where id = (select id from p where k = 'p1')), null,
  'stamp: null until the first comment or review');

insert into public.project_comments (project_id, step_id, author_id, author_name, body)
values ((select id from p where k = 'p1'), 'question', tests.user_id('cf-owner@example.test'), 'Olive Owner', 'First comment');
insert into stamps select 1, collab_updated_at from public.projects where id = (select id from p where k = 'p1');
select isnt((select at from stamps where n = 1), null, 'stamp: set by the first comment');

insert into public.project_comments (project_id, step_id, author_id, author_name, body)
values ((select id from p where k = 'p1'), 'question', tests.user_id('cf-editor@example.test'), 'cf-editor@example.test', 'Second comment');
insert into stamps select 2, collab_updated_at from public.projects where id = (select id from p where k = 'p1');
select cmp_ok(private.to_ms((select at from stamps where n = 2)), '>', private.to_ms((select at from stamps where n = 1)),
  'stamp: a second comment moves it forward by at least a millisecond, even inside one transaction');

insert into public.project_reviews (project_id, step_id, status, reviewer_id, reviewer_name)
values ((select id from p where k = 'p1'), 'question', 'changes', tests.user_id('cf-supervisor@example.test'), 'cf-supervisor@example.test');
insert into stamps select 3, collab_updated_at from public.projects where id = (select id from p where k = 'p1');
select cmp_ok(private.to_ms((select at from stamps where n = 3)), '>', private.to_ms((select at from stamps where n = 2)),
  'stamp: a new review moves it');

update public.project_reviews set status = 'approved', note = 'Looks right now'
 where project_id = (select id from p where k = 'p1') and step_id = 'question';
insert into stamps select 4, collab_updated_at from public.projects where id = (select id from p where k = 'p1');
select cmp_ok(private.to_ms((select at from stamps where n = 4)), '>', private.to_ms((select at from stamps where n = 3)),
  'stamp: replacing a review moves it');

-- A writer whose clock reading is older than the stored stamp still moves it forward.
update public.projects set collab_updated_at = now() + interval '1 hour' where id = (select id from p where k = 'p1');
insert into public.project_comments (project_id, step_id, author_id, author_name, body)
values ((select id from p where k = 'p1'), 'protocol', tests.user_id('cf-owner@example.test'), 'Olive Owner', 'Third comment');
select cmp_ok(
  (select collab_updated_at from public.projects where id = (select id from p where k = 'p1')),
  '>', now() + interval '1 hour',
  'stamp: never goes backwards');

select is((select collab_updated_at from public.projects where id = (select id from p where k = 'p2')), null,
  'stamp: another project is not touched');

-- More scene-setting for the read tests below.
insert into public.project_comments (project_id, step_id, author_id, author_name, body)
values ((select id from p where k = 'p2'), 'question', tests.user_id('cf-outsider@example.test'), 'cf-outsider@example.test', 'Private comment');
insert into public.project_reviews (project_id, step_id, status, reviewer_id, reviewer_name)
values ((select id from p where k = 'p2'), 'question', 'approved', tests.user_id('cf-outsider@example.test'), 'cf-outsider@example.test');
insert into public.step_ownership (project_id, step_id, owner_id) values
  ((select id from p where k = 'p1'), 'protocol', tests.user_id('cf-editor@example.test')),
  ((select id from p where k = 'p2'), 'protocol', tests.user_id('cf-outsider@example.test'));

-- ===========================================================================
-- Table rules
-- ===========================================================================

select throws_ok(
  $$ insert into public.projects (id, title, study_type) values ('my-project', 'x', 'rct') $$, '23514', null,
  'projects: an id that is not proj_<uuid> is rejected');
select throws_ok(
  $$ insert into public.projects (id, title, study_type)
     values ('proj_AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'x', 'rct') $$, '23514', null,
  'projects: an upper-case uuid is rejected (ids are compared as text)');
select throws_ok(
  $$ insert into public.projects (id, title, study_type)
     values ('proj_11111111-1111-4111-8111-111111111111', 'again', 'rct') $$, '23505', null,
  'projects: an id can be used once');
select lives_ok(
  $$ insert into public.projects (title, study_type) values ('Server-generated id', 'rct') $$,
  'projects: the default id satisfies the format');
select throws_ok(
  $$ insert into public.projects (title, study_type) values ('', 'rct') $$, '23514', null,
  'projects: an empty title is rejected');
select throws_ok(
  $$ insert into public.projects (title, study_type) values (repeat('t', 301), 'rct') $$, '23514', null,
  'projects: a title over 300 characters is rejected');
select throws_ok(
  $$ update public.projects set rev = -1 where id = 'proj_11111111-1111-4111-8111-111111111111' $$, '23514', null,
  'projects: rev cannot be negative');
select lives_ok(
  $$ update public.projects set content = '{"stepData":{"pdf":"a\u0000b"},"stepStatus":{}}', rev = 1, content_updated_at = 1767225600000
      where id = 'proj_11111111-1111-4111-8111-111111111111' $$,
  'projects: content is opaque text, so a \u0000 escape (common in text taken from PDFs) is stored');

select throws_ok(
  $$ insert into public.project_members (project_id, user_id, role)
     values ('proj_22222222-2222-4222-8222-222222222222', tests.user_id('cf-owner@example.test'), 'admin') $$,
  '23514', null,
  'members: only viewer, editor, supervisor and owner are project roles');
select throws_ok(
  $$ insert into public.project_members (project_id, user_id, role)
     values ('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-owner@example.test'), 'editor') $$,
  '23505', null,
  'members: one membership per person and project');

select throws_ok(
  $$ insert into public.project_comments (project_id, step_id, author_name, body)
     values ('proj_11111111-1111-4111-8111-111111111111', 'question', 'x', '') $$, '23514', null,
  'comments: an empty comment is rejected');
select throws_ok(
  $$ insert into public.project_comments (project_id, step_id, author_name, body)
     values ('proj_11111111-1111-4111-8111-111111111111', 'question', 'x', repeat('c', 5001)) $$, '23514', null,
  'comments: more than 5000 characters is rejected');
select lives_ok(
  $$ insert into public.project_comments (id, project_id, step_id, author_name, body)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'proj_33333333-3333-4333-8333-333333333333', 'question', 'x', repeat('c', 5000)) $$,
  'comments: 5000 characters with a client-chosen id is accepted');
select throws_ok(
  $$ insert into public.project_comments (id, project_id, step_id, author_name, body)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'proj_33333333-3333-4333-8333-333333333333', 'question', 'x', 'again') $$,
  '23505', null,
  'comments: a comment id can be used once, which is what makes a retried upload detectable');
select col_type_is('public', 'project_comments', 'id', 'uuid', 'comments: the id is a uuid');

select throws_ok(
  $$ insert into public.project_reviews (project_id, step_id, status, reviewer_name)
     values ('proj_33333333-3333-4333-8333-333333333333', 'question', 'rejected', 'x') $$, '23514', null,
  'reviews: status is approved or changes');
select throws_ok(
  $$ insert into public.project_reviews (project_id, step_id, status, reviewer_name, note)
     values ('proj_33333333-3333-4333-8333-333333333333', 'question', 'approved', 'x', repeat('n', 2001)) $$, '23514', null,
  'reviews: a note over 2000 characters is rejected');
select throws_ok(
  $$ insert into public.project_reviews (project_id, step_id, status, reviewer_name)
     values ('proj_11111111-1111-4111-8111-111111111111', 'question', 'approved', 'x') $$, '23505', null,
  'reviews: one sign-off per step');

select throws_ok(
  $$ insert into public.step_ownership (project_id, step_id, owner_id)
     values ('proj_11111111-1111-4111-8111-111111111111', 'analysis', tests.user_id('cf-outsider@example.test')) $$,
  '23503', null,
  'step ownership: the owner of a step must be a member of the project');
insert into public.step_ownership (project_id, step_id, owner_id)
values ('proj_33333333-3333-4333-8333-333333333333', 'analysis', tests.user_id('cf-editor@example.test'));
delete from public.project_members
 where project_id = 'proj_33333333-3333-4333-8333-333333333333' and user_id = tests.user_id('cf-editor@example.test');
select is_empty(
  $$ select 1 from public.step_ownership where project_id = 'proj_33333333-3333-4333-8333-333333333333' $$,
  'step ownership: removing the member clears the steps they owned');

-- Invitations.
insert into public.project_invitations (project_id, email, role, invited_by)
values ('proj_11111111-1111-4111-8111-111111111111', 'cf-invitee@example.test', 'editor', tests.user_id('cf-owner@example.test'));

select results_eq(
  $$ select status, responded_at, expires_at = created_at + interval '30 days'
       from public.project_invitations where email = 'cf-invitee@example.test' $$,
  $$ values ('pending', null::timestamptz, true) $$,
  'invitations: pending by default and valid for 30 days');
select throws_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_11111111-1111-4111-8111-111111111111', 'cf-invitee@example.test', 'viewer', tests.user_id('cf-owner@example.test')) $$,
  '23505', null,
  'invitations: one live invitation per project and address');
update public.project_invitations set status = 'declined', responded_at = now() where email = 'cf-invitee@example.test';
select throws_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_11111111-1111-4111-8111-111111111111', 'cf-invitee@example.test', 'viewer', tests.user_id('cf-owner@example.test')) $$,
  '23505', null,
  'invitations: a declined one still counts as live, so re-inviting cannot create a second row that would give the decline away');
update public.project_invitations set status = 'cancelled' where email = 'cf-invitee@example.test';
select lives_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_11111111-1111-4111-8111-111111111111', 'cf-invitee@example.test', 'viewer', tests.user_id('cf-owner@example.test')) $$,
  'invitations: after a cancel the address can be invited again');
select lives_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_22222222-2222-4222-8222-222222222222', 'cf-invitee@example.test', 'viewer', tests.user_id('cf-outsider@example.test')) $$,
  'invitations: the same address can be invited to another project');
select throws_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_11111111-1111-4111-8111-111111111111', 'Someone@example.test', 'viewer', tests.user_id('cf-owner@example.test')) $$,
  '23514', null,
  'invitations: the address must be stored lower case');
select throws_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by)
     values ('proj_11111111-1111-4111-8111-111111111111', 'cf-boss@example.test', 'owner', tests.user_id('cf-owner@example.test')) $$,
  '23514', null,
  'invitations: nobody can be invited as an owner');
select throws_ok(
  $$ insert into public.project_invitations (project_id, email, role, invited_by, status)
     values ('proj_11111111-1111-4111-8111-111111111111', 'cf-odd@example.test', 'viewer', tests.user_id('cf-owner@example.test'), 'maybe') $$,
  '23514', null,
  'invitations: status is one of the five known values');

-- ===========================================================================
-- Project helpers
-- ===========================================================================

select results_eq(
  $$ select u, private.project_role_of('proj_11111111-1111-4111-8111-111111111111', tests.user_id(u))
       from unnest(array['cf-owner@example.test', 'cf-editor@example.test', 'cf-supervisor@example.test',
                         'cf-viewer@example.test', 'cf-outsider@example.test']) with ordinality as t (u, n)
      order by n $$,
  $$ values ('cf-owner@example.test', 'owner'), ('cf-editor@example.test', 'editor'),
            ('cf-supervisor@example.test', 'supervisor'), ('cf-viewer@example.test', 'viewer'),
            ('cf-outsider@example.test', null) $$,
  'project_role_of: each member''s role, and null for a non-member');
select is(private.project_role_of('proj_99999999-9999-4999-8999-999999999999', tests.user_id('cf-owner@example.test')), null,
  'project_role_of: null for a project that does not exist');

select is(private.display_name(tests.user_id('cf-owner@example.test')), 'Olive Owner',
  'display_name: the profile name');
select is(private.display_name(tests.user_id('cf-editor@example.test')), 'cf-editor',
  'display_name: the part of the address before the @ when no name is set, never the whole address');
select is(private.display_name(gen_random_uuid()), '', 'display_name: empty for an unknown user, never null');

-- Last owner.
select tests.throws_code(
  $$ select private.assert_not_last_owner('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-owner@example.test')) $$,
  'last_owner', 409, 'assert_not_last_owner: refuses when that user is the only owner');
select lives_ok(
  $$ select private.assert_not_last_owner('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-editor@example.test')) $$,
  'assert_not_last_owner: passes for someone else while an owner remains');
update public.project_members set role = 'owner'
 where project_id = 'proj_11111111-1111-4111-8111-111111111111' and user_id = tests.user_id('cf-supervisor@example.test');
select lives_ok(
  $$ select private.assert_not_last_owner('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-owner@example.test')) $$,
  'assert_not_last_owner: passes once there is a second owner');
update public.project_members set role = 'supervisor'
 where project_id = 'proj_11111111-1111-4111-8111-111111111111' and user_id = tests.user_id('cf-supervisor@example.test');
select tests.throws_code(
  $$ select private.assert_not_last_owner('proj_99999999-9999-4999-8999-999999999999', tests.user_id('cf-owner@example.test')) $$,
  'last_owner', 409, 'assert_not_last_owner: a project with no owner at all is refused too');

-- ===========================================================================
-- The contribution ledger
-- ===========================================================================

update public.projects set updated_at = '2026-01-01 00:00:00+00' where id = 'proj_33333333-3333-4333-8333-333333333333';

select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'project.create');
select results_eq(
  $$ select actor_id, actor_name, action, detail, id ~ '^act_[0-9a-f-]{36}$'
       from public.project_activity where project_id = 'proj_33333333-3333-4333-8333-333333333333' $$,
  $$ values (tests.user_id('cf-owner@example.test'), 'Olive Owner', 'project.create', null::text, true) $$,
  'log_activity: writes the entry with a snapshot of the actor''s name');
select cmp_ok(
  (select updated_at from public.projects where id = 'proj_33333333-3333-4333-8333-333333333333'),
  '>', '2026-01-01 00:00:00+00'::timestamptz,
  'log_activity: touches the project, so it sorts first in the project list');

-- content.sync: one entry per editing session, not one per save.
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 1');
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 2');
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 3');
select results_eq(
  $$ select action, detail from public.project_activity
      where project_id = 'proj_33333333-3333-4333-8333-333333333333' order by created_at $$,
  $$ values ('project.create', null), ('content.sync', 'rev 3') $$,
  'content.sync: repeated saves by one person become one entry showing the latest revision');

select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-editor@example.test'), 'content.sync', 'rev 4');
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 5');
select results_eq(
  $$ select actor_name, detail from public.project_activity
      where project_id = 'proj_33333333-3333-4333-8333-333333333333' and action = 'content.sync' order by created_at $$,
  $$ values ('Olive Owner', 'rev 3'), ('cf-editor', 'rev 4'), ('Olive Owner', 'rev 5') $$,
  'content.sync: a save by someone else ends the session, so the next save is a new entry');

select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'comment.add', 'question');
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 6');
select is(
  (select count(*)::integer from public.project_activity
    where project_id = 'proj_33333333-3333-4333-8333-333333333333' and action = 'content.sync'), 4,
  'content.sync: any other entry in between ends the session too');

-- Eleven minutes later.
update public.project_activity set created_at = created_at - interval '11 minutes'
 where project_id = 'proj_33333333-3333-4333-8333-333333333333';
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 7');
select is(
  (select count(*)::integer from public.project_activity
    where project_id = 'proj_33333333-3333-4333-8333-333333333333' and action = 'content.sync'), 5,
  'content.sync: after more than ten minutes of silence the next save is a new entry');

-- Nine minutes later.
update public.project_activity set created_at = created_at - interval '9 minutes'
 where project_id = 'proj_33333333-3333-4333-8333-333333333333';
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'content.sync', 'rev 8');
select results_eq(
  $$ select count(*)::integer, max(detail) filter (where detail in ('rev 7', 'rev 8'))
       from public.project_activity
      where project_id = 'proj_33333333-3333-4333-8333-333333333333' and action = 'content.sync' $$,
  $$ values (5, 'rev 8') $$,
  'content.sync: within ten minutes the entry is refreshed in place');
select cmp_ok(
  (select created_at from public.project_activity
    where project_id = 'proj_33333333-3333-4333-8333-333333333333' and detail = 'rev 8'),
  '>', now() - interval '1 minute',
  'content.sync: a refreshed entry carries the time of the latest save');

-- Only content.sync is coalesced.
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'comment.add', 'methods');
select private.log_activity('proj_33333333-3333-4333-8333-333333333333', tests.user_id('cf-owner@example.test'), 'comment.add', 'methods');
select is(
  (select count(*)::integer from public.project_activity
    where project_id = 'proj_33333333-3333-4333-8333-333333333333' and action = 'comment.add' and detail = 'methods'), 2,
  'log_activity: every other action is one entry per call');

select throws_ok(
  $$ select private.log_activity('proj_99999999-9999-4999-8999-999999999999', tests.user_id('cf-owner@example.test'), 'project.create') $$,
  '23503', null,
  'log_activity: an entry for a project that does not exist is refused');

select private.log_activity('proj_11111111-1111-4111-8111-111111111111', tests.user_id('cf-owner@example.test'), 'project.create');
select private.log_activity('proj_22222222-2222-4222-8222-222222222222', tests.user_id('cf-outsider@example.test'), 'project.create');

-- ===========================================================================
-- Who can read what: the policies (defence in depth)
-- ===========================================================================
-- Clients have no SELECT on these tables; they use the RPCs. The grant below
-- exists only inside this transaction, to prove what the policies would allow
-- if a table were ever opened: the caller's own projects, and nothing at all
-- while the caller is not allowed in.

grant select on public.profiles, public.projects, public.project_members, public.project_comments,
  public.project_reviews, public.step_ownership, public.project_activity to authenticated;

select tests.login_as('cf-owner@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select set_eq(
  $$ select private.my_project_ids() $$,
  $$ values ('proj_11111111-1111-4111-8111-111111111111'), ('proj_33333333-3333-4333-8333-333333333333') $$,
  'owner: my_project_ids lists exactly their projects');
select set_eq(
  $$ select id from public.projects $$,
  $$ values ('proj_11111111-1111-4111-8111-111111111111'), ('proj_33333333-3333-4333-8333-333333333333') $$,
  'owner: reads their projects and not the private one');
select is((select count(*)::integer from public.project_members
            where project_id = 'proj_11111111-1111-4111-8111-111111111111'), 6,
  'owner: reads the whole member list of their project');
select is((select count(*)::integer from public.project_comments
            where project_id = 'proj_11111111-1111-4111-8111-111111111111'), 3,
  'owner: reads the comments of their project');
select is_empty(
  $$ select 1 from public.project_members   where project_id = 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_comments  where project_id = 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_reviews   where project_id = 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.step_ownership    where project_id = 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_activity  where project_id = 'proj_22222222-2222-4222-8222-222222222222' $$,
  'owner: reads nothing at all from a project they are not a member of');
select results_eq(
  $$ select email from public.profiles $$, $$ values ('cf-owner@example.test') $$,
  'owner: cannot read a co-member''s profile row (member lists come from an RPC)');

-- Every project role can read; reading is what membership means.
select tests.login_as('cf-editor@example.test');
select results_eq(
  $$ select (select count(*)::integer from public.projects),
            (select count(*)::integer from public.project_members),
            (select count(*)::integer from public.project_comments),
            (select count(*)::integer from public.project_reviews),
            (select count(*)::integer from public.step_ownership),
            (select count(*)::integer from public.project_activity) $$,
  $$ values (1, 6, 3, 1, 1, 1) $$,
  'editor: reads the project, its members, comments, reviews, step ownership and ledger');

select tests.login_as('cf-supervisor@example.test');
select results_eq(
  $$ select (select count(*)::integer from public.projects),
            (select count(*)::integer from public.project_members),
            (select count(*)::integer from public.project_comments),
            (select count(*)::integer from public.project_reviews),
            (select count(*)::integer from public.step_ownership),
            (select count(*)::integer from public.project_activity) $$,
  $$ values (1, 6, 3, 1, 1, 1) $$,
  'supervisor: reads the same');

select tests.login_as('cf-viewer@example.test');
select results_eq(
  $$ select (select count(*)::integer from public.projects),
            (select count(*)::integer from public.project_members),
            (select count(*)::integer from public.project_comments),
            (select count(*)::integer from public.project_reviews),
            (select count(*)::integer from public.step_ownership),
            (select count(*)::integer from public.project_activity) $$,
  $$ values (1, 6, 3, 1, 1, 1) $$,
  'viewer: reads the same');
select results_eq(
  $$ select title, content is not null, rev, content_updated_at from public.projects $$,
  $$ values ('Team project', true, 1, 1767225600000::bigint) $$,
  'viewer: a member can read the project content directly');

-- Not a member.
select tests.login_as('cf-outsider@example.test');
select results_eq(
  $$ select id from public.projects $$, $$ values ('proj_22222222-2222-4222-8222-222222222222') $$,
  'outsider: reads only their own project');
select is_empty(
  $$ select 1 from public.project_members   where project_id <> 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_comments  where project_id <> 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_reviews   where project_id <> 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.step_ownership    where project_id <> 'proj_22222222-2222-4222-8222-222222222222'
     union all
     select 1 from public.project_activity  where project_id <> 'proj_22222222-2222-4222-8222-222222222222' $$,
  'outsider: reads no member, comment, review, step owner or ledger entry of the team project');

-- An instance administrator is not a member of anything by virtue of the role.
select tests.login_as('cf-admin@example.test');
select ok(private.is_admin(), 'instance admin: is an admin');
select is_empty(
  $$ select 1 from public.projects
     union all select 1 from public.project_members
     union all select 1 from public.project_comments
     union all select 1 from public.project_reviews
     union all select 1 from public.step_ownership
     union all select 1 from public.project_activity $$,
  'instance admin: reads no project data at all without being a member');

-- Members who are not allowed in right now.
select tests.login_as('cf-suspended@example.test');
select is_empty($$ select private.my_project_ids() $$, 'suspended member: my_project_ids is empty');
select is_empty(
  $$ select 1 from public.projects
     union all select 1 from public.project_members
     union all select 1 from public.project_comments
     union all select 1 from public.project_reviews
     union all select 1 from public.step_ownership
     union all select 1 from public.project_activity $$,
  'suspended member: reads no project data');

select tests.login_as('cf-invited@example.test');
select is_empty(
  $$ select 1 from public.projects
     union all select 1 from public.project_members
     union all select 1 from public.project_comments
     union all select 1 from public.project_reviews
     union all select 1 from public.step_ownership
     union all select 1 from public.project_activity $$,
  'member who has not set a password yet: reads no project data');

select tests.login_as('cf-editor@example.test');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('cf-editor@example.test');
select tests.resume_as('cf-editor@example.test');
select is_empty(
  $$ select 1 from public.projects
     union all select 1 from public.project_members
     union all select 1 from public.project_comments
     union all select 1 from public.project_reviews
     union all select 1 from public.step_ownership
     union all select 1 from public.project_activity $$,
  'member whose session was revoked: the old token reads no project data');

-- Removed from the project: the next read is already empty.
select tests.login_as('cf-viewer@example.test');
select tests.logout();
delete from public.project_members
 where project_id = 'proj_11111111-1111-4111-8111-111111111111' and user_id = tests.user_id('cf-viewer@example.test');
select tests.resume_as('cf-viewer@example.test');
select is_empty(
  $$ select 1 from public.projects union all select 1 from public.project_comments $$,
  'removed member: loses access at once, on the same token');

select tests.logout();
revoke select on public.profiles, public.projects, public.project_members, public.project_comments,
  public.project_reviews, public.step_ownership, public.project_activity from authenticated;

-- ===========================================================================
-- Invitation policies (defence in depth)
-- ===========================================================================
-- Clients have no SELECT on project_invitations; they use the RPCs. The grant
-- below exists only inside this transaction, to prove what the two policies
-- would allow if the table were ever opened. The owner policy reads
-- project_members through that table's own policy, so that one is opened too.

delete from public.project_invitations;
insert into public.project_invitations (project_id, email, role, invited_by, status, expires_at) values
  ('proj_11111111-1111-4111-8111-111111111111', 'cf-invitee@example.test',     'editor', tests.user_id('cf-owner@example.test'),    'pending',   now() + interval '30 days'),
  ('proj_33333333-3333-4333-8333-333333333333', 'cf-invitee@example.test',     'viewer', tests.user_id('cf-owner@example.test'),    'pending',   now() - interval '1 minute'),
  ('proj_22222222-2222-4222-8222-222222222222', 'cf-invitee@example.test',     'viewer', tests.user_id('cf-outsider@example.test'), 'declined',  now() + interval '30 days'),
  ('proj_11111111-1111-4111-8111-111111111111', 'cf-unconfirmed@example.test', 'viewer', tests.user_id('cf-owner@example.test'),    'pending',   now() + interval '30 days'),
  ('proj_11111111-1111-4111-8111-111111111111', 'cf-suspended@example.test',   'viewer', tests.user_id('cf-owner@example.test'),    'pending',   now() + interval '30 days'),
  ('proj_11111111-1111-4111-8111-111111111111', 'cf-stranger@example.test',    'viewer', tests.user_id('cf-owner@example.test'),    'cancelled', now() + interval '30 days'),
  ('proj_22222222-2222-4222-8222-222222222222', 'cf-editor@example.test',      'viewer', tests.user_id('cf-outsider@example.test'), 'pending',   now() + interval '30 days');

grant select on public.project_invitations, public.project_members to authenticated;

select tests.login_as('cf-invitee@example.test');
select results_eq(
  $$ select project_id, role, status from public.project_invitations $$,
  $$ values ('proj_11111111-1111-4111-8111-111111111111', 'editor', 'pending') $$,
  'invitee policy: only their own pending, unexpired invitation (not the expired one, not the declined one, not other people''s)');

select tests.login_as('cf-unconfirmed@example.test');
select is_empty($$ select 1 from public.project_invitations $$,
  'invitee policy: an unconfirmed address reads nothing, so signing up with someone else''s email shows nothing');

select tests.login_as('cf-suspended@example.test');
select is_empty($$ select 1 from public.project_invitations $$,
  'invitee policy: a suspended invitee reads nothing');

select tests.login_as('cf-invitee@example.test');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('cf-invitee@example.test');
select tests.resume_as('cf-invitee@example.test');
select is_empty($$ select 1 from public.project_invitations $$,
  'invitee policy: a revoked token reads nothing');

select tests.login_as('cf-owner@example.test');
select results_eq(
  $$ select email, status from public.project_invitations order by email, status $$,
  $$ values ('cf-invitee@example.test', 'pending'), ('cf-invitee@example.test', 'pending'),
            ('cf-stranger@example.test', 'cancelled'), ('cf-suspended@example.test', 'pending'),
            ('cf-unconfirmed@example.test', 'pending') $$,
  'owner policy: every invitation of the projects they own, and none of anyone else''s');

select tests.login_as('cf-editor@example.test');
select results_eq(
  $$ select project_id from public.project_invitations $$,
  $$ values ('proj_22222222-2222-4222-8222-222222222222') $$,
  'owner policy: an editor sees no invitation of the team project, only the one addressed to them');

select tests.login_as('cf-outsider@example.test');
select results_eq(
  $$ select email, status from public.project_invitations order by email $$,
  $$ values ('cf-editor@example.test', 'pending'), ('cf-invitee@example.test', 'declined') $$,
  'owner policy: this is the leak the missing grant prevents, an owner reading a declined status');

select tests.logout();
update public.profiles set status = 'suspended' where id = tests.user_id('cf-outsider@example.test');
select tests.login_as('cf-outsider@example.test');
select is_empty($$ select 1 from public.project_invitations $$,
  'owner policy: a suspended owner reads nothing');

select tests.logout();
revoke select on public.project_invitations, public.project_members from authenticated;

-- ===========================================================================
-- Deleting a project takes everything with it
-- ===========================================================================

delete from public.projects where id = 'proj_11111111-1111-4111-8111-111111111111';
select is_empty(
  $$ select 1 from public.project_members     where project_id = 'proj_11111111-1111-4111-8111-111111111111'
     union all
     select 1 from public.project_invitations where project_id = 'proj_11111111-1111-4111-8111-111111111111'
     union all
     select 1 from public.project_comments    where project_id = 'proj_11111111-1111-4111-8111-111111111111'
     union all
     select 1 from public.project_reviews     where project_id = 'proj_11111111-1111-4111-8111-111111111111'
     union all
     select 1 from public.step_ownership      where project_id = 'proj_11111111-1111-4111-8111-111111111111'
     union all
     select 1 from public.project_activity    where project_id = 'proj_11111111-1111-4111-8111-111111111111' $$,
  'deleting a project removes its members, invitations, comments, reviews, step owners and ledger');

-- Deleting a person keeps what they wrote, without the link to them.
delete from auth.users where id = tests.user_id('cf-outsider@example.test');
select results_eq(
  $$ select owner_id from public.projects where id = 'proj_22222222-2222-4222-8222-222222222222' $$,
  $$ values (null::uuid) $$,
  'deleting a person keeps the projects they created');
select results_eq(
  $$ select author_id, author_name from public.project_comments
      where project_id = 'proj_22222222-2222-4222-8222-222222222222' $$,
  $$ values (null::uuid, 'Deleted user') $$,
  'deleting a person keeps their comments; a name that was their address does not outlive them (051)');

select * from finish();
rollback;
