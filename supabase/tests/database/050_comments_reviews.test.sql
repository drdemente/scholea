-- Comments and supervisor sign-offs.
--
-- Legacy parity (old server, projects.test.ts): comments written by one member
-- are seen by the others; a viewer and an editor cannot sign off, a supervisor
-- can; non-members get 404; the ledger shows who did what.
--
-- New here: a comment can carry a client-chosen id, which makes an upload safe
-- to repeat; set_project_review returns the review; both writes move
-- projects.collab_updated_at, which is how other devices learn there is
-- something new to fetch.

begin;
select plan(104);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('cr-owner@example.test');
-- The instance role "supervisor" on purpose: it must grant nothing on a project.
select tests.create_user('cr-editor@example.test', 'supervisor');
select tests.create_user('cr-supervisor@example.test');
select tests.create_user('cr-viewer@example.test');
select tests.create_user('cr-outsider@example.test');
select tests.create_user('cr-suspended@example.test');
select tests.create_user('cr-invited@example.test', 'researcher', false);
select tests.create_user('cr-revoked@example.test');

update public.profiles set name = 'Olive Owner' where email = 'cr-owner@example.test';

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;
-- The collab stamp of a project, as a client sees it.
create function pg_temp.stamp(p_project text) returns bigint language sql as $$
  select (p ->> 'collab_updated_at')::bigint
    from jsonb_array_elements(public.list_my_projects() -> 'projects') p
   where p ->> 'id' = p_project;
$$;
grant execute on function pg_temp.keys(jsonb), pg_temp.stamp(text) to authenticated;

create temp table seen (k text primary key, v bigint, j jsonb);
grant select, insert on seen to authenticated;

-- P1 the team project, P2 the outsider's (the editor is a member there too).
select tests.login_as('cr-owner@example.test');
select lives_ok(
  $$ select public.create_project('proj_50000000-0000-4000-8000-000000000001', 'Shared SR', 'systematic-review') $$,
  '(scene) the owner creates the team project');
select tests.login_as('cr-outsider@example.test');
select lives_ok(
  $$ select public.create_project('proj_50000000-0000-4000-8000-000000000002', 'Private project', 'cohort') $$,
  '(scene) the outsider creates their own project');
select tests.logout();

insert into public.project_members (project_id, user_id, role) values
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-editor@example.test'),     'editor'),
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-supervisor@example.test'), 'supervisor'),
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-viewer@example.test'),     'viewer'),
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-suspended@example.test'),  'owner'),
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-invited@example.test'),    'owner'),
  ('proj_50000000-0000-4000-8000-000000000001', tests.user_id('cr-revoked@example.test'),    'owner'),
  ('proj_50000000-0000-4000-8000-000000000002', tests.user_id('cr-editor@example.test'),     'editor');
update public.profiles set status = 'suspended' where email = 'cr-suspended@example.test';

select has_function('public', 'add_project_comment', array['text', 'text', 'text', 'uuid'],
  'add_project_comment(project, step, text, id) exists');
select has_function('public', 'set_project_review', array['text', 'text', 'text', 'text'],
  'set_project_review(project, step, status, note) exists');
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('add_project_comment', 'set_project_review')), 2,
  'neither has a variant that takes an author, a reviewer or a name: both always write as the caller');

-- ===========================================================================
-- Comments
-- ===========================================================================

select tests.login_as('cr-editor@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001'), null,
  'collab stamp: null while the project has no comment and no review');
select is(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001'), '{"comments":[]}'::jsonb,
  'list_project_comments: an empty list for a member of a project with no comments');

insert into seen (k, j)
select 'first', public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'Tighten the PICO.');

select is(pg_temp.keys((select j from seen where k = 'first')), 'comment',
  'add_project_comment: returns {comment}');
select is(pg_temp.keys((select j -> 'comment' from seen where k = 'first')),
  'author_id,author_name,created_at,id,project_id,step_id,text',
  'add_project_comment: the comment has exactly the seven documented keys');
