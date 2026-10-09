-- Project invitations: the six RPCs, and the rules they exist to keep.
--
--   * Inviting answers the same whether or not the address has an account.
--   * Nobody joins a project without accepting; nobody can be added by email.
--   * Only the person who has CONFIRMED the invited address sees or answers it.
--   * Declining is silent: the owner cannot tell a decline from no answer.
--   * At most 20 open invitations per project, 30 new ones per inviter per
--     24 hours, and an invitation lasts 30 days.
--   * An invitation is worth something only while its inviter is still an
--     active owner of the project.

begin;
select plan(176);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('inv-owner@example.test');
select tests.create_user('inv-owner2@example.test');
select tests.create_user('inv-owner3@example.test');
select tests.create_user('inv-capper@example.test');
select tests.create_user('inv-editor@example.test');
select tests.create_user('inv-outsider@example.test');
select tests.create_user('inv-invitee@example.test');
select tests.create_user('inv-invitee2@example.test');
select tests.create_user('inv-decliner@example.test');
select tests.create_user('inv-mover@example.test');
select tests.create_user('inv-unconfirmed@example.test');
select tests.create_user('inv-suspended@example.test');
select tests.create_user('inv-invited@example.test', 'researcher', false);
select tests.create_user('inv-revoked@example.test');
-- inv-nobody@example.test has no account until section 3.

update public.profiles set name = 'Olive Owner' where email = 'inv-owner@example.test';
update public.profiles set name = 'Otto Second' where email = 'inv-owner2@example.test';
update auth.users set email_confirmed_at = null where id = tests.user_id('inv-unconfirmed@example.test');

-- P1 main flows, P2 the outsider's, P3 the cap of 20, P4 the daily cap,
-- P5 declining, P6 expiry and the inviter's standing.
create temp table pr (k text primary key, id text not null, owner text not null);
insert into pr values
  ('p1', 'proj_45000000-0000-4000-8000-000000000001', 'inv-owner@example.test'),
  ('p2', 'proj_45000000-0000-4000-8000-000000000002', 'inv-outsider@example.test'),
  ('p3', 'proj_45000000-0000-4000-8000-000000000003', 'inv-capper@example.test'),
  ('p4', 'proj_45000000-0000-4000-8000-000000000004', 'inv-capper@example.test'),
  ('p5', 'proj_45000000-0000-4000-8000-000000000005', 'inv-owner@example.test'),
  ('p6', 'proj_45000000-0000-4000-8000-000000000006', 'inv-owner3@example.test');

insert into public.projects (id, title, study_type, owner_id)
select id, 'Project ' || k, 'systematic-review', tests.user_id(owner) from pr;
insert into public.project_members (project_id, user_id, role)
select id, tests.user_id(owner), 'owner' from pr;
insert into public.project_members (project_id, user_id, role) values
  ('proj_45000000-0000-4000-8000-000000000001', tests.user_id('inv-editor@example.test'), 'editor'),
  ('proj_45000000-0000-4000-8000-000000000004', tests.user_id('inv-owner2@example.test'), 'owner');

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;
grant execute on function pg_temp.keys(jsonb) to authenticated;

-- What the RPCs answered, kept for later comparison.
create temp table seen (k text primary key, j jsonb);
grant select, insert on seen to authenticated;
create function pg_temp.inv(p_k text) returns uuid language sql as $$
  select (coalesce(j -> 'invitation', j) ->> 'id')::uuid from seen where k = p_k;
$$;
grant execute on function pg_temp.inv(text) to authenticated;

-- ===========================================================================
-- 1. Inviting
-- ===========================================================================

