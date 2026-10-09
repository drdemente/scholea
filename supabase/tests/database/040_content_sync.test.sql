-- Content sync: get_project_content() and put_project_content().
--
-- Legacy parity (old server, sync.test.ts): content round-trips and bumps rev;
-- a stale write is refused and gets the server copy back; a newer write wins.
--
-- New here: the refusal is returned as data ({ok: false, ...}), the document is
-- stored as the exact text that was sent, text with \u0000 or half a surrogate
-- pair is accepted (PDF extraction produces both), and the 20 MB limit.

begin;
select plan(99);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('cs-owner@example.test');
select tests.create_user('cs-editor@example.test');
select tests.create_user('cs-supervisor@example.test');
select tests.create_user('cs-viewer@example.test');
select tests.create_user('cs-outsider@example.test');
select tests.create_user('cs-suspended@example.test');
select tests.create_user('cs-invited@example.test', 'researcher', false);
select tests.create_user('cs-revoked@example.test');

update public.profiles set name = 'Olive Owner' where email = 'cs-owner@example.test';

-- P1 the team project, P2 for the odd documents, P3 for the size limit.
insert into public.projects (id, title, study_type, owner_id)
select 'proj_40000000-0000-4000-8000-00000000000' || n, 'Sync project ' || n, 'systematic-review',
       tests.user_id('cs-owner@example.test')
  from generate_series(1, 3) n;

insert into public.project_members (project_id, user_id, role)
select 'proj_40000000-0000-4000-8000-00000000000' || n, tests.user_id('cs-owner@example.test'), 'owner'
  from generate_series(1, 3) n;

insert into public.project_members (project_id, user_id, role) values
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-editor@example.test'),     'editor'),
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-supervisor@example.test'), 'supervisor'),
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-viewer@example.test'),     'viewer'),
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-suspended@example.test'),  'owner'),
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-invited@example.test'),    'owner'),
  ('proj_40000000-0000-4000-8000-000000000001', tests.user_id('cs-revoked@example.test'),    'owner');

update public.profiles set status = 'suspended' where email = 'cs-suspended@example.test';

-- A small valid document that says which push it came from.
create function pg_temp.doc(p_marker text) returns text language sql as $$
  select '{"stepData":{"s":"' || p_marker || '"},"stepStatus":{}}';
$$;
-- Push to a project and get the answer.
create function pg_temp.push(p_n integer, p_content text, p_base integer, p_at bigint, p_title text default null)
returns jsonb language sql as $$
  select public.put_project_content('proj_40000000-0000-4000-8000-00000000000' || p_n, p_content, p_base, p_at, p_title);
$$;
create function pg_temp.pull(p_n integer) returns jsonb language sql as $$
  select public.get_project_content('proj_40000000-0000-4000-8000-00000000000' || p_n);
$$;
grant execute on function pg_temp.doc(text), pg_temp.push(integer, text, integer, bigint, text), pg_temp.pull(integer)
  to authenticated, anon;

-- ===========================================================================
-- Round trip (sync.test.ts "round-trips content and bumps rev")
-- ===========================================================================

select tests.login_as('cs-owner@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(pg_temp.pull(1), '{"content":null,"rev":0,"updatedAt":null}'::jsonb,
  'get_project_content: before the first push there is no content, rev is 0 and updatedAt is null');

select is(
  pg_temp.push(1, '{"stepData":{"question":{"picoP":"adults"}},"stepStatus":{"question":{"complete":true,"needsAttention":false}}}',
               0, 1000, 'Sync project'),
  '{"ok":true,"rev":1}'::jsonb,
  'put_project_content: the first push is accepted and answers {ok: true, rev: 1}');

select is(
  pg_temp.pull(1),
  jsonb_build_object(
    'content', '{"stepData":{"question":{"picoP":"adults"}},"stepStatus":{"question":{"complete":true,"needsAttention":false}}}',
    'rev', 1, 'updatedAt', 1000),
  'get_project_content: returns {content, rev, updatedAt}; content is the pushed document as a string');
select is(jsonb_typeof(pg_temp.pull(1) -> 'content'), 'string',
  'get_project_content: content is a JSON string for the client to parse, not an object');
select is((pg_temp.pull(1) ->> 'content')::jsonb -> 'stepData' -> 'question' ->> 'picoP', 'adults',
  'get_project_content: parsing it gives back what was pushed');

select tests.as_owner();   -- a client cannot read a table: look at the stored row as the owner
select results_eq(
  $$ select title, rev, content_updated_at from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001' $$,
  $$ values ('Sync project', 1, 1000::bigint) $$,
  'put_project_content: the title sent with the push renames the project');
