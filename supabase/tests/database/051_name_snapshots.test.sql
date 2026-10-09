-- The names stored beside comments, sign-offs and ledger entries (migration 16).
--
-- 1. Somebody with no name used to be stored under their full email address.
--    That address then stayed readable to every member of the project, also
--    to people who joined later and also after the account was deleted, when
--    it is supposed to survive in the audit log only. Now the stand-in for a
--    missing name is the part of the address before the "@", and deleting an
--    account, by whatever route, replaces every name of it that was taken from
--    its address.
--
-- 2. Two members may carry the same name (a name is free text). The ledger
--    summary counted by name and showed them as one contributor. It counts by
--    account now, and every entry says which account wrote it.

begin;
select plan(41);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('ns-owner@example.test');
select tests.create_user('ns-leaver@example.test');          -- no name: the case that leaked
select tests.create_user('ns-named@example.test');
select tests.create_user('ns-legacy@example.test');          -- rows written before this migration
select tests.create_user('ns-dashboard@example.test');
select tests.create_user('ns-removed@example.test');
select tests.create_user('ns-mover@example.test');
select tests.create_user('ns-mallory@example.test');
select tests.create_user('ns-later@example.test');           -- joins after everything happened
select tests.create_user('ns-admin@example.test', 'admin');

update public.profiles set name = 'Dr. Alice Owner' where email = 'ns-owner@example.test';
update public.profiles set name = 'Nadia Named' where email = 'ns-named@example.test';

insert into public.projects (id, title, study_type, owner_id) values
  ('proj_51000000-0000-4000-8000-000000000001', 'Shared review', 'rct', tests.user_id('ns-owner@example.test'));
insert into public.project_members (project_id, user_id, role)
select 'proj_51000000-0000-4000-8000-000000000001', tests.user_id(t.email), t.role
  from (values ('ns-owner@example.test', 'owner'), ('ns-leaver@example.test', 'supervisor'),
               ('ns-named@example.test', 'supervisor'), ('ns-legacy@example.test', 'supervisor'),
               ('ns-dashboard@example.test', 'supervisor'), ('ns-removed@example.test', 'supervisor'),
               ('ns-mover@example.test', 'supervisor'), ('ns-mallory@example.test', 'viewer')) t (email, role);

create function pg_temp.keys(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;

-- Everything a member can read about who wrote what, as one piece of text.
create function pg_temp.all_names() returns text language sql as $$
  select (public.list_project_comments('proj_51000000-0000-4000-8000-000000000001')
          || public.list_project_reviews('proj_51000000-0000-4000-8000-000000000001')
          || public.get_project_activity('proj_51000000-0000-4000-8000-000000000001'))::text;
$$;

-- The three stored names of one account in the project, read as the owner.
create function pg_temp.stored(p_user_id uuid)
returns table (comments text[], reviews text[], ledger text[])
language sql stable security definer as $$
  select (select array_agg(distinct c.author_name) from public.project_comments c
           where c.author_id = p_user_id and c.project_id = 'proj_51000000-0000-4000-8000-000000000001'),
         (select array_agg(distinct r.reviewer_name) from public.project_reviews r
           where r.reviewer_id = p_user_id and r.project_id = 'proj_51000000-0000-4000-8000-000000000001'),
         (select array_agg(distinct a.actor_name) from public.project_activity a
           where a.actor_id = p_user_id and a.project_id = 'proj_51000000-0000-4000-8000-000000000001');
$$;

grant execute on function pg_temp.keys(jsonb), pg_temp.all_names(), pg_temp.stored(uuid) to authenticated;

-- Each of them comments and signs a step of their own off.
create function pg_temp.writes(p_email text, p_step text) returns void language plpgsql as $$
begin
  perform tests.login_as(p_email);
  perform public.add_project_comment('proj_51000000-0000-4000-8000-000000000001', p_step, 'A remark on ' || p_step);
  perform public.set_project_review('proj_51000000-0000-4000-8000-000000000001', p_step, 'approved');
  perform tests.logout();
end $$;

select pg_temp.writes('ns-leaver@example.test',    'step-leaver');
select pg_temp.writes('ns-named@example.test',     'step-named');
select pg_temp.writes('ns-dashboard@example.test', 'step-dashboard');
select pg_temp.writes('ns-removed@example.test',   'step-removed');
select pg_temp.writes('ns-mover@example.test',     'step-mover');

-- Rows as the previous version of the backend wrote them: the whole address.
insert into public.project_comments (project_id, step_id, author_id, author_name, body)
values ('proj_51000000-0000-4000-8000-000000000001', 'step-legacy', tests.user_id('ns-legacy@example.test'),
        'ns-legacy@example.test', 'An old remark');
insert into public.project_reviews (project_id, step_id, status, reviewer_id, reviewer_name)
values ('proj_51000000-0000-4000-8000-000000000001', 'step-legacy', 'approved', tests.user_id('ns-legacy@example.test'),
        'NS-Legacy@example.test');
insert into public.project_activity (project_id, actor_id, actor_name, action, detail)
values ('proj_51000000-0000-4000-8000-000000000001', tests.user_id('ns-legacy@example.test'),
        'ns-legacy@example.test', 'comment.add', 'step-legacy');

-- ===========================================================================
-- 1. Never the whole address
-- ===========================================================================

select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-leaver@example.test')) $$,
  $$ values (array['ns-leaver'], array['ns-leaver'], array['ns-leaver']) $$,
  'somebody with no name is stored under the part of their address before the @: comment, sign-off and ledger');
