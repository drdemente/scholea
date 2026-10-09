-- The daily invitation limit counts what an account did (migration 17).
--
-- An owner may make 30 new invitations in any 24 hours. The limit used to be
-- counted from the invitation rows that named the owner as inviter at that
-- moment. A second owner re-inviting an address takes the row over, so two
-- owners could pass rows between them and both stay under the limit for ever;
-- deleting a project made its rows, and the count, disappear.
--
-- The limit is now counted from a tally that only grows: one row per new
-- invitation, under the account that made it. 045 covers the limit itself; this
-- file covers every way of getting the allowance back early.

begin;
select plan(27);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- P1 is owned by A and B together, P2 and P3 by A alone.
select tests.create_user('il-a@example.test');
select tests.create_user('il-b@example.test');

insert into public.projects (id, title, study_type, owner_id) values
  ('proj_46000000-0000-4000-8000-000000000001', 'Shared', 'rct', tests.user_id('il-a@example.test')),
  ('proj_46000000-0000-4000-8000-000000000002', 'Second', 'rct', tests.user_id('il-a@example.test')),
  ('proj_46000000-0000-4000-8000-000000000003', 'Third',  'rct', tests.user_id('il-a@example.test'));
insert into public.project_members (project_id, user_id, role) values
  ('proj_46000000-0000-4000-8000-000000000001', tests.user_id('il-a@example.test'), 'owner'),
  ('proj_46000000-0000-4000-8000-000000000001', tests.user_id('il-b@example.test'), 'owner'),
  ('proj_46000000-0000-4000-8000-000000000002', tests.user_id('il-a@example.test'), 'owner'),
  ('proj_46000000-0000-4000-8000-000000000003', tests.user_id('il-a@example.test'), 'owner');

-- How a call ends: 'ok', or the backend's own error code.
create function pg_temp.outcome(p_sql text) returns text
language plpgsql as $$
declare
  v_state   text;
  v_message text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  if v_state = 'PGRST' then
    return v_message::jsonb ->> 'code';
  end if;
  return v_state;
end
$$;

create function pg_temp.invite(p_project integer, p_address text, p_role text default 'viewer') returns text
language sql as $$
  select pg_temp.outcome(format(
    'select public.invite_project_member(%L, %L, %L)',
    'proj_46000000-0000-4000-8000-00000000000' || p_project, p_address || '@example.test', p_role));
$$;

-- The tally of an account, read as the owner.
create function pg_temp.tally(p_email text) returns integer language sql stable security definer as $$
  select count(*)::integer from private.invitation_tally t where t.inviter_id = tests.user_id(p_email);
$$;

grant execute on function pg_temp.outcome(text), pg_temp.invite(integer, text, text), pg_temp.tally(text) to authenticated;

-- ===========================================================================
-- A makes 30 invitations: 15 on the shared project, 15 on their own
-- ===========================================================================

select tests.login_as('il-a@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(
  (select array_agg(distinct pg_temp.invite(1, 'il-shared-' || n)) from generate_series(1, 15) n), array['ok'],
  '(scene) A invites 15 addresses to the shared project');
select is(
  (select array_agg(distinct pg_temp.invite(2, 'il-second-' || n)) from generate_series(1, 15) n), array['ok'],
  '(scene) and 15 to a project of their own: 30 in all');
select is(pg_temp.tally('il-a@example.test'), 30, 'every new invitation is one row of the tally, under its maker');
select is(pg_temp.invite(3, 'il-over-1'), 'invite_rate_limited', 'the 31st is refused');

-- ===========================================================================
-- Handing rows to a second owner does not give the allowance back
-- ===========================================================================

select tests.login_as('il-b@example.test');
select is(
  (select array_agg(distinct pg_temp.invite(1, 'il-shared-' || n, 'editor')) from generate_series(1, 15) n), array['ok'],
  'B invites the same 15 addresses again: allowed, it changes their role and nothing else');
select is(pg_temp.tally('il-b@example.test'), 0,
  'taking an invitation over is not making one: nothing is added to B''s tally');