select is(
  (select (j -> 'comment') - 'id' - 'created_at' from seen where k = 'first'),
  jsonb_build_object(
    'project_id', 'proj_50000000-0000-4000-8000-000000000001', 'step_id', 'question',
    'author_id', tests.user_id('cr-editor@example.test'), 'author_name', 'cr-editor',
    'text', 'Tighten the PICO.'),
  'add_project_comment: author is the caller, named by the start of their address when they have no name (never the whole address)');
select matches((select j -> 'comment' ->> 'id' from seen where k = 'first'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'add_project_comment: without p_id the server picks a uuid');
select is((select jsonb_typeof(j -> 'comment' -> 'created_at') from seen where k = 'first'), 'number',
  'add_project_comment: created_at is epoch milliseconds');

insert into seen (k, v) select 'stamp 1', pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001');
select isnt((select v from seen where k = 'stamp 1'), null, 'collab stamp: set by the first comment');

-- Seen by the others (projects.test.ts "syncs comments across members").
select tests.login_as('cr-owner@example.test');
select is(
  public.list_project_comments('proj_50000000-0000-4000-8000-000000000001', 'question'),
  jsonb_build_object('comments', jsonb_build_array((select j -> 'comment' from seen where k = 'first'))),
  'list_project_comments: another member sees the comment, in the same shape add_project_comment returned');

-- Every role may comment.
select is(
  public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'Agreed.') -> 'comment' ->> 'author_name',
  'Olive Owner', 'add_project_comment: the owner comments, named by their profile name');
select tests.login_as('cr-viewer@example.test');
select is(
  public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'protocol', 'A viewer may comment.') -> 'comment' ->> 'step_id',
  'protocol', 'add_project_comment: a viewer can comment');
select tests.login_as('cr-supervisor@example.test');
select lives_ok(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'protocol', 'So may a supervisor.') $$,
  'add_project_comment: a supervisor can comment');

select results_eq(
  $$ select c ->> 'step_id', c ->> 'text'
       from jsonb_array_elements(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') -> 'comments')
            with ordinality as t (c, n)
      order by n $$,
  $$ values ('question', 'Tighten the PICO.'), ('question', 'Agreed.'),
            ('protocol', 'A viewer may comment.'), ('protocol', 'So may a supervisor.') $$,
  'list_project_comments: without a step, every comment of the project, oldest first');
select results_eq(
  $$ select c ->> 'text'
       from jsonb_array_elements(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001', 'protocol') -> 'comments')
            with ordinality as t (c, n)
      order by n $$,
  $$ values ('A viewer may comment.'), ('So may a supervisor.') $$,
  'list_project_comments: with a step, only that step''s comments');
select is(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001', 'analysis'), '{"comments":[]}'::jsonb,
  'list_project_comments: a step nobody commented on is an empty list');

-- Not a member (projects.test.ts "hides projects from non-members").
select tests.login_as('cr-outsider@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 's1', 'hi') $$, 'not_found', 404,
  'add_project_comment: a non-member gets not_found');
select tests.throws_code(
  $$ select public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'list_project_comments: a non-member gets not_found, not an empty list');
select tests.throws_code(
  $$ select public.add_project_comment('proj_99999999-9999-4999-8999-999999999999', 's1', 'hi') $$, 'not_found', 404,
  'add_project_comment: exactly what a project that does not exist gives');

-- Input.
select tests.login_as('cr-editor@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', '') $$, 'invalid_input', 400,
  'add_project_comment: an empty comment is refused');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', null) $$, 'invalid_input', 400,
  'add_project_comment: a missing text is refused');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', repeat('c', 5001)) $$,
  'invalid_input', 400, 'add_project_comment: more than 5000 characters is refused');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', '', 'x') $$, 'invalid_input', 400,
  'add_project_comment: an empty step id is refused');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', null, 'x') $$, 'invalid_input', 400,
  'add_project_comment: a missing step id is refused');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', repeat('s', 201), 'x') $$,
  'invalid_input', 400, 'add_project_comment: a step id over 200 characters is refused');