select tests.login_as('inv-owner@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

insert into seen (k, j)
select 'registered', public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-invitee@example.test', 'editor');
insert into seen (k, j)
select 'unregistered', public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-nobody@example.test', 'editor');

select is(pg_temp.keys((select j from seen where k = 'registered')), 'invitation',
  'invite: returns {invitation}');
select is(pg_temp.keys((select j -> 'invitation' from seen where k = 'registered')),
  'created_at,email,expires_at,id,project_id,role',
  'invite: the invitation has exactly the six documented keys, and no status');
select is(
  (select (j -> 'invitation') - 'id' - 'created_at' - 'expires_at' from seen where k = 'registered'),
  '{"project_id":"proj_45000000-0000-4000-8000-000000000001","email":"inv-invitee@example.test","role":"editor"}'::jsonb,
  'invite: project, address and role as asked');

-- The answer for an address with an account and for one without.
select is(
  (select (j -> 'invitation') - 'id' - 'email' - 'created_at' - 'expires_at' from seen where k = 'unregistered'),
  (select (j -> 'invitation') - 'id' - 'email' - 'created_at' - 'expires_at' from seen where k = 'registered'),
  'no oracle: an address without an account gets the same answer as one with an account');
select is(
  pg_temp.keys((select j -> 'invitation' from seen where k = 'unregistered')),
  pg_temp.keys((select j -> 'invitation' from seen where k = 'registered')),
  'no oracle: with the same keys');
select is(
  (select (j -> 'invitation' ->> 'expires_at')::bigint - (j -> 'invitation' ->> 'created_at')::bigint from seen where k = 'unregistered'),
  (select (j -> 'invitation' ->> 'expires_at')::bigint - (j -> 'invitation' ->> 'created_at')::bigint from seen where k = 'registered'),
  'no oracle: and the same lifetime');

select tests.logout();
select results_eq(
  $$ select email, role, status, invited_by, responded_at, expires_at = created_at + interval '30 days'
       from public.project_invitations
      where project_id = 'proj_45000000-0000-4000-8000-000000000001' order by created_at $$,
  $$ values ('inv-invitee@example.test', 'editor', 'pending', tests.user_id('inv-owner@example.test'), null::timestamptz, true),
            ('inv-nobody@example.test',  'editor', 'pending', tests.user_id('inv-owner@example.test'), null::timestamptz, true) $$,
  'invite: both are stored the same way, pending, for 30 days');
select is(
  (select private.to_ms(i.expires_at) from public.project_invitations i where i.id = pg_temp.inv('registered')),
  (select (j -> 'invitation' ->> 'expires_at')::bigint from seen where k = 'registered'),
  'invite: expires_at in the answer is the stored expiry in epoch milliseconds');
select is(
  (select count(*)::integer from public.project_members where project_id = 'proj_45000000-0000-4000-8000-000000000001'), 2,
  'invite: inviting adds nobody to the project');
-- The function cannot tell the two apart because it never looks an account up.
select is_empty(
  $$ select 1 from pg_proc p
      where p.oid = 'public.invite_project_member(text, text, text)'::regprocedure
        and (p.prosrc ~* 'auth\.users' or p.prosrc ~* 'current_confirmed_email' or p.prosrc ~* 'user_id\('
             or p.prosrc ~* 'email_confirmed') $$,
  'no oracle: invite_project_member never reads the auth records or anyone''s confirmation state');

select tests.login_as('inv-invitee@example.test');
select tests.throws_code($$ select public.get_project('proj_45000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'invite: an invited person is not a member, the project is still hidden from them');
select is(public.list_my_projects(), '{"projects":[]}'::jsonb,
  'invite: and nothing appears in their project list');
select throws_ok($$ select * from public.project_invitations $$, '42501', null,
  'an invitee cannot read the invitations table directly, only through list_my_invitations');

select tests.login_as('inv-owner@example.test');
select throws_ok($$ select * from public.project_invitations $$, '42501', null,
  'an owner cannot read the invitations table directly either (it would show a decline)');
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', E'  Inv-Mixed@Example.TEST \n', 'viewer')
    -> 'invitation' ->> 'email',
  'inv-mixed@example.test', 'invite: the address is trimmed and lower-cased');

-- The ledger records that somebody was invited and as what, never who.
select results_eq(
  $$ select e ->> 'action', e ->> 'detail', e ->> 'actor_name'
       from jsonb_array_elements(public.get_project_activity('proj_45000000-0000-4000-8000-000000000001') -> 'entries')
            with ordinality as t (e, n)
      order by n desc $$,
  $$ values ('member.invite', 'editor', 'Olive Owner'), ('member.invite', 'editor', 'Olive Owner'),
            ('member.invite', 'viewer', 'Olive Owner') $$,
  'invite: one member.invite ledger entry each, with the role as detail');
select is_empty(
  $$ select 1
       from jsonb_array_elements(public.get_project_activity('proj_45000000-0000-4000-8000-000000000001') -> 'entries') e
      where e::text ~* 'invitee|nobody|mixed' $$,
  'invite: no ledger entry mentions an invited address (every member can read the ledger)');

-- Who may invite.
select tests.login_as('inv-editor@example.test');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-x@example.test', 'viewer') $$,
  'forbidden', 403, 'invite: a member who is not an owner gets forbidden');
select tests.login_as('inv-outsider@example.test');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-x@example.test', 'viewer') $$,
  'not_found', 404, 'invite: a non-member gets not_found');
select tests.throws_code(
  $$ select public.invite_project_member('proj_99999999-9999-4999-8999-999999999999', 'inv-x@example.test', 'viewer') $$,
  'not_found', 404, 'invite: so does a project that does not exist');

-- What may be asked.
select tests.login_as('inv-owner@example.test');
select tests.throws_code(
         format('select public.invite_project_member(%L, %L, %L)', 'proj_45000000-0000-4000-8000-000000000001', t.email, 'viewer'),
         'invalid_email', 400, 'invite: refuses an address that ' || t.why)
  from (values
         ('not-an-email',                       'has no @'),
         ('inv-x@example',                      'has no dot after the @'),
         ('inv x@example.test',                 'contains a space'),
         ('inv-x@@example.test',                'has two @'),
         ('@example.test',                      'has nothing before the @'),
         (repeat('a', 243) || '@example.test',  'is longer than 254 characters'),
         ('',                                   'is empty'),
         (null,                                 'is missing')
       ) t (email, why);
select tests.throws_code(
         format('select public.invite_project_member(%L, %L, %L)', 'proj_45000000-0000-4000-8000-000000000001', 'inv-x@example.test', t.role),
         'invalid_role', 400, 'invite: refuses the role ' || coalesce(t.role, 'null'))
  from (values ('owner'), ('admin'), ('master_admin'), ('Editor'), (''), (null)) t (role);

select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-editor@example.test', 'supervisor') $$,
  'already_member', 409, 'invite: an address that belongs to a member of this project is already_member');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', ' INV-OWNER@example.test', 'viewer') $$,
  'already_member', 409, 'invite: including the owner''s own, in any letter case');
select is(
  jsonb_array_length(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') -> 'invitations'), 3,
  'invite: none of the refused calls created an invitation');

-- Inviting an address that already has an open invitation.
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-invitee@example.test', 'supervisor'),
  jsonb_set((select j from seen where k = 'registered'), '{invitation,role}', '"supervisor"'),
  're-invite: the same invitation comes back with the new role; its id and dates do not move');
