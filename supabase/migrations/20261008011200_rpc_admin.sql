-- Scholea backend 12: administration of accounts.
--
-- Two surfaces, as in the legacy server (its admin and master routes):
--   'admin'   an admin or a master admin; audited as admin.*
--   'master'  a master admin only;         audited as master.*
-- A surface never widens what a caller may do. It selects the minimum role and
-- the name of the audit action, and nothing else.
--
-- Who may manage whom is private.can_manage_role (the legacy canManageRole): a
-- master admin manages anyone; an admin manages, and may assign, only
-- researcher and supervisor. Acting on somebody the caller may not manage is
-- 403 forbidden; handing out a role the caller may not assign is 403
-- forbidden_role.
--
-- The last usable master admin is protected by the trigger on profiles
-- (migration 2), so no function here checks for it. A change that would remove
-- the last one raises 409 last_master_admin on every path, including the admin
-- surface, where the legacy server had no check at all.
--
-- Every change writes its audit row in the same transaction, under the legacy
-- action names.
--
-- Every function that changes something locks the caller's own profile together
-- with the account it acts on, and then looks at the caller a second time
-- (private.admin_confirm_actor). An administrator who is demoted or suspended
-- while their call waits for that lock cannot complete it.
--
-- Five of these functions exist for the Edge Function "admin", which does the
-- steps only the Auth admin API can do (send an invitation, change an email,
-- ban, soft delete): admin_begin_invite, admin_begin_email_change,
-- admin_check_user_action, admin_set_user_status and admin_soft_delete_user.
-- The Edge Function calls them with the CALLER'S token, never with the secret
-- key, so each one authorises exactly as it does when a client calls it
-- directly, which a client may.

-- ---------------------------------------------------------------------------
-- Private helpers (reachable only from the definer functions below)
-- ---------------------------------------------------------------------------

-- The address trimmed and in lower case, or null when the text is not an email
-- address. The same test the project invitations use: one @, a dot after it,
-- no spaces, at most 254 characters. Auth applies its own, stricter check when
-- it is handed the address.
create or replace function private.normalize_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when char_length(t.e) <= 254
            and t.e ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then t.e
         end
    from (select lower(btrim(coalesce(p_email, ''), E' \t\n\r'))) as t (e);
$$;