select is(
  char_length(public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', repeat('s', 200), repeat('€', 5000))
              -> 'comment' ->> 'text'), 5000,
  'add_project_comment: 5000 characters (not bytes) and a 200 character step id are accepted');
select is(
  jsonb_array_length(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') -> 'comments'), 5,
  'add_project_comment: none of the refused comments was stored');

-- ---------------------------------------------------------------------------
-- A client-chosen id makes an upload safe to repeat
-- ---------------------------------------------------------------------------

insert into seen (k, j)
select 'chosen', public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'Sent once.',
                                            '5c000000-0000-4000-8000-000000000001');
select is((select j -> 'comment' ->> 'id' from seen where k = 'chosen'), '5c000000-0000-4000-8000-000000000001',
  'p_id: the id the client chose becomes the comment id');

insert into seen (k, v) select 'stamp before retry', pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001');
insert into seen (k, v)
select 'ledger before retry', count(*)
  from jsonb_array_elements(public.get_project_activity('proj_50000000-0000-4000-8000-000000000001') -> 'entries');

select is(
  public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'Sent once.',
                             '5c000000-0000-4000-8000-000000000001'),
  (select j from seen where k = 'chosen'),
  'p_id: uploading the same comment again returns the stored comment, identical to the first answer');
select is(
  public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'protocol', 'Different words, same id.',
                             '5c000000-0000-4000-8000-000000000001'),
  (select j from seen where k = 'chosen'),
  'p_id: the stored comment is returned unchanged even when the retry carries other text');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') -> 'comments') c
    where c ->> 'id' = '5c000000-0000-4000-8000-000000000001'), 1,
  'p_id: there is still one comment with that id');
select is(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001'), (select v from seen where k = 'stamp before retry'),
  'p_id: a repeated upload does not move the collab stamp');
select is(
  (select count(*) from jsonb_array_elements(public.get_project_activity('proj_50000000-0000-4000-8000-000000000001') -> 'entries')),
  (select v from seen where k = 'ledger before retry'),
  'p_id: a repeated upload adds no ledger entry');

-- The id belongs to that comment: nobody else can take it, nowhere.
select tests.login_as('cr-owner@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'Sent once.',
                                       '5c000000-0000-4000-8000-000000000001') $$,
  'conflict', 409, 'p_id: another member using the same id is a conflict, even with the same text');
select tests.login_as('cr-editor@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000002', 'question', 'Sent once.',
                                       '5c000000-0000-4000-8000-000000000001') $$,
  'conflict', 409, 'p_id: the same author using the same id in another project is a conflict');
select tests.login_as('cr-outsider@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000002', 'question', 'Mine.',
                                       '5c000000-0000-4000-8000-000000000001') $$,
  'conflict', 409, 'p_id: a stranger using the id in their own project is a conflict, and learns nothing else');
select is(public.list_project_comments('proj_50000000-0000-4000-8000-000000000002'), '{"comments":[]}'::jsonb,
  'p_id: none of the conflicting uploads was stored');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'question', 'hi',
                                       '5c000000-0000-4000-8000-000000000001') $$,
  'not_found', 404, 'p_id: a non-member gets not_found before the id is even looked at');

-- ---------------------------------------------------------------------------
-- The collab stamp
-- ---------------------------------------------------------------------------

select tests.login_as('cr-owner@example.test');
select cmp_ok((select v from seen where k = 'stamp before retry'), '>', (select v from seen where k = 'stamp 1'),
  'collab stamp: later comments moved it forward');
select is(jsonb_typeof(public.list_my_projects() -> 'projects' -> 0 -> 'collab_updated_at'), 'number',
  'collab stamp: list_my_projects carries it as epoch milliseconds');