select tests.logout();
select results_eq(
  $$ select count(*)::integer, min(role), min(status) from public.project_invitations
      where project_id = 'proj_45000000-0000-4000-8000-000000000001' and email = 'inv-invitee@example.test' $$,
  $$ values (1, 'supervisor', 'pending') $$,
  're-invite: the role is updated on the existing row, there is no second row');
select is(
  (select count(*)::integer from public.project_activity
    where project_id = 'proj_45000000-0000-4000-8000-000000000001' and action = 'member.invite'), 3,
  're-invite: adds no ledger entry');

-- Another owner inviting the same address takes the invitation over.
insert into public.project_members (project_id, user_id, role)
values ('proj_45000000-0000-4000-8000-000000000001', tests.user_id('inv-owner2@example.test'), 'owner');
select tests.login_as('inv-owner2@example.test');
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-invitee@example.test', 'viewer')
    -> 'invitation' ->> 'id',
  pg_temp.inv('registered')::text,
  're-invite: a second owner inviting the same address gets the same invitation');

-- ---------------------------------------------------------------------------
-- The owner's list
-- ---------------------------------------------------------------------------

select is(
  pg_temp.keys(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') -> 'invitations' -> 0),
  'created_at,email,expires_at,id,invited_by_name,role',
  'list_project_invitations: each row has exactly the six documented keys, and no status');
select results_eq(
  $$ select i ->> 'email', i ->> 'role', i ->> 'invited_by_name'
       from jsonb_array_elements(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') -> 'invitations')
            with ordinality as t (i, n)
      order by n $$,
  $$ values ('inv-invitee@example.test', 'viewer', 'Otto Second'),
            ('inv-nobody@example.test',  'editor', 'Olive Owner'),
            ('inv-mixed@example.test',   'viewer', 'Olive Owner') $$,
  'list_project_invitations: the open invitations, oldest first, each with who invited (the second owner took one over)');

select tests.login_as('inv-editor@example.test');
select tests.throws_code(
  $$ select public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') $$, 'forbidden', 403,
  'list_project_invitations: a member who is not an owner gets forbidden');
select tests.login_as('inv-outsider@example.test');
select tests.throws_code(
  $$ select public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'list_project_invitations: a non-member gets not_found');
select is(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000002'), '{"invitations":[]}'::jsonb,
  'list_project_invitations: an owner with no open invitations gets an empty list');

-- ===========================================================================
-- 2. The invited person
-- ===========================================================================

select tests.login_as('inv-invitee@example.test');
select is(
  pg_temp.keys(public.list_my_invitations() -> 'invitations' -> 0),
  'created_at,expires_at,id,inviter_email,inviter_name,project_id,project_title,role,study_type',
  'list_my_invitations: each row has exactly the nine documented keys');
select is(
  (public.list_my_invitations() -> 'invitations' -> 0) - 'created_at' - 'expires_at',
  jsonb_build_object(
    'id', pg_temp.inv('registered'), 'project_id', 'proj_45000000-0000-4000-8000-000000000001',
    'project_title', 'Project p1', 'study_type', 'systematic-review', 'role', 'viewer',
    'inviter_name', 'Otto Second', 'inviter_email', 'inv-owner2@example.test'),
  'list_my_invitations: says which project, as what, and who is inviting (name and email)');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  'list_my_invitations: only the invitation addressed to the caller');

select tests.login_as('inv-invitee2@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'list_my_invitations: somebody who was not invited sees none');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('registered')), 'not_found', 404,
  'accept: an invitation addressed to someone else is not_found');
select tests.throws_code(
  format('select public.decline_project_invitation(%L)', pg_temp.inv('registered')), 'not_found', 404,
  'decline: an invitation addressed to someone else is not_found');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', gen_random_uuid()), 'not_found', 404,
  'accept: exactly what an id that does not exist gives');
select tests.throws_code(
  format('select public.decline_project_invitation(%L)', gen_random_uuid()), 'not_found', 404,
  'decline: for an unknown id as well');
select tests.throws_code($$ select public.accept_project_invitation(null) $$, 'not_found', 404,
  'accept: a null id is not_found');

-- The address in the token is not trusted: the confirmed address in the auth record is.
select tests.logout();
select tests._present(
  tests.user_id('inv-invitee2@example.test'), 'inv-invitee@example.test',
  (select s.session_id from tests.issued_sessions s where s.email = 'inv-invitee2@example.test'));
select is(auth.jwt() ->> 'email', 'inv-invitee@example.test', '(scene) a token that claims the invited address');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'a token claiming someone else''s address still sees none of their invitations');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('registered')), 'not_found', 404,
  'and cannot accept them');

-- Accepting.
select tests.login_as('inv-invitee@example.test');
select is(
  public.accept_project_invitation(pg_temp.inv('registered')),
  '{"project_id":"proj_45000000-0000-4000-8000-000000000001","role":"viewer"}'::jsonb,
  'accept: returns {project_id, role}');
select is(public.get_project('proj_45000000-0000-4000-8000-000000000001') ->> 'role', 'viewer',
  'accept: the invitee is now a member with the invited role');
select is(public.list_my_projects() -> 'projects' -> 0 ->> 'id', 'proj_45000000-0000-4000-8000-000000000001',
  'accept: the project is in their list, so the next sync downloads it');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'accept: the invitation is no longer waiting');