select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-named@example.test')) $$,
  $$ values (array['Nadia Named'], array['Nadia Named'], array['Nadia Named']) $$,
  'somebody with a name is stored under it');
select is(private.display_name(tests.user_id('ns-leaver@example.test')), 'ns-leaver',
  'display_name: the start of the address, never the whole address');
select is(private.display_name(tests.user_id('ns-named@example.test')), 'Nadia Named',
  'display_name: the name when there is one');

select tests.login_as('ns-owner@example.test');
select ok(pg_temp.all_names() !~ 'ns-leaver@', 'a member reads no full address of a nameless co-member in comments, sign-offs or the ledger');
select ok(pg_temp.all_names() ~ 'ns-legacy@example\.test',
  '(scene) rows written before this change still carry a full address');
select is(
  (select m ->> 'email'
     from jsonb_array_elements(public.list_project_members('proj_51000000-0000-4000-8000-000000000001') -> 'members') m
    where m ->> 'user_id' = tests.user_id('ns-leaver@example.test')::text),
  'ns-leaver@example.test',
  '(control) the member list still shows the address of a current member: that is where it belongs');

-- ===========================================================================
-- 2. A deleted account leaves no address behind
-- ===========================================================================

-- Through the admin function.
select tests.login_as('ns-admin@example.test');
select is(public.admin_soft_delete_user(tests.user_id('ns-leaver@example.test')), '{"ok":true}'::jsonb,
  '(scene) an admin deletes the nameless account');
select is(public.admin_soft_delete_user(tests.user_id('ns-legacy@example.test')), '{"ok":true}'::jsonb,
  '(scene) and the one whose rows still carry the whole address');
select is(public.admin_soft_delete_user(tests.user_id('ns-named@example.test')), '{"ok":true}'::jsonb,
  '(scene) and the one with a name');
select tests.logout();

select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-leaver@example.test')) $$,
  $$ values (array['Deleted user'], array['Deleted user'], array['Deleted user']) $$,
  'deleted: every name that was taken from the address now reads "Deleted user"');
select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-legacy@example.test')) $$,
  $$ values (array['Deleted user'], array['Deleted user'], array['Deleted user']) $$,
  'deleted: also where the whole address was stored, in any letter case');
select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-named@example.test')) $$,
  $$ values (array['Nadia Named'], array['Nadia Named'], array['Nadia Named']) $$,
  'deleted: a name the person chose stays, so what they wrote stays attributed');
select results_eq(
  $$ select action, before_data from public.audit_log
      where target_id = tests.user_id('ns-leaver@example.test')::text and action = 'admin.user_deleted' $$,
  $$ values ('admin.user_deleted', '{"email":"ns-leaver@example.test","role":"researcher"}'::jsonb) $$,
  'deleted: the address is kept in the audit log, and only there');

-- Somebody who joins afterwards, and never shared the project with them.
insert into public.project_members (project_id, user_id, role)
values ('proj_51000000-0000-4000-8000-000000000001', tests.user_id('ns-later@example.test'), 'viewer');
select tests.login_as('ns-later@example.test');
select ok(pg_temp.all_names() !~* 'ns-leaver',
  'a member who joined later reads nothing of the deleted address: not the whole of it, not its start');
