-- Scholea backend 17: the daily invitation limit counts what an account did.
--
-- An owner may make 30 new invitations in any 24 hours (migration 11). The
-- limit was counted from the invitation rows that carried the owner's id as
-- inviter at that moment, and that id is not fixed: when a second owner of the
-- project invites an address again, the row passes to them. Two owners could
-- hand rows to each other and both stay under 30 for ever. Deleting a project
-- removed its rows and the count with them.
--
-- The limit is now counted from a list that only ever grows: one row per new
-- invitation, under the account that made it. Nothing an owner can do changes
-- a row once it is written.

-- ---------------------------------------------------------------------------
-- The tally
-- ---------------------------------------------------------------------------
-- One row for every invitation an account created. Read by
-- invite_project_member() and by nothing else. A row is of no use after 24
-- hours and is removed the next time its account invites somebody.
create table private.invitation_tally (
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index invitation_tally_inviter_idx on private.invitation_tally (inviter_id, created_at);

-- No API role is granted anything here. Row level security with no policy is a
-- second lock in case a grant is ever added by mistake.
alter table private.invitation_tally enable row level security;

-- Invitations made before this migration count as before.
insert into private.invitation_tally (inviter_id, created_at)
select i.invited_by, i.created_at
  from public.project_invitations i
 where i.created_at > now() - interval '24 hours';

-- ---------------------------------------------------------------------------
-- invite_project_member
-- ---------------------------------------------------------------------------
-- As before (migration 11). Owner only. Returns {invitation: {id, project_id,
-- email, role, created_at, expires_at}}.
--
-- Inviting an address that already has an open invitation to this project
-- changes that invitation's role and inviter and returns it. Its dates do not
-- move, no second row appears, and it is not a new invitation: it does not
-- count towards anybody's daily limit, and it takes nothing off the limit of
-- the owner who made the invitation in the first place.
--
--   400 invalid_email         not an email address, or longer than 254 characters
--   400 invalid_role          not viewer, editor or supervisor (ownership is given to a member)
--   409 already_member        the address belongs to a member of this project
--   429 too_many_invitations  the project has 20 open invitations
--   429 invite_rate_limited   the caller made 30 new invitations in the last 24 hours
create or replace function public.invite_project_member(p_project_id text, p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_active();
  v_email text := lower(btrim(coalesce(p_email, ''), E' \t\n\r'));
  v_now   timestamptz := clock_timestamp();   -- not now(): invitations made in one transaction keep their order
  v_inv   public.project_invitations%rowtype;
begin
  -- Also serialises invitations per project, which makes the cap of 20 exact.
  perform private.lock_project_as_owner(p_project_id, v_uid);

  if char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    perform private.fail('invalid_email', 400);
  end if;
  if p_role is null or p_role not in ('viewer', 'editor', 'supervisor') then
    perform private.fail('invalid_role', 400);
  end if;

  -- Starts from this project's members and compares each one's address, so the
  -- work does not depend on whether the invited address is registered.
  if exists (select 1
               from public.project_members m
              where m.project_id = p_project_id
                and (select lower(p.email) from public.profiles p where p.id = m.user_id) = v_email) then
    perform private.fail('already_member', 409);
  end if;

  -- Invitations that ran out of time stop counting, and free their address.
  update public.project_invitations
     set status = 'expired'
   where project_id = p_project_id
     and status in ('pending', 'declined')
     and expires_at <= now();

  select * into v_inv
    from public.project_invitations i
   where i.project_id = p_project_id
     and i.email = v_email
     and i.status in ('pending', 'declined')
     for update;

  if found then
    -- Pending or declined, treated alike (rule 2). A declined one stays
    -- declined, so it does not come back to the person who declined it.
    update public.project_invitations
       set role = p_role, invited_by = v_uid
     where id = v_inv.id
    returning * into v_inv;
  else
    if (select count(*)
          from public.project_invitations i
         where i.project_id = p_project_id
           and i.status in ('pending', 'declined')) >= 20 then
      perform private.fail('too_many_invitations', 429);
    end if;

    -- One invitation at a time per inviter, across all their projects, so the
    -- daily count cannot be passed by inviting from two places at once.
    perform pg_advisory_xact_lock(hashtextextended('scholea:invite:' || v_uid::text, 0));
    delete from private.invitation_tally t
     where t.inviter_id = v_uid
       and t.created_at <= now() - interval '24 hours';
    if (select count(*) from private.invitation_tally t where t.inviter_id = v_uid) >= 30 then
      perform private.fail('invite_rate_limited', 429);
    end if;

    insert into public.project_invitations (project_id, email, role, invited_by, created_at, expires_at)
    values (p_project_id, v_email, p_role, v_uid, v_now, v_now + interval '30 days')
    returning * into v_inv;

    insert into private.invitation_tally (inviter_id, created_at) values (v_uid, v_now);

    -- The ledger says that someone was invited and as what, never who: every
    -- member can read it.
    perform private.log_activity(p_project_id, v_uid, 'member.invite', p_role);
  end if;

  return jsonb_build_object('invitation', jsonb_build_object(
    'id',         v_inv.id,
    'project_id', v_inv.project_id,
    'email',      v_inv.email,
    'role',       v_inv.role,
    'created_at', private.to_ms(v_inv.created_at),
    'expires_at', private.to_ms(v_inv.expires_at)));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.invite_project_member(text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.invite_project_member(text, text, text) to authenticated;