select is(
  public.accept_project_invitation(pg_temp.inv('registered')),
  '{"project_id":"proj_45000000-0000-4000-8000-000000000001","role":"viewer"}'::jsonb,
  'accept: accepting again (a retry after a lost answer) gives the same answer');

select tests.logout();
select results_eq(
  $$ select i.status, i.responded_at is not null, m.role, m.added_by
       from public.project_invitations i
       join public.project_members m on m.project_id = i.project_id and m.user_id = tests.user_id('inv-invitee@example.test')
      where i.id = pg_temp.inv('registered') $$,
  $$ values ('accepted', true, 'viewer', tests.user_id('inv-owner2@example.test')) $$,
  'accept: the invitation is marked accepted and the membership records who invited');
select results_eq(
  $$ select actor_id, actor_name, detail from public.project_activity
      where project_id = 'proj_45000000-0000-4000-8000-000000000001' and action = 'member.join' $$,
  $$ values (tests.user_id('inv-invitee@example.test'), 'inv-invitee', 'viewer') $$,
  'accept: one member.join ledger entry, by the person who joined (the retry added none)');

select tests.login_as('inv-owner@example.test');
select is(
  jsonb_array_length(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000001') -> 'invitations'), 2,
  'accept: the owner''s list of open invitations no longer shows it');
select tests.throws_code(
  format('select public.cancel_project_invitation(%L)', pg_temp.inv('registered')), 'not_found', 404,
  'cancel: an accepted invitation cannot be cancelled (that is removing a member)');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-invitee@example.test', 'editor') $$,
  'already_member', 409, 'invite: someone who accepted is a member now');

-- Leaving does not leave a way back in.
select tests.login_as('inv-invitee@example.test');
select tests.throws_code(
  format('select public.decline_project_invitation(%L)', pg_temp.inv('registered')), 'not_found', 404,
  'decline: an accepted invitation cannot be declined (that is leaving)');
select lives_ok($$ select public.leave_project('proj_45000000-0000-4000-8000-000000000001') $$, '(scene) the invitee leaves');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('registered')), 'invitation_invalid', 410,
  'accept: an invitation that was used once cannot be used to rejoin after leaving');
select tests.throws_code($$ select public.get_project('proj_45000000-0000-4000-8000-000000000001') $$, 'not_found', 404,
  'accept: and they are still out');

-- ===========================================================================
-- 3. Addresses without an account, unconfirmed addresses, changed addresses
-- ===========================================================================

-- inv-nobody was invited in section 1, before the account existed.
select tests.logout();
select tests.create_user('inv-nobody@example.test');
select tests.login_as('inv-nobody@example.test');
select results_eq(
  $$ select i ->> 'project_id', i ->> 'role', i ->> 'inviter_name'
       from jsonb_array_elements(public.list_my_invitations() -> 'invitations') i $$,
  $$ values ('proj_45000000-0000-4000-8000-000000000001', 'editor', 'Olive Owner') $$,
  'an invitation sent before the account existed is waiting once the person signs up and confirms that address');
select is(
  public.accept_project_invitation(pg_temp.inv('unregistered')) ->> 'role', 'editor',
  'and can be accepted');

-- An address somebody signed up with but never confirmed: it could be anyone.
select tests.login_as('inv-owner@example.test');
insert into seen (k, j)
select 'unconfirmed', public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-unconfirmed@example.test', 'editor');
insert into seen (k, j)
select 'mover', public.invite_project_member('proj_45000000-0000-4000-8000-000000000001', 'inv-mover@example.test', 'editor');

select tests.login_as('inv-unconfirmed@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'unconfirmed: an account that has not confirmed the address sees none of its invitations');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'not_found', 404,
  'unconfirmed: and cannot accept one, even knowing its id');
select tests.throws_code(
  format('select public.decline_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'not_found', 404,
  'unconfirmed: nor decline one');
select tests.logout();
update auth.users set email_confirmed_at = now() where id = tests.user_id('inv-unconfirmed@example.test');
select tests.resume_as('inv-unconfirmed@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  'unconfirmed: once the address is confirmed the invitation appears');

-- Somebody who changes their address leaves the old address's invitations behind.
select tests.login_as('inv-mover@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1, '(scene) the mover sees their invitation');
select tests.logout();
update auth.users set email = 'inv-moved@example.test' where id = tests.user_id('inv-mover@example.test');
select tests.resume_as('inv-mover@example.test');
select is(auth.jwt() ->> 'email', 'inv-mover@example.test', '(scene) their token still carries the old address');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'changed address: invitations to the old address are no longer theirs');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('mover')), 'not_found', 404,
  'changed address: and cannot be accepted with the old token');

-- ===========================================================================
-- 4. Declining is silent
-- ===========================================================================
-- On P5 the owner invites two people. One declines, the other does not answer.
-- From then on the owner must not be able to tell which is which.

select tests.login_as('inv-owner@example.test');
insert into seen (k, j)
select 'declined', public.invite_project_member('proj_45000000-0000-4000-8000-000000000005', 'inv-decliner@example.test', 'editor');
insert into seen (k, j)
select 'unanswered', public.invite_project_member('proj_45000000-0000-4000-8000-000000000005', 'inv-invitee2@example.test', 'editor');
insert into seen (k, j)
select 'owner list before', public.list_project_invitations('proj_45000000-0000-4000-8000-000000000005');
insert into seen (k, j)
select 'ledger before', public.get_project_activity('proj_45000000-0000-4000-8000-000000000005');
insert into seen (k, j)
select 'project before', public.get_project('proj_45000000-0000-4000-8000-000000000005');
insert into seen (k, j)
select 'projects before', public.list_my_projects();