-- Called by every function that changes something, once its arguments are
-- known to be well formed: lock the administrator's own profile (and, with
-- p_also, the account about to be changed), then check that the administrator
-- is still what they were when the call began.
--
-- The caller's role was read at the start of the call. The call may then have
-- waited for these locks while another administrator demoted or suspended the
-- caller. Without this second look, two master admins demoting each other at
-- the same moment would both succeed.
--
-- The rows are locked in one statement, in id order, so two administrators
-- acting on each other queue up instead of deadlocking.
--   403 forbidden  the caller's role or status changed while the call waited
create or replace function private.admin_confirm_actor(p_actor public.profiles, p_also uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now public.profiles%rowtype;
begin
  perform 1
     from public.profiles p
    where p.id in (p_actor.id, p_also)
    order by p.id
      for update;

  select * into v_now from public.profiles p where p.id = p_actor.id;
  if not found
     or v_now.status <> 'active'
     or v_now.must_set_password
     or v_now.role is distinct from p_actor.role then
    perform private.fail('forbidden', 403);
  end if;
end
$$;

-- The account an administrator is about to act on, locked for the rest of the
-- transaction together with the administrator's own profile.
--   403 forbidden  the caller changed in the meantime (see above), or the
--                  caller's role does not manage the target's role
--   404 not_found  no such account, or it was deleted (unless p_allow_deleted)
create or replace function private.admin_target(
  p_actor         public.profiles,
  p_user_id       uuid,
  p_allow_deleted boolean default false
)
returns public.profiles
language plpgsql
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  perform private.admin_confirm_actor(p_actor, p_user_id);

  select * into v_target from public.profiles p where p.id = p_user_id;
  if not found or (v_target.status = 'deleted' and not p_allow_deleted) then
    perform private.fail('not_found', 404);
  end if;
  if not private.can_manage_role(p_actor.role, v_target.role) then
    perform private.fail('forbidden', 403);
  end if;
  return v_target;
end
$$;

-- ---------------------------------------------------------------------------
-- admin_list_users
-- ---------------------------------------------------------------------------
-- Accounts, newest first. Returns {users: [User], total}.
--
-- p_status   'active', 'suspended' or 'deleted'. Left out: everyone who is not
--            deleted.
-- p_role     one of the four instance roles. Left out: every role.
-- p_q        text to find in the email, name or institution, in any letter
--            case. It is matched as written: % and _ find themselves and are
--            not wildcards.
--
-- At most 1000 accounts are returned. total counts every account that matches,
-- so a client can tell when to ask for a narrower search.
--
--   400 invalid_input  unknown status or role, or a search text over 200 characters
--
-- Security invoker: the caller reads profiles through profiles_select_admin.
create or replace function public.admin_list_users(
  p_q      text default null,
  p_status text default null,
  p_role   text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_q      text := nullif(btrim(coalesce(p_q, ''), E' \t\n\r'), '');
  v_status text := nullif(p_status, '');
  v_role   text := nullif(p_role, '');
  v_like   text;
begin
  perform private.require_active();
  if not private.is_admin() then
    perform private.fail('forbidden', 403);
  end if;

  if v_status not in ('active', 'suspended', 'deleted')
     or v_role not in ('researcher', 'supervisor', 'admin', 'master_admin')
     or char_length(v_q) > 200 then
    perform private.fail('invalid_input', 400);
  end if;

  -- "!" is the escape character, so the pattern does not depend on how the
  -- server reads backslashes.
  v_like := '%' || replace(replace(replace(v_q, '!', '!!'), '%', '!%'), '_', '!_') || '%';

  return (
    with matched as (
      select p as u
        from public.profiles p
       where (case when v_status is null then p.status <> 'deleted' else p.status = v_status end)
         and (v_role is null or p.role = v_role)
         and (v_like is null
              or coalesce(p.email, '') ilike v_like escape '!'
              or p.name                ilike v_like escape '!'
              or p.institution         ilike v_like escape '!')
    ), page as (
      select m.u
        from matched m
       order by (m.u).created_at desc, (m.u).id
       limit 1000
    )
    select jsonb_build_object(
      'users', coalesce((
        select jsonb_agg(private.user_json(page.u) order by (page.u).created_at desc, (page.u).id)
          from page), '[]'::jsonb),
      'total', (select count(*) from matched)));
end
$$;

-- ---------------------------------------------------------------------------
-- admin_get_user
-- ---------------------------------------------------------------------------
-- Returns {user: User}.
--   404 not_found  no such account, or it was deleted
--
-- Security invoker: the caller reads profiles through profiles_select_admin.
create or replace function public.admin_get_user(p_user_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.profiles%rowtype;
begin
  perform private.require_active();
  if not private.is_admin() then
    perform private.fail('forbidden', 403);
  end if;

  select * into v_p from public.profiles p where p.id = p_user_id;
  if not found or v_p.status = 'deleted' then
    perform private.fail('not_found', 404);
  end if;
  return jsonb_build_object('user', private.user_json(v_p));
end
$$;

-- ---------------------------------------------------------------------------
-- admin_update_user
-- ---------------------------------------------------------------------------
-- Change an account's name, institution or role. p_patch is a JSON object with
-- any of the keys "name", "institution" and "role", and no other key: the email
-- is changed through admin_begin_email_change, the status through
-- admin_set_user_status. A key that is left out keeps its value. Name and
-- institution are trimmed and limited to 200 characters. Returns {user: User}.
--
-- A change is audited as admin.user_updated with the three values before and
-- after. A patch that changes nothing writes nothing.
--
--   400 invalid_input      not an object, an unknown key, a value that is not
--                          a string, or a value over 200 characters
--   404 not_found          no such account, or it was deleted
--   403 forbidden          the caller may not manage this account
--   400 invalid_role       "role" is not one of the four instance roles
--   403 forbidden_role     the caller may not assign that role
--   409 last_master_admin  the change would demote the last usable master admin
create or replace function public.admin_update_user(p_user_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype := private.require_role('admin');
  v_target public.profiles%rowtype;
  v_new    public.profiles%rowtype;
  v_name   text;
  v_inst   text;
  v_role   text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform private.fail('invalid_input', 400);
  end if;
  if exists (select 1
               from jsonb_each(p_patch) e
              where e.key not in ('name', 'institution', 'role')
                 or jsonb_typeof(e.value) <> 'string') then
    perform private.fail('invalid_input', 400);
  end if;

  v_name := btrim(p_patch ->> 'name', E' \t\n\r');
  v_inst := btrim(p_patch ->> 'institution', E' \t\n\r');
  v_role := p_patch ->> 'role';
  if char_length(v_name) > 200 or char_length(v_inst) > 200 then
    perform private.fail('invalid_input', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id);

  if v_role is not null then
    if private.role_rank(v_role) is null then
      perform private.fail('invalid_role', 400);
    end if;
    if not private.can_manage_role(v_actor.role, v_role) then
      perform private.fail('forbidden_role', 403);
    end if;
  end if;

  v_new := v_target;
  if (v_name is not null and v_name <> v_target.name)
     or (v_inst is not null and v_inst <> v_target.institution)
     or (v_role is not null and v_role <> v_target.role) then
    update public.profiles
       set name        = coalesce(v_name, name),
           institution = coalesce(v_inst, institution),
           role        = coalesce(v_role, role),      -- the guard trigger may raise 409
           updated_at  = now()
     where id = p_user_id
    returning * into v_new;

    perform private.write_audit(
      v_actor.id, 'admin.user_updated', 'user', p_user_id::text,
      jsonb_build_object('name', v_target.name, 'institution', v_target.institution, 'role', v_target.role),
      jsonb_build_object('name', v_new.name, 'institution', v_new.institution, 'role', v_new.role));
  end if;

  return jsonb_build_object('user', private.user_json(v_new));
end
$$;

-- ---------------------------------------------------------------------------
-- admin_revoke_sessions
-- ---------------------------------------------------------------------------
-- Sign an account out everywhere, at once: every policy and function checks
-- that the caller's session still exists. The person can sign in again.
-- Returns {ok: true, revoked}. Audited as admin.sessions_revoked.
--
-- Plain SQL, because the Auth admin API cannot sign a user out by id.
--
--   404 not_found  no such account, or it was deleted
--   403 forbidden  the caller may not manage this account
create or replace function public.admin_revoke_sessions(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   public.profiles%rowtype := private.require_role('admin');
  v_revoked integer;
begin
  perform private.admin_target(v_actor, p_user_id);

  -- Refresh tokens go with their session (foreign key, on delete cascade).
  with gone as (delete from auth.sessions s where s.user_id = p_user_id returning 1)
  select count(*) into v_revoked from gone;

  perform private.write_audit(
    v_actor.id, 'admin.sessions_revoked', 'user', p_user_id::text,
    null, jsonb_build_object('revoked', v_revoked));

  return jsonb_build_object('ok', true, 'revoked', v_revoked);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_begin_invite
-- ---------------------------------------------------------------------------
-- First step of inviting somebody: authorise it and record the intent. The
-- Edge Function then asks Auth to send the invitation; the trigger on
-- auth.users (migration 5) creates the profile with the role recorded here and
-- writes the audit row (admin.user_created, or master.admin_created on the
-- master surface) in Auth's own transaction. Nothing is audited here, because
-- nothing has happened yet: an intent that Auth never acts on within five
-- minutes is worth nothing.
--
-- On the master surface the role is admin (the default) or master_admin.
-- Returns {ok: true, email, role}: the address as it was recorded, which is
-- the address to invite, and the role the account will get.
--
--   400 invalid_input   unknown surface, not an email address, name or
--                       institution over 200 characters
--   400 invalid_role    not an instance role (not an admin tier role, on the
--                       master surface)
--   403 forbidden_role  the caller may not assign that role
--   409 email_taken     the address already has an account, confirmed or not
--                       (for a person who was invited before, resend instead),
--                       or an account whose delete has not finished
create or replace function public.admin_begin_invite(
  p_email       text,
  p_role        text,
  p_name        text default null,
  p_institution text default null,
  p_surface     text default 'admin'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype :=
    private.require_role(case when p_surface = 'master' then 'master_admin' else 'admin' end);
  v_email text := private.normalize_email(p_email);
  v_name  text := btrim(p_name, E' \t\n\r');
  v_inst  text := btrim(p_institution, E' \t\n\r');
  v_role  text := p_role;
begin
  if p_surface is null or p_surface not in ('admin', 'master')
     or v_email is null
     or char_length(v_name) > 200 or char_length(v_inst) > 200 then
    perform private.fail('invalid_input', 400);
  end if;

  if p_surface = 'master' then
    v_role := coalesce(v_role, 'admin');
    if v_role not in ('admin', 'master_admin') then
      perform private.fail('invalid_role', 400);
    end if;
  elsif private.role_rank(v_role) is null then
    perform private.fail('invalid_role', 400);
  end if;
  if not private.can_manage_role(v_actor.role, v_role) then
    perform private.fail('forbidden_role', 403);
  end if;

  perform private.admin_confirm_actor(v_actor);

  -- The role travels only with a brand new, password-less account. An address
  -- that already has an account would keep the role it has, so it is refused.
  -- Auth's own records are asked too: an account whose delete stopped half way
  -- has no address in its profile and still holds it in Auth.
  if exists (select 1 from public.profiles p where lower(p.email) = v_email)
     or exists (select 1 from auth.users u where lower(u.email) = v_email) then
    perform private.fail('email_taken', 409);
  end if;

  -- Intents nobody acted on in time can never be used. Clear them out.
  delete from private.admin_intents i where i.created_at <= now() - interval '5 minutes';

  insert into private.admin_intents (kind, actor_id, target_id, email, payload)
  values ('invite', v_actor.id, null, v_email,
          jsonb_strip_nulls(jsonb_build_object(
            'role',        v_role,
            'name',        nullif(v_name, ''),
            'institution', nullif(v_inst, ''),
            'surface',     p_surface)))
  on conflict (kind, email) do update
     set actor_id   = excluded.actor_id,
         target_id  = excluded.target_id,
         payload    = excluded.payload,
         created_at = now();

  return jsonb_build_object('ok', true, 'email', v_email, 'role', v_role);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_begin_email_change
-- ---------------------------------------------------------------------------
-- First step of changing somebody's email address: authorise it and record the
-- intent. The Edge Function then changes the address through the Auth admin
-- API; the trigger on auth.users copies it to the profile and writes the audit
-- row (admin.user_updated, with the address before and after) in Auth's own
-- transaction, naming the administrator recorded here.
--
-- Returns {ok: true, changed, email, emailConfirmed}. changed is false when the
-- account already has that address: there is nothing to do and no intent is
-- recorded. emailConfirmed says whether the account's current address is
-- confirmed, so the Edge Function can keep an unconfirmed account unconfirmed.
--
--   400 invalid_input  not an email address
--   404 not_found      no such account, or it was deleted
--   403 forbidden      the caller may not manage this account
--   409 email_taken    the address belongs to another account
create or replace function public.admin_begin_email_change(p_user_id uuid, p_new_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype := private.require_role('admin');
  v_email  text := private.normalize_email(p_new_email);
  v_target public.profiles%rowtype;
  v_same   boolean;
begin
  if v_email is null then
    perform private.fail('invalid_input', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id);
  v_same   := coalesce(lower(v_target.email) = v_email, false);

  if not v_same then
    -- Auth's own records are asked too, for the reason given in admin_begin_invite.
    if exists (select 1 from public.profiles p where lower(p.email) = v_email and p.id <> p_user_id)
       or exists (select 1 from auth.users u where lower(u.email) = v_email and u.id <> p_user_id) then
      perform private.fail('email_taken', 409);
    end if;

    delete from private.admin_intents i where i.created_at <= now() - interval '5 minutes';

    insert into private.admin_intents (kind, actor_id, target_id, email, payload)
    values ('email_change', v_actor.id, p_user_id, v_email, '{}'::jsonb)
    on conflict (kind, email) do update
       set actor_id   = excluded.actor_id,
           target_id  = excluded.target_id,
           payload    = excluded.payload,
           created_at = now();
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', not v_same,
    'email', v_email,
    'emailConfirmed', v_target.email_confirmed_at is not null);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_check_user_action
-- ---------------------------------------------------------------------------
-- May the caller do this to that account. Changes nothing. For the two actions
-- where the Edge Function has to call Auth BEFORE the database changes:
--   'resend_invite'  the account must still be waiting for its invitation code
--   'activate'       the ban is lifted in Auth first, then the status is set
-- Returns {ok: true, user: User}; the Edge Function needs the address to
-- resend to.
--
--   400 invalid_input  unknown action or surface
--   404 not_found      no such account, or it was deleted
--   403 forbidden      the caller may not manage this account
--   409 not_pending    resend_invite: the invitation code was used already, or
--                      the account was never invited. A person who entered the
--                      code and did not choose a password finishes through
--                      "Forgot password".
create or replace function public.admin_check_user_action(
  p_user_id uuid,
  p_action  text,
  p_surface text default 'admin'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype :=
    private.require_role(case when p_surface = 'master' then 'master_admin' else 'admin' end);
  v_target public.profiles%rowtype;
begin
  if p_surface is null or p_surface not in ('admin', 'master')
     or p_action is null or p_action not in ('resend_invite', 'activate') then
    perform private.fail('invalid_input', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id);

  if p_action = 'resend_invite'
     and (not v_target.must_set_password or v_target.email_confirmed_at is not null) then
    perform private.fail('not_pending', 409);
  end if;

  return jsonb_build_object('ok', true, 'user', private.user_json(v_target));
end
$$;

-- ---------------------------------------------------------------------------
-- admin_set_user_status
-- ---------------------------------------------------------------------------
-- Suspend or activate an account. Returns {ok: true, revokedSessions}.
--
-- Suspending deletes the account's sessions in the same transaction, so the
-- suspended person's very next request is refused. The Edge Function calls
-- this first and bans the account in Auth second: if the second step fails the
-- account is already locked out, and repeating the call finishes the job.
--
-- Audited as admin.user_suspended / admin.user_activated, or
-- master.admin_suspended / master.admin_activated on the master surface.
-- Setting the status an account already has writes nothing, except that a
-- repeated suspension still removes any session that appeared in between.
--
--   400 invalid_input      status not 'active' or 'suspended', unknown surface
--   404 not_found          no such account, or it was deleted
--   403 forbidden          the caller may not manage this account
--   409 last_master_admin  it would suspend the last usable master admin
create or replace function public.admin_set_user_status(
  p_user_id uuid,
  p_status  text,
  p_surface text default 'admin'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   public.profiles%rowtype :=
    private.require_role(case when p_surface = 'master' then 'master_admin' else 'admin' end);
  v_target  public.profiles%rowtype;
  v_changed boolean;
  v_revoked integer := 0;
begin
  if p_surface is null or p_surface not in ('admin', 'master')
     or p_status is null or p_status not in ('active', 'suspended') then
    perform private.fail('invalid_input', 400);
  end if;

  v_target  := private.admin_target(v_actor, p_user_id);
  v_changed := v_target.status <> p_status;

  if v_changed then
    update public.profiles
       set status = p_status, updated_at = now()      -- the guard trigger may raise 409
     where id = p_user_id;
  end if;

  if p_status = 'suspended' then
    with gone as (delete from auth.sessions s where s.user_id = p_user_id returning 1)
    select count(*) into v_revoked from gone;
  end if;

  if v_changed or v_revoked > 0 then
    perform private.write_audit(
      v_actor.id,
      (case when p_surface = 'master' then 'master.admin_' else 'admin.user_' end)
        || (case when p_status = 'suspended' then 'suspended' else 'activated' end),
      'user', p_user_id::text, null,
      case when p_status = 'suspended' then jsonb_build_object('revokedSessions', v_revoked) end);
  end if;

  return jsonb_build_object('ok', true, 'revokedSessions', v_revoked);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_soft_delete_user
-- ---------------------------------------------------------------------------
-- Delete an account while keeping its row, so audit entries, comments and
-- ledger entries that mention it stay meaningful. The profile is marked
-- deleted, loses its email and its sessions. Not reversible. Returns {ok: true}.
--
-- The Edge Function calls this first and soft-deletes the Auth user second,
-- which frees the address for a new account. Deleting an account that is
-- already deleted returns {ok: true} and writes nothing, so a repeated call can
-- finish a delete whose second step failed.
--
-- Audited as admin.user_deleted, or master.admin_deleted on the master surface,
-- with the email and role the account had. From then on the address is kept
-- only in the audit log.
--
--   400 invalid_input      unknown surface
--   404 not_found          no such account
--   403 forbidden          the caller may not manage this account
--   409 last_master_admin  it would delete the last usable master admin
create or replace function public.admin_soft_delete_user(p_user_id uuid, p_surface text default 'admin')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype :=
    private.require_role(case when p_surface = 'master' then 'master_admin' else 'admin' end);
  v_target public.profiles%rowtype;
begin
  if p_surface is null or p_surface not in ('admin', 'master') then
    perform private.fail('invalid_input', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id, true);

  if v_target.status <> 'deleted' then
    update public.profiles
       set status = 'deleted', email = null, updated_at = now()   -- the guard trigger may raise 409
     where id = p_user_id;

    delete from auth.sessions s where s.user_id = p_user_id;
    delete from private.admin_intents i where i.target_id = p_user_id;

    perform private.write_audit(
      v_actor.id,
      case when p_surface = 'master' then 'master.admin_deleted' else 'admin.user_deleted' end,
      'user', p_user_id::text,
      jsonb_build_object('email', v_target.email, 'role', v_target.role), null);
  end if;

  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_list_audit
-- ---------------------------------------------------------------------------
-- The audit log, newest first. Returns {entries: [{id, actorId, actorEmail,
-- action, targetType, targetId, before, after, createdAt}]}. p_limit defaults
-- to 200 and is kept between 1 and 1000.
--
-- Security invoker: the caller reads audit_log through audit_select_admin.
create or replace function public.admin_list_audit(p_limit integer default 200)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  perform private.require_active();
  if not private.is_admin() then
    perform private.fail('forbidden', 403);
  end if;

  return jsonb_build_object('entries', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',          e.id,
               'actorId',     e.actor_id,
               'actorEmail',  e.actor_email,
               'action',      e.action,
               'targetType',  e.target_type,
               'targetId',    e.target_id,
               'before',      e.before_data,
               'after',       e.after_data,
               'createdAt',   private.to_ms(e.created_at))
             order by e.created_at desc, e.id desc)
      from (select a.*
              from public.audit_log a
             order by a.created_at desc, a.id desc
             limit v_limit) e), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- master_list_admins
-- ---------------------------------------------------------------------------
-- The admin tier: admins first, then master admins, newest first within each.
-- Deleted accounts are left out. Returns {admins: [User]}.
--
-- Security invoker: the caller reads profiles through profiles_select_admin.
create or replace function public.master_list_admins()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  perform private.require_active();
  if not private.is_master() then
    perform private.fail('forbidden', 403);
  end if;

  return jsonb_build_object('admins', coalesce((
    select jsonb_agg(private.user_json(p) order by (p.role = 'master_admin'), p.created_at desc, p.id)
      from public.profiles p
     where p.role in ('admin', 'master_admin')
       and p.status <> 'deleted'), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- master_set_role
-- ---------------------------------------------------------------------------
-- Give any account any of the four instance roles. Master admin only.
-- Returns {user: User}. Audited as master.role_changed with the role before
-- and after; setting the role an account already has writes nothing.
--
--   400 invalid_role       not one of the four instance roles
--   404 not_found          no such account, or it was deleted
--   409 last_master_admin  it would demote the last usable master admin
create or replace function public.master_set_role(p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype := private.require_role('master_admin');
  v_target public.profiles%rowtype;
  v_new    public.profiles%rowtype;
begin
  if private.role_rank(p_role) is null then
    perform private.fail('invalid_role', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id);
  v_new    := v_target;

  if v_target.role <> p_role then
    update public.profiles
       set role = p_role, updated_at = now()          -- the guard trigger may raise 409
     where id = p_user_id
    returning * into v_new;

    perform private.write_audit(
      v_actor.id, 'master.role_changed', 'user', p_user_id::text,
      jsonb_build_object('role', v_target.role),
      jsonb_build_object('role', v_new.role));
  end if;

  return jsonb_build_object('user', private.user_json(v_new));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.normalize_email(text),
  private.admin_confirm_actor(public.profiles, uuid),
  private.admin_target(public.profiles, uuid, boolean)
from public, anon, authenticated, service_role;

revoke all on function
  public.admin_list_users(text, text, text),
  public.admin_get_user(uuid),
  public.admin_update_user(uuid, jsonb),
  public.admin_revoke_sessions(uuid),
  public.admin_begin_invite(text, text, text, text, text),
  public.admin_begin_email_change(uuid, text),
  public.admin_check_user_action(uuid, text, text),
  public.admin_set_user_status(uuid, text, text),
  public.admin_soft_delete_user(uuid, text),
  public.admin_list_audit(integer),
  public.master_list_admins(),
  public.master_set_role(uuid, text)
from public, anon, authenticated, service_role;

-- To signed-in callers only, and each function then checks the caller's role.
-- Not to service_role: the Edge Function calls these with the caller's token.
grant execute on function
  public.admin_list_users(text, text, text),
  public.admin_get_user(uuid),
  public.admin_update_user(uuid, jsonb),
  public.admin_revoke_sessions(uuid),
  public.admin_begin_invite(text, text, text, text, text),
  public.admin_begin_email_change(uuid, text),
  public.admin_check_user_action(uuid, text, text),
  public.admin_set_user_status(uuid, text, text),
  public.admin_soft_delete_user(uuid, text),
  public.admin_list_audit(integer),
  public.master_list_admins(),
  public.master_set_role(uuid, text)
to authenticated;
