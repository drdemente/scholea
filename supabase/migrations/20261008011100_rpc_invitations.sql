-- Scholea backend 11: project invitations.
--
-- An owner invites an email address; the person who has confirmed that address
-- accepts or declines. Accepting is the only way to join someone else's project.
--
-- Three rules shape everything below.
--
-- 1. Inviting never looks the address up. The answer, and the work done to
--    produce it, are the same whether or not the address has an account, so the
--    invite form cannot be used to find out who is registered. (The one check
--    against people is "already a member of THIS project", and an owner can
--    read that member list anyway.)
--
-- 2. Declining is silent. To the owner a declined invitation is the same as one
--    that was never answered: it stays in their list until it expires, inviting
--    the address again answers exactly as it does for a pending one, and
--    cancelling it works the same. Otherwise a decline would tell the owner
--    that the address has an account. No function below returns a status.
--
-- 3. Limits. At most 20 open invitations per project, and at most 30 new ones
--    per inviter in any 24 hours (cancelled, declined and expired ones count,
--    which is why those rows are kept). An invitation lasts 30 days.
--
-- Clients cannot read project_invitations directly; these six functions are the
-- whole surface. Scholea sends no invitation email.

-- ---------------------------------------------------------------------------
-- invite_project_member
-- ---------------------------------------------------------------------------
-- Owner only. Returns {invitation: {id, project_id, email, role, created_at,
-- expires_at}}.
--
-- Inviting an address that already has an open invitation to this project
-- changes that invitation's role and inviter and returns it. Its dates do not
-- move and no second row appears.
--
--   400 invalid_email         not an email address, or longer than 254 characters
--   400 invalid_role          not viewer, editor or supervisor (ownership is given to a member)
--   409 already_member        the address belongs to a member of this project
--   429 too_many_invitations  the project has 20 open invitations
--   429 invite_rate_limited   the caller made 30 invitations in the last 24 hours
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
    if (select count(*)
          from public.project_invitations i
         where i.invited_by = v_uid
           and i.created_at > now() - interval '24 hours') >= 30 then
      perform private.fail('invite_rate_limited', 429);
    end if;

    insert into public.project_invitations (project_id, email, role, invited_by, created_at, expires_at)
    values (p_project_id, v_email, p_role, v_uid, v_now, v_now + interval '30 days')
    returning * into v_inv;

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
-- list_project_invitations
-- ---------------------------------------------------------------------------
-- Owner only. The project's open invitations, oldest first. Returns
-- {invitations: [{id, email, role, invited_by_name, created_at, expires_at}]}.
-- There is no status in the answer: an open invitation is pending as far as the
-- owner can tell (rule 2).
create or replace function public.list_project_invitations(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  if private.require_member(p_project_id, v_uid) <> 'owner' then
    perform private.fail('forbidden', 403);
  end if;

  return jsonb_build_object('invitations', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',              i.id,
               'email',           i.email,
               'role',            i.role,
               'invited_by_name', private.display_name(i.invited_by),
               'created_at',      private.to_ms(i.created_at),
               'expires_at',      private.to_ms(i.expires_at))
             order by i.created_at, i.id)
      from public.project_invitations i
     where i.project_id = p_project_id
       and i.status in ('pending', 'declined')
       and i.expires_at > now()), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- cancel_project_invitation
-- ---------------------------------------------------------------------------
-- Owner of the invitation's project. Returns {ok: true}; cancelling an
-- invitation that is already cancelled or expired is fine too.
--
--   404 not_found  no such invitation, the caller does not own its project,
--                  or it was accepted already (remove the member instead)
create or replace function public.cancel_project_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
  v_inv public.project_invitations%rowtype;
begin
  select * into v_inv from public.project_invitations i where i.id = p_invitation_id;
  if not found then
    perform private.fail('not_found', 404);
  end if;
  -- An editor cannot see invitations, so to them this one does not exist.
  perform private.lock_project_as_owner(v_inv.project_id, v_uid, true);

  select * into v_inv from public.project_invitations i where i.id = p_invitation_id for update;
  if not found or v_inv.status = 'accepted' then
    perform private.fail('not_found', 404);
  end if;

  update public.project_invitations
     set status = 'cancelled'
   where id = v_inv.id
     and status in ('pending', 'declined');

  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- list_my_invitations
-- ---------------------------------------------------------------------------
-- The invitations waiting for the caller, newest first. Returns {invitations:
-- [{id, project_id, project_title, study_type, role, inviter_name,
-- inviter_email, created_at, expires_at}]}.
--
-- An invitation is shown only while all of this holds: it is pending and not
-- expired, it is addressed to the address the caller has CONFIRMED (read from
-- the auth record, not from the token), the inviter is still an active account
-- and still an owner of the project, and the caller is not a member already.
create or replace function public.list_my_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_active();
  v_email text := private.current_confirmed_email();