select is(
  public.get_project('proj_50000000-0000-4000-8000-000000000001') -> 'project' -> 'collab_updated_at',
  to_jsonb(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001')),
  'collab stamp: get_project carries the same value');
select tests.login_as('cr-outsider@example.test');
select is(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000002'), null,
  'collab stamp: a project without comments is not touched by comments elsewhere');

-- ===========================================================================
-- Reviews
-- ===========================================================================

select tests.login_as('cr-viewer@example.test');
select is(public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001'), '{"reviews":[]}'::jsonb,
  'list_project_reviews: an empty list before the first sign-off');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'approved') $$, 'forbidden', 403,
  'set_project_review: a viewer cannot sign off (projects.test.ts 4)');

select tests.login_as('cr-editor@example.test');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'approved') $$, 'forbidden', 403,
  'set_project_review: an editor cannot sign off, whatever their instance role is');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'nonsense') $$, 'forbidden', 403,
  'set_project_review: the role is checked before the input');

select tests.login_as('cr-outsider@example.test');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'approved') $$, 'not_found', 404,
  'set_project_review: a non-member gets not_found');
select tests.throws_code(
  $$ select public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'list_project_reviews: a non-member gets not_found, not an empty list');

select tests.login_as('cr-supervisor@example.test');
insert into seen (k, v) select 'stamp before review', pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001');
insert into seen (k, j)
select 'review 1', public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'changes', 'Fix the search dates.');

select is(pg_temp.keys((select j from seen where k = 'review 1')), 'review', 'set_project_review: returns {review}');
select is(
  (select (j -> 'review') - 'created_at' from seen where k = 'review 1'),
  jsonb_build_object(
    'id', 'proj_50000000-0000-4000-8000-000000000001:s1',
    'project_id', 'proj_50000000-0000-4000-8000-000000000001', 'step_id', 's1', 'status', 'changes',
    'reviewer_id', tests.user_id('cr-supervisor@example.test'), 'reviewer_name', 'cr-supervisor',
    'note', 'Fix the search dates.'),
  'set_project_review: a supervisor signs off; the review has the eight documented keys and id = project:step');
select is((select jsonb_typeof(j -> 'review' -> 'created_at') from seen where k = 'review 1'), 'number',
  'set_project_review: created_at is epoch milliseconds');
select cmp_ok(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001'), '>', (select v from seen where k = 'stamp before review'),
  'collab stamp: a review moves it');

select tests.login_as('cr-viewer@example.test');
select is(
  public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001'),
  jsonb_build_object('reviews', jsonb_build_array((select j -> 'review' from seen where k = 'review 1'))),
  'list_project_reviews: any member sees the review, in the same shape set_project_review returned');

-- One sign-off per step: the next one replaces it.
select tests.login_as('cr-owner@example.test');
insert into seen (k, v) select 'stamp before review 2', pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001');
insert into seen (k, j)
select 'review 2', public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'approved');
select is(
  (select (j -> 'review') - 'created_at' from seen where k = 'review 2'),
  jsonb_build_object(
    'id', 'proj_50000000-0000-4000-8000-000000000001:s1',
    'project_id', 'proj_50000000-0000-4000-8000-000000000001', 'step_id', 's1', 'status', 'approved',
    'reviewer_id', tests.user_id('cr-owner@example.test'), 'reviewer_name', 'Olive Owner', 'note', null),
  'set_project_review: the owner can sign off too; a later sign-off replaces status, reviewer and note');
select is(jsonb_array_length(public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') -> 'reviews'), 1,
  'set_project_review: the step still has exactly one sign-off');
select cmp_ok(
  (select (j -> 'review' ->> 'created_at')::bigint from seen where k = 'review 2'), '>=',
  (select (j -> 'review' ->> 'created_at')::bigint from seen where k = 'review 1'),
  'set_project_review: the replacement carries a new time, never an older one');
select cmp_ok(pg_temp.stamp('proj_50000000-0000-4000-8000-000000000001'), '>', (select v from seen where k = 'stamp before review 2'),
  'collab stamp: replacing a review moves it too');

select is(
  public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's2', 'approved', '') -> 'review' -> 'note',
  'null'::jsonb, 'set_project_review: an empty note is stored as no note');