select tests.login_as('inv-decliner@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1, '(scene) the invitation is waiting');
select is(public.decline_project_invitation(pg_temp.inv('declined')), '{"ok":true}'::jsonb,
  'decline: returns {ok: true}');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'decline: the invitation is gone for the person who declined');
select is(public.decline_project_invitation(pg_temp.inv('declined')), '{"ok":true}'::jsonb,
  'decline: declining again is fine');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('declined')), 'invitation_invalid', 410,
  'decline: a declined invitation cannot be accepted afterwards');
select tests.throws_code($$ select public.get_project('proj_45000000-0000-4000-8000-000000000005') $$, 'not_found', 404,
  'decline: and the project stays hidden');

select tests.logout();
select results_eq(
  $$ select status, responded_at is not null from public.project_invitations where id = pg_temp.inv('declined') $$,
  $$ values ('declined', true) $$,
  'decline: (inside the database) the invitation is marked declined');

select tests.login_as('inv-owner@example.test');
select is(
  public.list_project_invitations('proj_45000000-0000-4000-8000-000000000005'),
  (select j from seen where k = 'owner list before'),
  'silent: the owner''s list is exactly what it was before the decline');
select is(
  public.get_project_activity('proj_45000000-0000-4000-8000-000000000005'),
  (select j from seen where k = 'ledger before'),
  'silent: the ledger is exactly what it was, a decline writes nothing');
select is(
  public.get_project('proj_45000000-0000-4000-8000-000000000005'),
  (select j from seen where k = 'project before'),
  'silent: the project itself is exactly what it was, a decline does not even touch its updated_at');
select is(
  public.list_my_projects(),
  (select j from seen where k = 'projects before'),
  'silent: and the owner''s project list has not moved');

-- Inviting both again: the same answer for the declined one and the unanswered one.
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000005', 'inv-decliner@example.test', 'viewer'),
  jsonb_set((select j from seen where k = 'declined'), '{invitation,role}', '"viewer"'),
  'silent: re-inviting the person who declined answers with the same invitation and the new role');
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000005', 'inv-invitee2@example.test', 'viewer'),
  jsonb_set((select j from seen where k = 'unanswered'), '{invitation,role}', '"viewer"'),
  'silent: which is exactly how re-inviting the person who has not answered behaves');