select tests.as_client();
select is(
  public.list_my_projects() -> 'projects' @> '[{"id":"proj_40000000-0000-4000-8000-000000000001","rev":1,"content_updated_at":1000}]'::jsonb,
  true,
  'list_my_projects: shows the new rev and content time, which is how other devices learn there is something to pull');

-- ===========================================================================
-- Stale write (sync.test.ts "rejects a stale write ... returns the server copy")
-- ===========================================================================

select is(
  pg_temp.push(1, pg_temp.doc('stale'), 0, 500),
  jsonb_build_object(
    'ok', false, 'error', 'conflict',
    'content', '{"stepData":{"question":{"picoP":"adults"}},"stepStatus":{"question":{"complete":true,"needsAttention":false}}}',
    'rev', 1, 'updatedAt', 1000),
  'stale write: an older base rev AND an older timestamp is refused, and the answer carries the server copy');
select is(pg_temp.pull(1) -> 'rev', '1'::jsonb, 'stale write: rev did not move');
select is((pg_temp.pull(1) ->> 'content')::jsonb -> 'stepData' -> 'question' ->> 'picoP', 'adults',
  'stale write: the server copy is unchanged');
select is(
  pg_temp.push(1, pg_temp.doc('stale'), 0, 999, 'Stale title') ->> 'error', 'conflict',
  'stale write: one millisecond older is still stale');