select is(
  char_length(public.set_project_review('proj_50000000-0000-4000-8000-000000000001', repeat('s', 200), 'changes', repeat('n', 2000))
              -> 'review' ->> 'note'), 2000,
  'set_project_review: a 2000 character note and a 200 character step id are accepted');
select results_eq(
  $$ select r ->> 'step_id' = any (array['s1', 's2', repeat('s', 200)]), r ->> 'status'
       from jsonb_array_elements(public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') -> 'reviews')
            with ordinality as t (r, n)
      order by n $$,
  $$ values (true, 'approved'), (true, 'approved'), (true, 'changes') $$,
  'list_project_reviews: one review per step, ordered by step id');

select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's3', 'rejected') $$, 'invalid_input', 400,
  'set_project_review: a status other than approved or changes is refused');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's3', null) $$, 'invalid_input', 400,
  'set_project_review: a missing status is refused');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's3', 'approved', repeat('n', 2001)) $$,
  'invalid_input', 400, 'set_project_review: a note over 2000 characters is refused');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', '', 'approved') $$, 'invalid_input', 400,
  'set_project_review: an empty step id is refused');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', repeat('s', 201), 'approved') $$,
  'invalid_input', 400, 'set_project_review: a step id over 200 characters is refused');
select is(jsonb_array_length(public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') -> 'reviews'), 3,
  'set_project_review: none of the refused sign-offs was stored');

-- ===========================================================================
-- The ledger (projects.test.ts "merges a who-did-what contribution ledger")
-- ===========================================================================

select tests.login_as('cr-viewer@example.test');
select results_eq(
  $$ select e ->> 'actor_name', e ->> 'action', e ->> 'detail'
       from jsonb_array_elements(public.get_project_activity('proj_50000000-0000-4000-8000-000000000001') -> 'entries')
            with ordinality as t (e, n)
      where e ->> 'detail' is distinct from repeat('s', 200)
      order by n desc $$,
  $$ values ('Olive Owner',                'project.create',         'Shared SR'),
            ('cr-editor',                  'comment.add',            'question'),
            ('Olive Owner',                'comment.add',            'question'),
            ('cr-viewer',                  'comment.add',            'protocol'),
            ('cr-supervisor',              'comment.add',            'protocol'),
            ('cr-editor',                  'comment.add',            'question'),
            ('cr-supervisor',              'review.request_changes', 's1'),
            ('Olive Owner',                'review.approve',         's1'),
            ('Olive Owner',                'review.approve',         's2') $$,
  'ledger: every comment and sign-off is one entry, with the step as detail and the actor''s name at the time');
select set_eq(
  $$ select c ->> 'actor'
       from jsonb_array_elements(public.get_project_activity('proj_50000000-0000-4000-8000-000000000001') -> 'contributors') c $$,
  $$ values ('Olive Owner'), ('cr-editor'), ('cr-supervisor'), ('cr-viewer') $$,
  'ledger: the contributors are everyone who did something');
select is(
  public.get_project_activity('proj_50000000-0000-4000-8000-000000000001') -> 'contributors' -> 0 ->> 'actor', 'Olive Owner',
  'ledger: busiest first');

-- ===========================================================================
-- A member who is removed
-- ===========================================================================

select tests.login_as('cr-owner@example.test');
select lives_ok(
  format('select public.remove_project_member(%L, %L)', 'proj_50000000-0000-4000-8000-000000000001',
         tests.user_id('cr-viewer@example.test')),
  '(scene) the owner removes the viewer');
select tests.login_as('cr-viewer@example.test');
select tests.throws_code(
  $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'protocol', 'Still here?') $$,
  'not_found', 404, 'removed member: cannot comment any more');