select results_eq(
  $$ select i ->> 'email', i ->> 'role'
       from jsonb_array_elements(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000005') -> 'invitations')
            with ordinality as t (i, n)
      order by n $$,
  $$ values ('inv-decliner@example.test', 'viewer'), ('inv-invitee2@example.test', 'viewer') $$,
  'silent: the owner''s list shows the new role on both');

select tests.login_as('inv-decliner@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'silent: re-inviting does not put a declined invitation back in front of the person who declined it');
select tests.login_as('inv-invitee2@example.test');
select is(public.list_my_invitations() -> 'invitations' -> 0 ->> 'role', 'viewer',
  'silent: while the person who has not answered sees the new role');

select tests.logout();
select results_eq(
  $$ select email, status from public.project_invitations
      where project_id = 'proj_45000000-0000-4000-8000-000000000005' order by email $$,
  $$ values ('inv-decliner@example.test', 'declined'), ('inv-invitee2@example.test', 'pending') $$,
  'silent: (inside the database) still one row each, the declined one still declined');

-- Cancelling: the same again.
select tests.login_as('inv-owner@example.test');
select is(public.cancel_project_invitation(pg_temp.inv('declined')), '{"ok":true}'::jsonb,
  'silent: cancelling the declined invitation answers {ok: true}');
select is(public.cancel_project_invitation(pg_temp.inv('unanswered')), '{"ok":true}'::jsonb,
  'silent: exactly as cancelling the unanswered one does');
select is(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000005'), '{"invitations":[]}'::jsonb,
  'cancel: both are gone from the owner''s list');

-- After a cancel, a fresh invitation does reach the person again.
insert into seen (k, j)
select 'fresh', public.invite_project_member('proj_45000000-0000-4000-8000-000000000005', 'inv-decliner@example.test', 'supervisor');
select isnt(pg_temp.inv('fresh'), pg_temp.inv('declined'), 'cancel: inviting after a cancel creates a new invitation');
select tests.login_as('inv-decliner@example.test');
select is(public.list_my_invitations() -> 'invitations' -> 0 ->> 'role', 'supervisor',
  'cancel: which the person sees, declined earlier or not');

-- ===========================================================================
-- 5. Cancelling
-- ===========================================================================

select tests.login_as('inv-editor@example.test');
select tests.throws_code(
  format('select public.cancel_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'not_found', 404,
  'cancel: a member who is not an owner gets not_found (they cannot see invitations at all)');
select tests.login_as('inv-outsider@example.test');
select tests.throws_code(
  format('select public.cancel_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'not_found', 404,
  'cancel: the owner of some other project gets not_found');
select tests.throws_code(
  format('select public.cancel_project_invitation(%L)', gen_random_uuid()), 'not_found', 404,
  'cancel: an id that does not exist is not_found');
select tests.login_as('inv-unconfirmed@example.test');
select tests.throws_code(
  format('select public.cancel_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'not_found', 404,
  'cancel: the invited person cannot cancel (they decline)');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  'cancel: none of the refused calls cancelled it');

select tests.login_as('inv-owner2@example.test');
select is(public.cancel_project_invitation(pg_temp.inv('unconfirmed')), '{"ok":true}'::jsonb,
  'cancel: any owner of the project can cancel, not only the one who invited');
select is(public.cancel_project_invitation(pg_temp.inv('unconfirmed')), '{"ok":true}'::jsonb,
  'cancel: cancelling again is fine');
select tests.login_as('inv-unconfirmed@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'cancel: the invitation is gone for the invited person');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('unconfirmed')), 'invitation_invalid', 410,
  'cancel: and can no longer be accepted');
select is(public.decline_project_invitation(pg_temp.inv('unconfirmed')), '{"ok":true}'::jsonb,
  'decline: declining an invitation that was cancelled meanwhile is fine, and changes nothing');
select tests.logout();
select is((select status from public.project_invitations where id = pg_temp.inv('unconfirmed')), 'cancelled',
  'cancel: (inside the database) it stays cancelled');

-- ===========================================================================
-- 6. Expiry, and the inviter's standing
-- ===========================================================================

select tests.login_as('inv-owner3@example.test');
insert into seen (k, j)
select 'p6', public.invite_project_member('proj_45000000-0000-4000-8000-000000000006', 'inv-invitee2@example.test', 'editor');

-- Thirty days pass.
select tests.logout();
update public.project_invitations
   set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
 where id = pg_temp.inv('p6');
select tests.login_as('inv-invitee2@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'expiry: an invitation older than 30 days is no longer shown to the invited person');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('p6')), 'invitation_expired', 410,
  'expiry: accepting it gives invitation_expired');
select tests.login_as('inv-owner3@example.test');
select is(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000006'), '{"invitations":[]}'::jsonb,
  'expiry: nor is it in the owner''s list');
insert into seen (k, j)
select 'p6 again', public.invite_project_member('proj_45000000-0000-4000-8000-000000000006', 'inv-invitee2@example.test', 'editor');
select isnt(pg_temp.inv('p6 again'), pg_temp.inv('p6'),
  'expiry: inviting the address again creates a new invitation');
select tests.logout();
select is((select status from public.project_invitations where id = pg_temp.inv('p6')), 'expired',
  'expiry: and the old one is marked expired');
select tests.login_as('inv-invitee2@example.test');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('p6')), 'invitation_expired', 410,
  'expiry: the expired one still answers invitation_expired');
select is(public.list_my_invitations() -> 'invitations' -> 0 ->> 'id', pg_temp.inv('p6 again')::text,
  'expiry: the new one is waiting');

-- The inviter is suspended.
select tests.logout();
update public.profiles set status = 'suspended' where id = tests.user_id('inv-owner3@example.test');
select tests.resume_as('inv-invitee2@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'inviter suspended: their invitations are hidden from the people they invited');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('p6 again')), 'invitation_invalid', 410,
  'inviter suspended: and cannot be accepted');
select tests.logout();
update public.profiles set status = 'active' where id = tests.user_id('inv-owner3@example.test');
select tests.resume_as('inv-invitee2@example.test');
select is(jsonb_array_length(public.list_my_invitations() -> 'invitations'), 1,
  'inviter reinstated: the invitation is back');

-- The inviter is no longer an owner.
select tests.logout();
insert into public.project_members (project_id, user_id, role)
values ('proj_45000000-0000-4000-8000-000000000006', tests.user_id('inv-owner2@example.test'), 'owner');
update public.project_members set role = 'editor'
 where project_id = 'proj_45000000-0000-4000-8000-000000000006' and user_id = tests.user_id('inv-owner3@example.test');
select tests.resume_as('inv-invitee2@example.test');
select is(public.list_my_invitations(), '{"invitations":[]}'::jsonb,
  'inviter demoted: the invitation is hidden');
select tests.throws_code(
  format('select public.accept_project_invitation(%L)', pg_temp.inv('p6 again')), 'invitation_invalid', 410,
  'inviter demoted: and cannot be accepted');
select tests.logout();
select is_empty(
  $$ select 1 from public.project_members
      where project_id = 'proj_45000000-0000-4000-8000-000000000006' and user_id = tests.user_id('inv-invitee2@example.test') $$,
  'none of the refused accepts created a membership');

-- The remaining owner invites the address again and takes the invitation over.
select tests.login_as('inv-owner2@example.test');
select is(
  public.invite_project_member('proj_45000000-0000-4000-8000-000000000006', 'inv-invitee2@example.test', 'supervisor')
    -> 'invitation' ->> 'id',
  pg_temp.inv('p6 again')::text, 'take-over: the current owner re-invites and gets the same invitation');
select tests.login_as('inv-invitee2@example.test');
select is(
  (public.list_my_invitations() -> 'invitations' -> 0) - 'created_at' - 'expires_at' - 'id',
  '{"project_id":"proj_45000000-0000-4000-8000-000000000006","project_title":"Project p6","study_type":"systematic-review",
    "role":"supervisor","inviter_name":"Otto Second","inviter_email":"inv-owner2@example.test"}'::jsonb,
  'take-over: it is visible again, now from the current owner');
select is(
  public.accept_project_invitation(pg_temp.inv('p6 again')),
  '{"project_id":"proj_45000000-0000-4000-8000-000000000006","role":"supervisor"}'::jsonb,
  'take-over: and can be accepted');

-- ===========================================================================
-- 7. Limits
-- ===========================================================================

-- 20 open invitations per project. P3 starts with 19: 18 unanswered and one
-- declined (which counts, or the count would give the decline away). All of
-- them are two days old, so they do not touch the daily limit tested below.
select tests.logout();
insert into public.project_invitations (project_id, email, role, invited_by, status, created_at)
select 'proj_45000000-0000-4000-8000-000000000003', 'inv-cap' || n || '@example.test', 'viewer',
       tests.user_id('inv-capper@example.test'),
       case when n = 1 then 'declined' else 'pending' end,
       now() - interval '2 days'
  from generate_series(1, 19) n;
-- Not open: these three must not count.
insert into public.project_invitations (project_id, email, role, invited_by, status, created_at)
select 'proj_45000000-0000-4000-8000-000000000003', 'inv-closed-' || s || '@example.test', 'viewer',
       tests.user_id('inv-capper@example.test'), s, now() - interval '2 days'
  from unnest(array['accepted', 'cancelled', 'expired']) s;

select tests.login_as('inv-capper@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap20@example.test', 'viewer') $$,
  'cap of 20: the 20th open invitation is accepted (accepted, cancelled and expired ones do not count)');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap21@example.test', 'viewer') $$,
  'too_many_invitations', 429, 'cap of 20: the 21st is refused');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap5@example.test', 'editor') $$,
  'cap of 20: changing the role of an open invitation is still possible at the cap');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap1@example.test', 'editor') $$,
  'cap of 20: including the declined one, which answers like any other');