select ok(pg_temp.all_names() !~* 'ns-legacy', 'nor of the other one');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.list_project_comments('proj_51000000-0000-4000-8000-000000000001') -> 'comments') c
    where c ->> 'author_name' = 'Deleted user'), 2,
  'the comments are still there, under "Deleted user"');
select is(
  (select array_agg(m ->> 'email' order by m ->> 'email')
     from jsonb_array_elements(public.list_project_members('proj_51000000-0000-4000-8000-000000000001') -> 'members') m
    where m ->> 'user_id' in (tests.user_id('ns-leaver@example.test')::text,
                              tests.user_id('ns-legacy@example.test')::text)),
  array['', ''],
  'and the member list shows no address for a deleted member');
select tests.logout();

-- Deleted in Auth by the instance owner (the dashboard), not through the app.
update auth.users
   set deleted_at = now(), email = 'obfuscated-hash', encrypted_password = null
 where id = tests.user_id('ns-dashboard@example.test');
select results_eq(
  $$ select comments, reviews, ledger
       from pg_temp.stored((select i.user_id from tests.issued_sessions i where i.email = 'ns-dashboard@example.test')) $$,
  $$ values (array['Deleted user'], array['Deleted user'], array['Deleted user']) $$,
  'deleted in Auth directly: the same');

-- Removed for good: the profile goes, what it wrote stays without an author.
create temp table gone as
select c.id from public.project_comments c where c.author_id = tests.user_id('ns-removed@example.test');
delete from auth.users where id = tests.user_id('ns-removed@example.test');
select results_eq(
  $$ select c.author_id, c.author_name from public.project_comments c join gone g on g.id = c.id $$,
  $$ values (null::uuid, 'Deleted user') $$,
  'removed for good: the comment stays, with no author and no part of the address');
select is_empty(
  $$ select 1 from public.project_reviews r
      where r.project_id = 'proj_51000000-0000-4000-8000-000000000001' and r.reviewer_name ~* 'ns-removed' $$,
  'removed for good: the same for the sign-off');
select is_empty(
  $$ select 1 from public.project_activity a
      where a.project_id = 'proj_51000000-0000-4000-8000-000000000001' and a.actor_name ~* 'ns-removed' $$,
  'removed for good: and for the ledger');

-- ===========================================================================
-- 3. A changed address does not linger
-- ===========================================================================

create temp table stamp as
select collab_updated_at as at from public.projects where id = 'proj_51000000-0000-4000-8000-000000000001';
-- The holder's own change, as Auth writes it.
update auth.users set email_change = 'ns-newname@example.test' where id = tests.user_id('ns-mover@example.test');
update auth.users set email = email_change, email_change = '' where email = 'ns-mover@example.test';
select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-newname@example.test')) $$,
  $$ values (array['ns-newname'], array['ns-newname'], array['ns-newname']) $$,
  'after a change of address the stored names follow the new address');
select cmp_ok(
  (select collab_updated_at from public.projects where id = 'proj_51000000-0000-4000-8000-000000000001'),
  '>', (select at from stamp),
  'and the project''s comment stamp moves, so the other members'' apps fetch the new names');

-- With a name set in the meantime, the stand-in gives way to the name.
update public.profiles set name = 'Morgan Mover' where id = tests.user_id('ns-newname@example.test');
update auth.users set email = 'ns-moved-again@example.test' where email = 'ns-newname@example.test';
select results_eq(
  $$ select * from pg_temp.stored(tests.user_id('ns-moved-again@example.test')) $$,
  $$ values (array['Morgan Mover'], array['Morgan Mover'], array['Morgan Mover']) $$,
  'a stand-in is replaced by the person''s name once they have one');

-- Only that account's own rows are touched.
select tests.login_as('ns-owner@example.test');
select public.update_my_profile('ns-moved-again') ->> 'ok' as owner_takes_a_name_that_looks_like_an_address;
select public.add_project_comment('proj_51000000-0000-4000-8000-000000000001', 'step-owner', 'Owner speaking.') ->> 'ok' as commented;
select public.update_my_profile('Dr. Alice Owner') ->> 'ok' as owner_name_back;
select tests.logout();
update auth.users set email = 'ns-third@example.test' where email = 'ns-moved-again@example.test';
select is(
  (select c.author_name from public.project_comments c
    where c.author_id = tests.user_id('ns-owner@example.test') and c.step_id = 'step-owner'),
  'ns-moved-again',
  'somebody else''s stored name is never rewritten, even when it equals the start of the address that changed');