select tests.throws_code(
  $$ select public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') $$,
  'not_found', 404, 'removed member: cannot read the comments any more');
select tests.throws_code(
  $$ select public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') $$,
  'not_found', 404, 'removed member: cannot read the reviews any more');
select tests.login_as('cr-owner@example.test');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.list_project_comments('proj_50000000-0000-4000-8000-000000000001', 'protocol') -> 'comments') c
    where c ->> 'author_name' = 'cr-viewer'), 1,
  'removed member: what they wrote stays, under their name');

-- A supervisor who is demoted can no longer sign off.
select lives_ok(
  format('select public.set_project_member_role(%L, %L, %L)', 'proj_50000000-0000-4000-8000-000000000001',
         tests.user_id('cr-supervisor@example.test'), 'editor'),
  '(scene) the owner makes the supervisor an editor');
select tests.login_as('cr-supervisor@example.test');
select tests.throws_code(
  $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 's1', 'changes') $$, 'forbidden', 403,
  'demoted supervisor: the next sign-off is refused');

-- ===========================================================================
-- Nobody writes these tables directly
-- ===========================================================================

select tests.login_as('cr-owner@example.test');
select throws_ok(
  $$ insert into public.project_comments (project_id, step_id, author_id, author_name, body)
     values ('proj_50000000-0000-4000-8000-000000000001', 'question', auth.uid(), 'The Dean', 'Forged') $$,
  '42501', null, 'a member cannot insert a comment under a name of their choosing');
select throws_ok(
  $$ update public.project_comments set body = 'Edited' where project_id = 'proj_50000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'a member cannot edit a comment, their own or anyone''s');
select throws_ok(
  $$ delete from public.project_comments where project_id = 'proj_50000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'a member cannot delete a comment');
select throws_ok(
  $$ update public.project_reviews set reviewer_name = 'The Dean' where project_id = 'proj_50000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'not even the owner can rewrite who signed a step off');
select throws_ok(
  $$ update public.projects set collab_updated_at = null where id = 'proj_50000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'a member cannot reset the collab stamp');

-- ===========================================================================
-- Who is refused
-- ===========================================================================
-- The three accounts are owners of the team project, so every refusal is about
-- the caller's account and not about their project role.

select tests.logout();
create temp table rpc_calls (n integer generated always as identity primary key, name text, sql text);
grant select on rpc_calls to authenticated, anon;
insert into rpc_calls (name, sql) values
  ('list_project_comments', $$ select public.list_project_comments('proj_50000000-0000-4000-8000-000000000001') $$),
  ('add_project_comment',   $$ select public.add_project_comment('proj_50000000-0000-4000-8000-000000000001', 'refused', 'Refused') $$),
  ('list_project_reviews',  $$ select public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') $$),
  ('set_project_review',    $$ select public.set_project_review('proj_50000000-0000-4000-8000-000000000001', 'refused', 'approved') $$);

select tests.login_as('cr-suspended@example.test');
select tests.throws_code(c.sql, 'account_suspended', 403, c.name || ': refused for a suspended account')
  from rpc_calls c order by c.n;

select tests.login_as('cr-invited@example.test');
select tests.throws_code(c.sql, 'password_reset_required', 403, c.name || ': refused until the invited person sets a password')
  from rpc_calls c order by c.n;

select tests.login_as('cr-revoked@example.test');
select is(
  jsonb_array_length(public.list_project_reviews('proj_50000000-0000-4000-8000-000000000001') -> 'reviews'), 3,
  'revoked: (scene) the account works while its session exists');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('cr-revoked@example.test');
select tests.resume_as('cr-revoked@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(c.sql, '42501', null, c.name || ': not callable without an account')
  from rpc_calls c order by c.n;

select tests.logout();
select is_empty(
  $$ select 1 from public.project_comments where step_id = 'refused'
     union all
     select 1 from public.project_reviews where step_id = 'refused' $$,
  'none of the refused calls wrote anything');

select * from finish();
rollback;