select is(
  jsonb_array_length(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000003') -> 'invitations'), 20,
  'cap of 20: the owner sees 20 open invitations, the declined one among them');

-- Cancelling one makes room.
select lives_ok(
  format('select public.cancel_project_invitation(%L)',
         (select i ->> 'id'
            from jsonb_array_elements(public.list_project_invitations('proj_45000000-0000-4000-8000-000000000003') -> 'invitations') i
           where i ->> 'email' = 'inv-cap3@example.test')),
  '(scene) the owner cancels one');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap21@example.test', 'viewer') $$,
  'cap of 20: after a cancel there is room for one more');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap22@example.test', 'viewer') $$,
  'too_many_invitations', 429, 'cap of 20: and then the project is full again');

-- One running out of time makes room as well.
select tests.logout();
update public.project_invitations set expires_at = now() - interval '1 second'
 where project_id = 'proj_45000000-0000-4000-8000-000000000003' and email = 'inv-cap7@example.test';
select tests.resume_as('inv-capper@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000003', 'inv-cap22@example.test', 'viewer') $$,
  'cap of 20: an invitation that ran out of time no longer counts');
select tests.logout();
select is(
  (select status from public.project_invitations
    where project_id = 'proj_45000000-0000-4000-8000-000000000003' and email = 'inv-cap7@example.test'), 'expired',
  'cap of 20: and is marked expired by the next invite');

-- The cap is per project.
select tests.resume_as('inv-capper@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day0@example.test', 'viewer') $$,
  'cap of 20: a full project does not stop invitations to another project');

-- 30 new invitations per inviter per 24 hours. The capper has made 4 new ones
-- above (cap20, cap21, cap22, day0). 25 more from the last day, of every status
-- and on both projects, bring the count to 29. The limit is counted from the
-- tally, one row per invitation made (046), so the scene writes both.
select tests.logout();
select is(
  (select count(*)::integer from private.invitation_tally
    where inviter_id = tests.user_id('inv-capper@example.test') and created_at > now() - interval '24 hours'), 4,
  'daily limit: (scene) four invitations so far today');
insert into public.project_invitations (project_id, email, role, invited_by, status, created_at)
select case when n % 2 = 0 then 'proj_45000000-0000-4000-8000-000000000004' else 'proj_45000000-0000-4000-8000-000000000003' end,
       'inv-day' || n || '@example.test', 'viewer', tests.user_id('inv-capper@example.test'),
       (array['cancelled', 'expired', 'accepted', 'cancelled', 'expired'])[1 + n % 5],
       now() - interval '23 hours'
  from generate_series(1, 25) n;
insert into private.invitation_tally (inviter_id, created_at)
select tests.user_id('inv-capper@example.test'), now() - interval '23 hours'
  from generate_series(1, 25) n;

select tests.resume_as('inv-capper@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day30@example.test', 'viewer') $$,
  'daily limit: the 30th invitation in 24 hours is accepted');
select tests.throws_code(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day31@example.test', 'viewer') $$,
  'invite_rate_limited', 429, 'daily limit: the 31st is refused, and cancelled, expired and accepted ones all count');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day30@example.test', 'editor') $$,
  'daily limit: changing the role of an open invitation is not a new invitation');

-- The limit is per inviter, not per project.
select tests.login_as('inv-owner2@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day31@example.test', 'viewer') $$,
  'daily limit: another owner of the same project has their own allowance');

-- It is a rolling window: an hour later, the oldest ones have dropped out.
select tests.logout();
update public.project_invitations set created_at = created_at - interval '2 hours'
 where invited_by = tests.user_id('inv-capper@example.test') and email like 'inv-day%'
   and created_at < now() - interval '22 hours';
update private.invitation_tally set created_at = created_at - interval '2 hours'
 where inviter_id = tests.user_id('inv-capper@example.test')
   and created_at < now() - interval '22 hours';