select tests.as_owner();
select is((select title from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001'), 'Sync project',
  'stale write: a refused push does not rename the project either');
select tests.as_client();

-- ===========================================================================
-- Last writer wins (sync.test.ts "last-writer-wins when the incoming copy is newer")
-- ===========================================================================

select is(pg_temp.push(1, pg_temp.doc('newer'), 0, 2000), '{"ok":true,"rev":2}'::jsonb,
  'last writer wins: a stale base rev with a NEWER timestamp is accepted, rev 2');
select is((pg_temp.pull(1) ->> 'content')::jsonb -> 'stepData' ->> 's', 'newer',
  'last writer wins: the newer copy replaced the server copy');
select tests.as_owner();
select is((select title from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001'), 'Sync project',
  'put_project_content: a push without a title keeps the title');
select tests.as_client();

select is(pg_temp.push(1, pg_temp.doc('same time'), 0, 2000), '{"ok":true,"rev":3}'::jsonb,
  'last writer wins: an equal timestamp is not "server newer", so the push is accepted');
select is(pg_temp.push(1, pg_temp.doc('current base, old clock'), 3, 5), '{"ok":true,"rev":4}'::jsonb,
  'a push based on the current rev is accepted whatever its timestamp (a conflict needs both conditions)');
select is(pg_temp.push(1, pg_temp.doc('base ahead'), 99, 1), '{"ok":true,"rev":5}'::jsonb,
  'a base rev ahead of the server is accepted too; rev still goes up by exactly one');
select is(pg_temp.pull(1) -> 'updatedAt', '1'::jsonb,
  'updatedAt is whatever the last accepted push said, it is the client''s clock');

-- ===========================================================================
-- Roles
-- ===========================================================================

select tests.login_as('cs-editor@example.test');
select is(pg_temp.push(1, pg_temp.doc('editor'), 5, 3000), '{"ok":true,"rev":6}'::jsonb,
  'roles: an editor can push');

select tests.login_as('cs-viewer@example.test');
select tests.throws_code($$ select pg_temp.push(1, pg_temp.doc('viewer'), 6, 4000) $$, 'forbidden', 403,
  'roles: a viewer cannot push');
select is((pg_temp.pull(1) ->> 'content')::jsonb -> 'stepData' ->> 's', 'editor',
  'roles: a viewer can pull');

select tests.login_as('cs-supervisor@example.test');
select tests.throws_code($$ select pg_temp.push(1, pg_temp.doc('supervisor'), 6, 4000) $$, 'forbidden', 403,
  'roles: a supervisor cannot push');
select tests.throws_code($$ select pg_temp.push(1, 'not json', 6, 4000) $$, 'forbidden', 403,
  'roles: the role is checked before the document');
select is(pg_temp.pull(1) -> 'rev', '6'::jsonb, 'roles: a supervisor can pull');

select tests.login_as('cs-outsider@example.test');
select tests.throws_code($$ select pg_temp.push(1, pg_temp.doc('outsider'), 6, 4000) $$, 'not_found', 404,
  'roles: a non-member pushing gets not_found');
select tests.throws_code($$ select pg_temp.pull(1) $$, 'not_found', 404,
  'roles: a non-member pulling gets not_found');
select tests.throws_code(
  $$ select public.put_project_content('proj_99999999-9999-4999-8999-999999999999', pg_temp.doc('x'), 0, 1) $$,
  'not_found', 404, 'roles: exactly what a project that does not exist gives');
select tests.throws_code(
  $$ select public.get_project_content('proj_99999999-9999-4999-8999-999999999999') $$,
  'not_found', 404, 'roles: for pulling as well');

select tests.login_as('cs-editor@example.test');
select throws_ok(
  $$ update public.projects set content = '{}', rev = 100 where id = 'proj_40000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'roles: nobody writes content to the table directly, not even an editor');

select tests.logout();
select results_eq(
  $$ select rev, content from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001' $$,
  $$ values (6, pg_temp.doc('editor')) $$,
  'roles: none of the refused pushes changed the project');

-- ===========================================================================
-- The ledger
-- ===========================================================================

select results_eq(
  $$ select actor_name, action, detail from public.project_activity
      where project_id = 'proj_40000000-0000-4000-8000-000000000001' order by created_at $$,
  $$ values ('Olive Owner', 'content.sync', 'rev 5'), ('cs-editor', 'content.sync', 'rev 6') $$,
  'ledger: one content.sync entry per person per editing session, showing the latest rev; refused pushes leave nothing');

update public.projects set updated_at = '2026-01-01 00:00:00+00' where id = 'proj_40000000-0000-4000-8000-000000000001';
select tests.login_as('cs-owner@example.test');
select is(pg_temp.push(1, pg_temp.doc('owner again'), 6, 5000), '{"ok":true,"rev":7}'::jsonb, 'ledger: (scene) the owner pushes again');
select tests.logout();
select is(
  (select count(*)::integer from public.project_activity
    where project_id = 'proj_40000000-0000-4000-8000-000000000001' and action = 'content.sync'), 3,
  'ledger: a push after someone else''s starts a new entry');
select cmp_ok(
  (select updated_at from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001'),
  '>', '2026-01-01 00:00:00+00'::timestamptz,
  'put_project_content: an accepted push touches the project, so it sorts first in the list');

-- ===========================================================================
-- What counts as a document
-- ===========================================================================

select tests.login_as('cs-owner@example.test');

select tests.throws_code(
         format('select pg_temp.push(2, %L, 0, 1)', t.content), 'invalid_input', 400,
         'document: refused when ' || t.why)
  from (values
         ('not json',                                                         'it is not JSON'),
         ('',                                                                 'it is empty'),
         ('{"stepData":{},"stepStatus":{}',                                   'it is cut short'),
         ('{"stepData":{},"stepStatus":{}} trailing',                         'something follows the document'),
         ('null',                                                             'it is JSON null'),
         ('[]',                                                               'it is an array'),
         ('"text"',                                                           'it is a string'),
         ('42',                                                               'it is a number'),
         ('{}',                                                               'stepData and stepStatus are missing'),
         ('{"stepStatus":{}}',                                                'stepData is missing'),
         ('{"stepData":{}}',                                                  'stepStatus is missing'),
         ('{"stepData":[],"stepStatus":{}}',                                  'stepData is an array'),
         ('{"stepData":null,"stepStatus":{}}',                                'stepData is null'),
         ('{"stepData":{},"stepStatus":[]}',                                  'stepStatus is an array'),
         ('{"stepData":{},"stepStatus":"done"}',                              'stepStatus is a string'),
         ('{"stepData":{},"stepStatus":{"q":true}}',                          'a step status is not an object'),
         ('{"stepData":{},"stepStatus":{"q":{}}}',                            'a step status has neither flag'),
         ('{"stepData":{},"stepStatus":{"q":{"complete":true}}}',             'needsAttention is missing'),
         ('{"stepData":{},"stepStatus":{"q":{"needsAttention":false}}}',      'complete is missing'),
         ('{"stepData":{},"stepStatus":{"q":{"complete":"yes","needsAttention":false}}}', 'complete is not a boolean'),
         ('{"stepData":{},"stepStatus":{"q":{"complete":true,"needsAttention":0}}}',      'needsAttention is not a boolean'),
         ('{"stepData":{},"stepStatus":{"a":{"complete":true,"needsAttention":false},"b":{"complete":1,"needsAttention":false}}}',
                                                                              'one step status among several is wrong'),
         ('{"stepData":{"s":"\u12"},"stepStatus":{}}',                        'a string has a broken \u escape'),
         ('{"stepData":{"s":"\x"},"stepStatus":{}}',                          'a string has an escape JSON does not know'),
         ('{"step\\Data":{},"stepStatus":{}}',                                'a key only resembles stepData'),
         ('{"stepData":{},"step\\Status":{}}',                                'a key only resembles stepStatus')
       ) t (content, why);

select tests.throws_code($$ select pg_temp.push(2, null, 0, 1) $$, 'invalid_input', 400,
  'arguments: the content is required');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), null, 1) $$, 'invalid_input', 400,
  'arguments: the base rev is required');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), 0, null) $$, 'invalid_input', 400,
  'arguments: the timestamp is required');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), -1, 1) $$, 'invalid_input', 400,
  'arguments: a negative base rev is refused');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), 0, -1) $$, 'invalid_input', 400,
  'arguments: a negative timestamp is refused');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), 0, 1, '') $$, 'invalid_input', 400,
  'arguments: an empty title is refused');