select tests.logout();
select results_eq(
  $$ select (select p.email from public.profiles p where p.id = i.invited_by), count(*)::integer
       from public.project_invitations i
      where i.project_id like 'proj_46000000-%' group by 1 order by 1 $$,
  $$ values ('il-a@example.test', 15), ('il-b@example.test', 15) $$,
  '(scene) half of the rows A made now name B as inviter, which is what used to free A''s allowance');
select is(pg_temp.tally('il-a@example.test'), 30, 'A''s tally has not moved');

select tests.resume_as('il-a@example.test');
select is(pg_temp.invite(3, 'il-over-1'), 'invite_rate_limited',
  'A is still at the limit: rows that passed to B count against the account that made them');
select is(pg_temp.invite(2, 'il-second-3', 'editor'), 'ok',
  'A can still change the role of an invitation that is open (not a new one)');
select is(pg_temp.tally('il-a@example.test'), 30, 'which adds nothing to the tally');

-- B has an allowance of their own, untouched by A's.
select tests.resume_as('il-b@example.test');
select is(pg_temp.invite(1, 'il-b-own-1'), 'ok', 'B can make a new invitation of their own');
select is(pg_temp.tally('il-b@example.test'), 1, 'and it is counted for B');

-- ===========================================================================
-- Nor does cancelling, or deleting the project
-- ===========================================================================

select tests.resume_as('il-a@example.test');
select is(
  pg_temp.outcome(format('select public.cancel_project_invitation(%L)',
    (select i ->> 'id'
       from jsonb_array_elements(public.list_project_invitations('proj_46000000-0000-4000-8000-000000000002') -> 'invitations') i
      where i ->> 'email' = 'il-second-1@example.test'))),
  'ok', '(scene) A cancels one of their invitations');
select is(pg_temp.invite(3, 'il-over-2'), 'invite_rate_limited', 'a cancelled invitation still counts');

select is(pg_temp.outcome($$ select public.delete_project('proj_46000000-0000-4000-8000-000000000002') $$), 'ok',
  '(scene) A deletes the project that held 15 of the invitations');
select tests.logout();
select is(
  (select count(*)::integer from public.project_invitations
    where project_id = 'proj_46000000-0000-4000-8000-000000000002'), 0,
  '(scene) its invitation rows are gone with it');
select is(pg_temp.tally('il-a@example.test'), 30, 'the tally is not: it does not belong to the project');
select tests.resume_as('il-a@example.test');
select is(pg_temp.invite(3, 'il-over-3'), 'invite_rate_limited',
  'deleting a project does not give the allowance back');

-- ===========================================================================
-- Only time does
-- ===========================================================================

select tests.logout();
update private.invitation_tally set created_at = created_at - interval '25 hours'
 where inviter_id = tests.user_id('il-a@example.test')
   and ctid in (select ctid from private.invitation_tally
                 where inviter_id = tests.user_id('il-a@example.test') limit 10);
select tests.resume_as('il-a@example.test');
select is(pg_temp.invite(3, 'il-next-1'), 'ok', '24 hours after an invitation was made it stops counting');
select is(pg_temp.tally('il-a@example.test'), 21,
  'and its row is removed from the tally: 20 from the last day and the new one');
select is(
  (select array_agg(distinct pg_temp.invite(3, 'il-next-' || n)) from generate_series(2, 10) n), array['ok'],
  'the ten that dropped out make room for ten new ones');
select is(pg_temp.invite(3, 'il-next-11'), 'invite_rate_limited', 'and then the limit holds again');

-- ===========================================================================
-- The tally is the backend's own
-- ===========================================================================

select throws_ok($$ select * from private.invitation_tally $$, '42501', null,
  'a client cannot read the tally');
select throws_ok($$ delete from private.invitation_tally $$, '42501', null,
  'or empty it');
select throws_ok(
  $$ update private.invitation_tally set created_at = now() - interval '2 days' $$, '42501', null,
  'or age it');

select tests.logout();

select * from finish();
rollback;