select tests.resume_as('inv-capper@example.test');
select lives_ok(
  $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000004', 'inv-day32@example.test', 'viewer') $$,
  'daily limit: invitations older than 24 hours stop counting');

-- ===========================================================================
-- 8. Who is refused
-- ===========================================================================
-- The three accounts own P2 together with the outsider, and each has an
-- invitation of their own waiting on P1, so every refusal is about the
-- caller's account and nothing else.

select tests.logout();
insert into public.project_members (project_id, user_id, role) values
  ('proj_45000000-0000-4000-8000-000000000002', tests.user_id('inv-suspended@example.test'), 'owner'),
  ('proj_45000000-0000-4000-8000-000000000002', tests.user_id('inv-invited@example.test'),   'owner'),
  ('proj_45000000-0000-4000-8000-000000000002', tests.user_id('inv-revoked@example.test'),   'owner');

create temp table gate (user_id uuid primary key, mine uuid not null, theirs uuid not null);
grant select on gate to authenticated, anon;
insert into public.project_invitations (id, project_id, email, role, invited_by) values
  ('45000000-0000-4000-8000-0000000000a1', 'proj_45000000-0000-4000-8000-000000000001', 'inv-suspended@example.test', 'editor', tests.user_id('inv-owner@example.test')),
  ('45000000-0000-4000-8000-0000000000a2', 'proj_45000000-0000-4000-8000-000000000001', 'inv-invited@example.test',   'editor', tests.user_id('inv-owner@example.test')),
  ('45000000-0000-4000-8000-0000000000a3', 'proj_45000000-0000-4000-8000-000000000001', 'inv-revoked@example.test',   'editor', tests.user_id('inv-owner@example.test')),
  ('45000000-0000-4000-8000-0000000000b1', 'proj_45000000-0000-4000-8000-000000000002', 'inv-gate@example.test',      'editor', tests.user_id('inv-outsider@example.test'));
insert into gate values
  (tests.user_id('inv-suspended@example.test'), '45000000-0000-4000-8000-0000000000a1', '45000000-0000-4000-8000-0000000000b1'),
  (tests.user_id('inv-invited@example.test'),   '45000000-0000-4000-8000-0000000000a2', '45000000-0000-4000-8000-0000000000b1'),
  (tests.user_id('inv-revoked@example.test'),   '45000000-0000-4000-8000-0000000000a3', '45000000-0000-4000-8000-0000000000b1');
update public.profiles set status = 'suspended' where email = 'inv-suspended@example.test';

create temp table rpc_calls (n integer generated always as identity primary key, name text, sql text);
grant select on rpc_calls to authenticated, anon;
insert into rpc_calls (name, sql) values
  ('invite_project_member',      $$ select public.invite_project_member('proj_45000000-0000-4000-8000-000000000002', 'inv-refused@example.test', 'viewer') $$),
  ('list_project_invitations',   $$ select public.list_project_invitations('proj_45000000-0000-4000-8000-000000000002') $$),
  ('cancel_project_invitation',  $$ select public.cancel_project_invitation('45000000-0000-4000-8000-0000000000b1') $$),
  ('list_my_invitations',        $$ select public.list_my_invitations() $$),
  ('accept_project_invitation',  $$ select public.accept_project_invitation((select g.mine from gate g where g.user_id = auth.uid())) $$),
  ('decline_project_invitation', $$ select public.decline_project_invitation((select g.mine from gate g where g.user_id = auth.uid())) $$);

select tests.login_as('inv-suspended@example.test');
select tests.throws_code(c.sql, 'account_suspended', 403, c.name || ': refused for a suspended account')
  from rpc_calls c order by c.n;

select tests.login_as('inv-invited@example.test');
select tests.throws_code(c.sql, 'password_reset_required', 403, c.name || ': refused until the invited person sets a password')
  from rpc_calls c order by c.n;

select tests.login_as('inv-revoked@example.test');
select is(public.list_my_invitations() -> 'invitations' -> 0 ->> 'id', '45000000-0000-4000-8000-0000000000a3',
  'revoked: (scene) the account works while its session exists');
select tests.logout();
delete from auth.sessions where user_id = tests.user_id('inv-revoked@example.test');
select tests.resume_as('inv-revoked@example.test');
select tests.throws_code(c.sql, 'unauthenticated', 401, c.name || ': refused for a token whose session was revoked')
  from rpc_calls c order by c.n;

select tests.as_anon();
select throws_ok(c.sql, '42501', null, c.name || ': not callable without an account')
  from rpc_calls c order by c.n;

select tests.logout();
select results_eq(
  $$ select id::text, status from public.project_invitations where id::text like '45000000-0000-4000-8000-0000000000%' order by id $$,
  $$ values ('45000000-0000-4000-8000-0000000000a1', 'pending'), ('45000000-0000-4000-8000-0000000000a2', 'pending'),
            ('45000000-0000-4000-8000-0000000000a3', 'pending'), ('45000000-0000-4000-8000-0000000000b1', 'pending') $$,
  'none of the refused calls accepted, declined or cancelled anything');
select is_empty(
  $$ select 1 from public.project_invitations where email = 'inv-refused@example.test'
     union all
     select 1 from public.project_members m
      where m.project_id = 'proj_45000000-0000-4000-8000-000000000001'
        and m.user_id in (select g.user_id from gate g) $$,
  'and none of them invited anyone or joined anything');

select * from finish();
rollback;