select tests.throws_code($$ select pg_temp.push(2, pg_temp.doc('x'), 0, 1, repeat('t', 301)) $$, 'invalid_input', 400,
  'arguments: a title over 300 characters is refused');
select is(pg_temp.pull(2), '{"content":null,"rev":0,"updatedAt":null}'::jsonb,
  'none of the refused documents was stored');

-- Accepted, and stored exactly as sent.
select is(pg_temp.push(2, pg_temp.doc('x'), 0, 0), '{"ok":true,"rev":1}'::jsonb,
  'arguments: base rev 0 and timestamp 0 are valid');
select is(pg_temp.push(2, pg_temp.doc('x'), 1, 9007199254740991, repeat('t', 300)), '{"ok":true,"rev":2}'::jsonb,
  'arguments: the largest timestamp a JavaScript client can send, and a 300 character title');
select is(pg_temp.pull(2) -> 'updatedAt', '9007199254740991'::jsonb,
  'the timestamp comes back exactly');

select is(
  pg_temp.push(2, E' {\n  "zeta": [1, 2.50, 1e3],\n  "stepStatus" : { },\n  "stepData" : { "b": 1, "a": 2, "a": 3 }\n}\n', 2, 10),
  '{"ok":true,"rev":3}'::jsonb,
  'document: extra top-level keys, any key order and any spacing are accepted');
select is(
  pg_temp.pull(2) ->> 'content',
  E' {\n  "zeta": [1, 2.50, 1e3],\n  "stepStatus" : { },\n  "stepData" : { "b": 1, "a": 2, "a": 3 }\n}\n',
  'document: it is stored as the exact text that was sent, not re-serialised');

-- Text taken from PDFs. jsonb cannot hold either of these, which is why content is text.
select is(
  pg_temp.push(2, '{"stepData":{"pdf":"before\u0000after"},"stepStatus":{"q":{"complete":true,"needsAttention":false}}}', 3, 11),
  '{"ok":true,"rev":4}'::jsonb,
  'document: a \u0000 escape inside a string is accepted');
select is(
  pg_temp.pull(2) ->> 'content',
  '{"stepData":{"pdf":"before\u0000after"},"stepStatus":{"q":{"complete":true,"needsAttention":false}}}',
  'document: and comes back untouched');
select is(
  pg_temp.push(2, '{"stepData":{"pdf":"half a pair \ud83d here"},"stepStatus":{}}', 4, 12),
  '{"ok":true,"rev":5}'::jsonb,
  'document: half of a surrogate pair (text cut in the middle of an emoji) is accepted');
select is(
  pg_temp.push(2, '{"stepData":{"k\u0000ey":"\\u0000 \\\u0000 \\\\u0000 \" \\"},"stepStatus":{"s\u0000":{"complete":false,"needsAttention":true}}}', 5, 13),
  '{"ok":true,"rev":6}'::jsonb,
  'document: \u0000 in keys, and every mix of escaped backslashes and \u0000, is accepted');
select is(
  pg_temp.pull(2) ->> 'content',
  '{"stepData":{"k\u0000ey":"\\u0000 \\\u0000 \\\\u0000 \" \\"},"stepStatus":{"s\u0000":{"complete":false,"needsAttention":true}}}',
  'document: and comes back untouched');
select tests.throws_code(
  $$ select pg_temp.push(2, '{"stepData":{"pdf":"\u0000"},"stepStatus":{"q":{"complete":true}}}', 6, 14) $$,
  'invalid_input', 400,
  'document: the shape is still checked when the document contains \u0000');