-- ===========================================================================
-- 4. Two people, one name
-- ===========================================================================

-- A viewer gives themselves the owner's name, comments, and changes it back.
select tests.login_as('ns-mallory@example.test');
select is(public.update_my_profile('Dr. Alice Owner') -> 'user' ->> 'name', 'Dr. Alice Owner',
  '(scene) a viewer takes the owner''s name: a name is free text');
select is(
  public.add_project_comment('proj_51000000-0000-4000-8000-000000000001', 'step-owner', 'I approve dropping the outliers.')
    -> 'comment' ->> 'author_name',
  'Dr. Alice Owner', '(scene) and comments under it');
select is(public.update_my_profile('Mallory') -> 'user' ->> 'name', 'Mallory', '(scene) then takes their own name back');

select tests.login_as('ns-owner@example.test');
select is(
  public.add_project_comment('proj_51000000-0000-4000-8000-000000000001', 'step-owner', 'The owner, in person.')
    -> 'comment' ->> 'author_name',
  'Dr. Alice Owner', '(scene) the real owner comments too');
select results_eq(
  $$ select c ->> 'author_name', (c ->> 'author_id')::uuid
       from jsonb_array_elements(
              public.list_project_comments('proj_51000000-0000-4000-8000-000000000001', 'step-owner') -> 'comments') c
      where c ->> 'text' = 'I approve dropping the outliers.' $$,
  $$ values ('Dr. Alice Owner', tests.user_id('ns-mallory@example.test')) $$,
  'the comment carries the name it was written under AND the account that wrote it: the id is not the owner''s');
select is(
  (select m ->> 'role' || ' ' || (m ->> 'email')
     from jsonb_array_elements(public.list_project_members('proj_51000000-0000-4000-8000-000000000001') -> 'members') m
    where m ->> 'user_id' = (
      select c ->> 'author_id'
        from jsonb_array_elements(
               public.list_project_comments('proj_51000000-0000-4000-8000-000000000001', 'step-owner') -> 'comments') c
       where c ->> 'text' = 'I approve dropping the outliers.')),
  'viewer ns-mallory@example.test',
  'and the member list says who that account is: a viewer, with their own address');

select is(
  pg_temp.keys(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors' -> 0),
  'actor,actorId,count,lastAt',
  'contributors: each one names the account, not only a name');
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
    where c ->> 'actor' = 'Dr. Alice Owner'), 2,
  'contributors: two accounts that wrote under one name are two contributors');
select results_eq(
  $$ select (c ->> 'actorId')::uuid, (c ->> 'count')::integer
       from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
      where c ->> 'actor' = 'Dr. Alice Owner'
      order by 2 desc $$,
  $$ values (tests.user_id('ns-owner@example.test'), 2), (tests.user_id('ns-mallory@example.test'), 1) $$,
  'contributors: the viewer''s entry is counted for the viewer, not added to the owner''s two');
select is(
  (select count(distinct c ->> 'actorId')::integer
     from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
    where c ->> 'actorId' is not null),
  (select count(*)::integer
     from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
    where c ->> 'actorId' is not null),
  'contributors: an account appears once, under the name of its newest entry');
select is(
  (select c ->> 'actor'
     from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
    where c ->> 'actorId' = tests.user_id('ns-owner@example.test')::text),
  'Dr. Alice Owner',
  'contributors: the owner, who wrote one entry under another name, is listed once under the name of the newest');

-- Entries whose account is gone have no id and are summarised by name.
select is(
  (select (c ->> 'count')::integer
     from jsonb_array_elements(public.get_project_activity('proj_51000000-0000-4000-8000-000000000001') -> 'contributors') c
    where c ->> 'actorId' is null and c ->> 'actor' = 'Deleted user'), 2,
  'contributors: entries of an account that no longer exists are summarised under their stored name');

-- ===========================================================================
-- 5. None of the helpers is reachable by a client
-- ===========================================================================

select throws_ok(
  $$ select private.rename_address_snapshots(auth.uid(), 'ns-owner@example.test', 'Somebody Else') $$, '42501', null,
  'a client cannot rewrite stored names');
select throws_ok(
  $$ select private.display_name(auth.uid()) $$, '42501', null,
  'or ask for anybody''s display name');
select throws_ok(
  $$ update public.project_comments set author_name = 'Somebody Else' $$, '42501', null,
  'or write a name into a comment');
select tests.logout();

select * from finish();
rollback;