begin
  return jsonb_build_object('invitations', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',            i.id,
               'project_id',    i.project_id,
               'project_title', pr.title,
               'study_type',    pr.study_type,
               'role',          i.role,
               'inviter_name',  private.display_name(i.invited_by),
               'inviter_email', coalesce(inviter.email, ''),
               'created_at',    private.to_ms(i.created_at),
               'expires_at',    private.to_ms(i.expires_at))
             order by i.created_at desc, i.id)
      from public.project_invitations i
      join public.projects pr      on pr.id = i.project_id
      join public.profiles inviter on inviter.id = i.invited_by
     where i.email = v_email
       and i.status = 'pending'
       and i.expires_at > now()
       and inviter.status = 'active'
       and private.project_role_of(i.project_id, i.invited_by) = 'owner'
       and private.project_role_of(i.project_id, v_uid) is null), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- accept_project_invitation
-- ---------------------------------------------------------------------------
-- Join the project with the invited role. Returns {project_id, role}.
-- Accepting the same invitation again returns the same answer while the caller
-- is still a member.
--
--   404 not_found           no such invitation, or it is addressed to someone else
--   410 invitation_expired  it ran out of time
--   410 invitation_invalid  it was cancelled or declined, or the inviter is no
--                           longer an active owner of the project
create or replace function public.accept_project_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_active();
  v_email text := private.current_confirmed_email();
  v_inv   public.project_invitations%rowtype;
  v_role  text;
begin
  select * into v_inv from public.project_invitations i where i.id = p_invitation_id;
  if not found or v_email is null or v_inv.email <> v_email then
    perform private.fail('not_found', 404);
  end if;

  -- Joining changes who is on the project, so it queues with every other
  -- membership change; then the invitation is read again, for good.
  perform private.lock_project_membership(v_inv.project_id);
  select * into v_inv from public.project_invitations i where i.id = p_invitation_id for update;
  if not found or v_inv.email <> v_email then
    perform private.fail('not_found', 404);
  end if;

  v_role := private.project_role_of(v_inv.project_id, v_uid);

  if v_inv.status = 'accepted' then
    if v_role is null then                      -- accepted once, and has left since
      perform private.fail('invitation_invalid', 410);
    end if;
    return jsonb_build_object('project_id', v_inv.project_id, 'role', v_role);
  end if;

  if v_inv.status = 'expired' or (v_inv.status = 'pending' and v_inv.expires_at <= now()) then
    perform private.fail('invitation_expired', 410);
  end if;
  if v_inv.status <> 'pending'
     or not exists (select 1 from public.profiles p where p.id = v_inv.invited_by and p.status = 'active')
     or private.project_role_of(v_inv.project_id, v_inv.invited_by) is distinct from 'owner' then
    perform private.fail('invitation_invalid', 410);
  end if;

  if v_role is null then
    insert into public.project_members (project_id, user_id, role, added_by, added_at)
    values (v_inv.project_id, v_uid, v_inv.role, v_inv.invited_by, clock_timestamp());
    v_role := v_inv.role;
    perform private.log_activity(v_inv.project_id, v_uid, 'member.join', v_inv.role);
  end if;

  update public.project_invitations
     set status = 'accepted', responded_at = now()
   where id = v_inv.id;

  return jsonb_build_object('project_id', v_inv.project_id, 'role', v_role);
end
$$;

-- ---------------------------------------------------------------------------
-- decline_project_invitation
-- ---------------------------------------------------------------------------
-- Say no. Returns {ok: true}. Nothing is written to the project's ledger and
-- the owner is not told (rule 2). Declining an invitation that is already
-- declined, cancelled or expired is fine too.
--
--   404 not_found  no such invitation, it is addressed to someone else, or it
--                  was accepted already (leave the project instead)
create or replace function public.decline_project_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_inv   public.project_invitations%rowtype;
begin
  perform private.require_active();
  v_email := private.current_confirmed_email();

  select * into v_inv from public.project_invitations i where i.id = p_invitation_id for update;
  if not found or v_email is null or v_inv.email <> v_email or v_inv.status = 'accepted' then
    perform private.fail('not_found', 404);
  end if;

  update public.project_invitations
     set status = 'declined', responded_at = now()
   where id = v_inv.id
     and status = 'pending';

  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.invite_project_member(text, text, text),
  public.list_project_invitations(text),
  public.cancel_project_invitation(uuid),
  public.list_my_invitations(),
  public.accept_project_invitation(uuid),
  public.decline_project_invitation(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.invite_project_member(text, text, text),
  public.list_project_invitations(text),
  public.cancel_project_invitation(uuid),
  public.list_my_invitations(),
  public.accept_project_invitation(uuid),
  public.decline_project_invitation(uuid)
to authenticated;