select tests.throws_code(
  $$ select pg_temp.push(2, '{"stepData":{"pdf":"\u0000"},"stepStatus":{"q\\":{"complete":"\\","needsAttention":false}}}', 6, 14) $$,
  'invalid_input', 400,
  'document: and when it contains escaped backslashes next to quotes');

-- A conflict hands the stored text back untouched too.
select is(
  pg_temp.push(2, pg_temp.doc('stale'), 0, 1) ->> 'content',
  '{"stepData":{"k\u0000ey":"\\u0000 \\\u0000 \\\\u0000 \" \\"},"stepStatus":{"s\u0000":{"complete":false,"needsAttention":true}}}',
  'stale write: the server copy in the answer is the stored text, \u0000 and all');

-- ===========================================================================
-- 20 MB
-- ===========================================================================

select tests.logout();
create temp table sizes (label text primary key, content text);
grant select on sizes to authenticated;
insert into sizes
select 'at the limit',
       '{"stepData":{"x":"' || repeat('a', 20 * 1024 * 1024 - octet_length('{"stepData":{"x":""},"stepStatus":{}}'))
         || '"},"stepStatus":{}}';
insert into sizes
select 'one byte over', replace(content, '{"stepData"', ' {"stepData"') from sizes where label = 'at the limit';
insert into sizes
select 'few characters, many bytes',
       '{"stepData":{"x":"' || repeat('€', 7 * 1024 * 1024) || '"},"stepStatus":{}}';

select results_eq(
  $$ select label, octet_length(content), char_length(content) < 20 * 1024 * 1024 from sizes order by octet_length(content) $$,
  $$ values ('at the limit', 20971520, false), ('one byte over', 20971521, false),
            ('few characters, many bytes', 22020133, true) $$,
  '20 MB: (scene) three documents, one exactly at the limit and two over it');

select tests.login_as('cs-owner@example.test');
select tests.throws_code(
  $$ select pg_temp.push(3, (select content from sizes where label = 'one byte over'), 0, 1) $$, 'invalid_input', 400,
  '20 MB: one byte over the limit is refused');
select tests.throws_code(
  $$ select pg_temp.push(3, (select content from sizes where label = 'few characters, many bytes'), 0, 1) $$, 'invalid_input', 400,
  '20 MB: the limit counts bytes, not characters');
select is(
  pg_temp.push(3, (select content from sizes where label = 'at the limit'), 0, 1), '{"ok":true,"rev":1}'::jsonb,
  '20 MB: exactly 20 MB is accepted');
select is(octet_length(pg_temp.pull(3) ->> 'content'), 20971520,
  '20 MB: and comes back whole');
select is(pg_temp.push(3, pg_temp.doc('small again'), 1, 2), '{"ok":true,"rev":2}'::jsonb,
  '20 MB: (scene) the project goes back to a small document');

-- ===========================================================================
-- Who is refused
-- ===========================================================================
-- The three accounts are owners of the team project, so every refusal is about
-- the caller's account and not about their project role.

select tests.logout();
create temp table rpc_calls (n integer generated always as identity primary key, name text, sql text);
grant select on rpc_calls to authenticated, anon;
insert into rpc_calls (name, sql) values
  ('get_project_content', $$ select pg_temp.pull(1) $$),
  ('put_project_content', $$ select pg_temp.push(1, pg_temp.doc('refused'), 7, 9000, 'Refused') $$);

select tests.login_as('cs-suspended@example.test');
select tests.throws_code(c.sql, 'account_suspended', 403, c.name || ': refused for a suspended account')
  from rpc_calls c order by c.n;

select tests.login_as('cs-invited@example.test');
select tests.throws_code(c.sql, 'password_reset_required', 403, c.name || ': refused until the invited person sets a password')
  from rpc_calls c order by c.n;

select tests.login_as('cs-revoked@example.test');
select is(pg_temp.pull(1) -> 'rev', '7'::jsonb, 'revoked: (scene) the account works while its session exists');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('cs-revoked@example.test');
select tests.resume_as('cs-revoked@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(c.sql, '42501', null, c.name || ': not callable without an account')
  from rpc_calls c order by c.n;

select tests.logout();
select results_eq(
  $$ select title, rev, content from public.projects where id = 'proj_40000000-0000-4000-8000-000000000001' $$,
  $$ values ('Sync project', 7, pg_temp.doc('owner again')) $$,
  'none of the refused calls changed the project');

select * from finish();
rollback;
