-- Scholea backend 18: whose address is it, and who asked for the change.
--
-- Two things in the account sync (migration 5) trusted more than they should.
--
-- 1. An address an administrator typed counted as confirmed.
--    Project invitations go to whoever has CONFIRMED the invited address
--    (migration 11). An administrator's change of somebody's email takes effect
--    at once, without a code, and the account stayed "confirmed". So an
--    administrator could move an account they control onto any address, and
--    that account then saw and accepted the invitations waiting for it: a way
--    into projects that administrators are otherwise kept out of.
--
--    profiles.email_unproven now marks an address that was put there by
--    anybody but its holder. While it is set the account works as before, with
--    one exception: it has no confirmed address, so no invitation is shown to
--    it and none can be accepted. The mark is lifted when the holder types a
--    code that Auth emailed TO THAT ADDRESS (the invitation or confirmation
--    code, a password reset code, a sign-in code, or the code of their own
--    email change). A code that was sent to an earlier address of the account
--    proves nothing, although Auth goes on accepting it after the address has
--    changed.
--
-- 2. The record of who changed an address could be steered.
--    The function that authorises a change records an intent, and the trigger
--    that sees Auth make the change names the intent's author in the audit log.
--    There was one intent per address, whoever asked. An administrator could
--    therefore repoint it and drop out of the record, a person changing their
--    own address could be logged as the administrator, and one administrator
--    could overwrite another's pending invitation.
--
--    Now an intent belongs to the administrator who recorded it and nobody
--    else can touch it; the trigger tells a change the holder made from every
--    other change by what Auth wrote, not by the intents; and an intent is only
--    honoured while its author is still allowed to give it.

-- ---------------------------------------------------------------------------
-- profiles.email_unproven
-- ---------------------------------------------------------------------------
-- True while the current address was set by somebody other than its holder (an
-- administrator through the admin function, or the instance owner from the
-- dashboard) and the holder has not typed a code sent to it since.
alter table public.profiles
  add column email_unproven boolean not null default false;

-- ---------------------------------------------------------------------------
-- Admin intents: one per administrator, target and address
-- ---------------------------------------------------------------------------
-- Was: one per kind and address, so the latest caller replaced whatever was
-- there. An administrator repeating their own request still replaces their own
-- row; a different administrator, or a different target, is a different row.
alter table private.admin_intents drop constraint admin_intents_kind_email_key;

create unique index admin_intents_request_key
  on private.admin_intents (kind, actor_id, email, target_id) nulls not distinct;

-- What the triggers look intents up by.
create index admin_intents_email_idx on private.admin_intents (kind, email);

-- Did Auth email this one-time code to this address. Auth keeps, beside every
-- code it issues, the address it sent the code to (auth.one_time_tokens), and
-- that row is still there when the code is used up.
--
-- This matters because a code outlives a change of address: Auth finds a code
-- by its hash, and the hash is made from the address the code was SENT to. A
-- code mailed to the old address can therefore still be redeemed after an
-- administrator has moved the account to a new one.
--
-- If a later version of Auth keeps its codes somewhere else, this answers
-- false: nothing is proven that way any more, and nothing else breaks.
create or replace function private.code_was_sent_to(p_user_id uuid, p_token_hash text, p_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
      from auth.one_time_tokens t
     where t.user_id = p_user_id
       and t.token_hash = p_token_hash
       and lower(t.relates_to) = lower(p_email));
exception when others then
  return false;
end
$$;

-- May this administrator, as they are NOW, still give this intent. Asked at
-- the moment Auth acts on it: between recording an intent and that moment its
-- author may have been demoted, suspended or deleted.
--   p_role     the role an invitation hands out, or the role of the account
--              whose address is changed
--   p_surface  'master' for an invitation made on the master surface
create or replace function private.intent_allowed(p_actor_id uuid, p_role text, p_surface text default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles a
     where a.id = p_actor_id
       and a.status = 'active'
       and not a.must_set_password
       and a.role in ('admin', 'master_admin')
       and private.can_manage_role(a.role, p_role)
       and (p_surface is distinct from 'master' or a.role = 'master_admin'));
$$;

-- ---------------------------------------------------------------------------
-- New auth user -> profile
-- ---------------------------------------------------------------------------
-- As before (migration 5), with two changes to how an invitation finds its
-- intent. Several administrators may have asked to invite the same address in
-- the last five minutes: the one who ranks highest is used, then the newest.
-- And an intent counts only while its author may still give it; if none does,
-- the account is an ordinary researcher and the audit log says that a request
-- was turned down and whose it was.
create or replace function private.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent  private.admin_intents%rowtype;
  v_refused private.admin_intents%rowtype;
  v_meta    jsonb   := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role    text    := 'researcher';                     -- never read from metadata
  v_name    text    := left(coalesce(v_meta ->> 'name', ''), 200);
  v_inst    text    := left(coalesce(v_meta ->> 'institution', ''), 200);
  v_nopw    boolean := coalesce(new.encrypted_password, '') = '';
  r         private.admin_intents%rowtype;
begin
  if v_nopw then            -- only password-less creations (invites) can use an admin intent
    for r in
      select i.*
        from private.admin_intents i
        left join public.profiles a on a.id = i.actor_id
       where i.kind = 'invite'
         and i.email = lower(new.email)
         and i.created_at > now() - interval '5 minutes'
       order by private.role_rank(a.role) desc nulls last, i.created_at desc, i.id
    loop
      if private.intent_allowed(r.actor_id, r.payload ->> 'role', r.payload ->> 'surface') then
        v_intent := r;
        exit;
      elsif v_refused.id is null then
        v_refused := r;
      end if;
    end loop;

    -- The account exists now, so nothing that was asked for this address in
    -- the meantime can still be acted on.
    delete from private.admin_intents i
     where i.kind = 'invite'
       and i.email = lower(new.email)
       and i.created_at > now() - interval '5 minutes';

    if v_intent.id is not null then
      v_role := v_intent.payload ->> 'role';
      v_name := left(coalesce(v_intent.payload ->> 'name', v_name), 200);
      v_inst := left(coalesce(v_intent.payload ->> 'institution', v_inst), 200);
    end if;
  end if;

  insert into public.profiles (id, email, name, institution, role, must_set_password, email_confirmed_at)
  values (new.id, lower(new.email), v_name, v_inst, v_role, v_nopw, new.email_confirmed_at)
  on conflict (id) do nothing;

  if v_intent.id is not null then
    perform private.write_audit(
      v_intent.actor_id,
      case when v_intent.payload ->> 'surface' = 'master' then 'master.admin_created' else 'admin.user_created' end,
      'user', new.id::text, null,
      jsonb_build_object('email', lower(new.email), 'role', v_role, 'invited', true));
  elsif v_refused.id is not null then
    -- No actor: nobody who may still act stands behind this account.
    perform private.write_audit(
      null, 'admin.invite_role_refused', 'user', new.id::text, null,
      jsonb_build_object('email', lower(new.email), 'role', v_role, 'invited', true,
                         'requestedRole', v_refused.payload ->> 'role',
                         'requestedBy', v_refused.actor_id));
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Auth user changed -> profile
-- ---------------------------------------------------------------------------
-- As before (migration 5), except for how a new address is judged.
--
-- Who changed it. Auth writes a change the account holder made in one way
-- only: when the holder has typed the code it emailed to the new address, it
-- moves email_change into email and empties email_change, in one statement.
-- Every other change (the admin API, the dashboard, SQL) writes email alone.
-- That, and not the intents, decides between the two:
--   the holder          audited as auth.email_changed, by the account itself
--   anybody else, with a live intent of an administrator who may still manage
--   this account      audited as admin.user_updated, by that administrator
--   anybody else, with no such intent (the instance owner in the dashboard, or
--   an administrator who lost the right in the meantime)
--                       audited as admin.email_changed_unattributed, by nobody
--
-- Whether the address is proven. A change by anybody but the holder sets
-- profiles.email_unproven. It is lifted by the holder's own change of address,
-- and by a typed code: Auth uses a code up by emptying confirmation_token (a
-- sign-up or invitation code) or recovery_token (a password reset or sign-in
-- code) and then records the sign-in, in one transaction. The code counts only
-- if Auth sent it to the address the account has now (see code_was_sent_to).
-- A password change empties recovery_token as well, together with the
-- password and without a sign-in, and proves nothing about the mailbox.
--
-- The names stored beside what the account wrote follow its address, and are
-- replaced when Auth deletes the account (migration 16).
create or replace function private.handle_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile   public.profiles%rowtype;
  v_intent    private.admin_intents%rowtype;
  v_refused   private.admin_intents%rowtype;
  v_by_holder boolean;
  v_pending   boolean;
  r           private.admin_intents%rowtype;
begin
  if new.deleted_at is not null then                    -- Auth soft delete (admin API or dashboard)
    if old.deleted_at is null then
      select * into v_profile from public.profiles p where p.id = new.id;
      if found and v_profile.status <> 'deleted' then
        update public.profiles
           set status = 'deleted', email = null, updated_at = now()
         where id = new.id;
        perform private.rename_address_snapshots(new.id, v_profile.email, 'Deleted user');
      end if;
    end if;
    return new;
  end if;

  if new.email is distinct from old.email then
    select * into v_profile from public.profiles p where p.id = new.id;

    v_by_holder := coalesce(old.email_change, '') <> ''
                   and lower(old.email_change) = lower(new.email)
                   and coalesce(new.email_change, '') = '';

    -- The newest intent for exactly this change whose author may still manage
    -- this account. All intents for it are spent, whoever recorded them.
    for r in
      select i.*
        from private.admin_intents i
       where i.kind = 'email_change'
         and i.target_id = new.id
         and i.email = lower(new.email)
         and i.created_at > now() - interval '5 minutes'
       order by i.created_at desc, i.id
    loop
      if private.intent_allowed(r.actor_id, v_profile.role) then
        v_intent := r;
        exit;
      elsif v_refused.id is null then
        v_refused := r;
      end if;
    end loop;

    delete from private.admin_intents i
     where i.kind = 'email_change'
       and i.target_id = new.id
       and i.email = lower(new.email)
       and i.created_at > now() - interval '5 minutes';

    -- A profile that was deleted keeps no address, whatever Auth still does.
    if v_profile.id is not null and v_profile.status <> 'deleted' then
      update public.profiles
         set email = lower(new.email), email_unproven = not v_by_holder, updated_at = now()
       where id = new.id;
      perform private.rename_address_snapshots(new.id, v_profile.email, private.display_name(new.id));
    end if;

    if v_by_holder then
      perform private.write_audit(
        new.id, 'auth.email_changed', 'user', new.id::text,
        jsonb_build_object('email', v_profile.email),
        jsonb_build_object('email', lower(new.email)));
    elsif v_intent.id is not null then
      perform private.write_audit(
        v_intent.actor_id, 'admin.user_updated', 'user', new.id::text,
        jsonb_build_object('email', v_profile.email),
        jsonb_build_object('email', lower(new.email)));
    else
      perform private.write_audit(
        null, 'admin.email_changed_unattributed', 'user', new.id::text,
        jsonb_build_object('email', v_profile.email),
        jsonb_strip_nulls(jsonb_build_object('email', lower(new.email), 'requestedBy', v_refused.actor_id)));
    end if;
  end if;

  if new.email_confirmed_at is distinct from old.email_confirmed_at then
    update public.profiles set email_confirmed_at = new.email_confirmed_at where id = new.id;
  end if;

  -- A new password. One case does not count: while Auth verifies an invitation
  -- code it gives the invited user a random throwaway password, in the statement
  -- just before it confirms their email. Nobody knows that password, so the
  -- user has still not set one and stays behind password_reset_required.
  if coalesce(new.encrypted_password, '') <> ''
     and new.encrypted_password is distinct from old.encrypted_password
     and not (coalesce(old.encrypted_password, '') = ''
              and new.invited_at is not null
              and new.email_confirmed_at is null) then
    select p.must_set_password into v_pending from public.profiles p where p.id = new.id;
    update public.profiles set must_set_password = false, updated_at = now() where id = new.id;
    perform private.write_audit(
      new.id,
      case when v_pending then 'auth.first_login_completed' else 'auth.password_changed' end,
      'user', new.id::text, null, null);
  end if;

  -- A code that Auth had sent to the account's present address was used up (see
  -- the top of this function). It is remembered for the rest of the
  -- transaction: the sign-in that Auth records next completes the proof.
  if new.email is not distinct from old.email
     and ((coalesce(old.recovery_token, '') <> ''
           and coalesce(new.recovery_token, '') = ''
           and new.encrypted_password is not distinct from old.encrypted_password
           and private.code_was_sent_to(new.id, old.recovery_token, new.email))
          or (coalesce(old.confirmation_token, '') <> ''
              and coalesce(new.confirmation_token, '') = ''
              and private.code_was_sent_to(new.id, old.confirmation_token, new.email))) then
    perform set_config('scholea.code_typed', new.id::text, true);
  end if;

  if new.last_sign_in_at is not null and new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.profiles set last_login_at = new.last_sign_in_at where id = new.id;
    if current_setting('scholea.code_typed', true) = new.id::text then
      perform set_config('scholea.code_typed', '', true);
      update public.profiles set email_unproven = false where id = new.id and email_unproven;
    end if;
    perform private.write_audit(new.id, 'auth.login', 'user', new.id::text, null, null);
  end if;
  return new;
end
$$;

-- The two columns that hold a one-time code join the columns the trigger
-- watches. Replaced in place: dropping a trigger takes ownership of the table,
-- and auth.users belongs to Auth.
create or replace trigger scholea_on_auth_user_updated
  after update of email, email_confirmed_at, encrypted_password, last_sign_in_at, deleted_at,
                  recovery_token, confirmation_token
  on auth.users
  for each row execute function private.handle_auth_user_updated();

-- ---------------------------------------------------------------------------
-- current_confirmed_email
-- ---------------------------------------------------------------------------
-- The caller's confirmed email, read from auth.users and not from the JWT: a
-- token can carry an old address for its whole lifetime after an email change.
-- Null while the address is unconfirmed, and null while it is unproven: an
-- address somebody else typed in reads nothing.
create or replace function private.current_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email)
    from auth.users u
    join public.profiles p on p.id = u.id
   where u.id = (select auth.uid())
     and u.email_confirmed_at is not null
     and not p.email_unproven;
$$;

-- ---------------------------------------------------------------------------
-- user_json
-- ---------------------------------------------------------------------------
-- The User object every RPC returns (migration 8). emailConfirmed now means
-- what the invitations mean by it: the holder of the current address has typed
-- a code that was sent to it.
create or replace function private.user_json(p public.profiles)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                p.id,
    'email',             coalesce(p.email, ''),            -- null once the account is deleted
    'name',              p.name,
    'institution',       p.institution,
    'role',              p.role,
    'status',            p.status,
    'mustResetPassword', p.must_set_password,
    'lastLoginAt',       private.to_ms(p.last_login_at),
    'createdAt',         private.to_ms(p.created_at),
    'emailConfirmed',    p.email_confirmed_at is not null and not p.email_unproven);
$$;

-- ---------------------------------------------------------------------------
-- admin_begin_invite
-- ---------------------------------------------------------------------------
-- As before (migration 12): first step of inviting somebody. It authorises the
-- invitation and records the intent; the Edge Function then asks Auth to send
-- it, and the trigger above creates the profile with the role recorded here.
--
-- New: the intent is the caller's own. Asking again for the same address
-- replaces what the caller asked before and leaves every other
-- administrator's request alone.
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

  -- clock_timestamp(), not now(): of two requests the later one is the newer,
  -- also when one transaction makes both.
  insert into private.admin_intents (kind, actor_id, target_id, email, payload, created_at)
  values ('invite', v_actor.id, null, v_email,
          jsonb_strip_nulls(jsonb_build_object(
            'role',        v_role,
            'name',        nullif(v_name, ''),
            'institution', nullif(v_inst, ''),
            'surface',     p_surface)),
          clock_timestamp())
  on conflict (kind, actor_id, email, target_id) do update
     set payload    = excluded.payload,
         created_at = excluded.created_at;

  return jsonb_build_object('ok', true, 'email', v_email, 'role', v_role);
end
$$;

-- ---------------------------------------------------------------------------
-- admin_begin_email_change
-- ---------------------------------------------------------------------------
-- As before (migration 12): first step of changing somebody's email address.
-- It authorises the change and records the intent; the Edge Function then
-- changes the address through the Auth admin API, and the trigger above copies
-- it to the profile and writes the audit row (admin.user_updated, with the
-- address before and after), naming the administrator recorded here.
--
-- The change takes effect at once and the person stays signed in. What they do
-- not get is a confirmed address: until they type a code that was sent to the
-- new address (a password reset code will do), emailConfirmed is false for the
-- account and no project invitation addressed to the new address is shown to
-- it. Changing an address therefore hands nobody the invitations that were
-- waiting for it.
--
-- New: the intent is the caller's own, for this account and this address. A
-- second request, for another account or by another administrator, is a
-- second intent and replaces nothing.
--
-- Returns {ok: true, changed, email, emailConfirmed}. changed is false when the
-- account already has that address: there is nothing to do and no intent is
-- recorded. emailConfirmed says whether Auth holds the account's current
-- address as confirmed, so the Edge Function can keep an unconfirmed account
-- unconfirmed.
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

    insert into private.admin_intents (kind, actor_id, target_id, email, payload, created_at)
    values ('email_change', v_actor.id, p_user_id, v_email, '{}'::jsonb, clock_timestamp())
    on conflict (kind, actor_id, email, target_id) do update
       set payload    = excluded.payload,
           created_at = excluded.created_at;
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', not v_same,
    'email', v_email,
    'emailConfirmed', v_target.email_confirmed_at is not null);
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.code_was_sent_to(uuid, text, text),
  private.intent_allowed(uuid, text, text),
  private.handle_auth_user_created(),
  private.handle_auth_user_updated(),
  private.current_confirmed_email(),
  private.user_json(public.profiles)
from public, anon, authenticated, service_role;

-- Unchanged from migrations 7 and 8: a policy reads the first, the read
-- functions shaped their answer with the second.
grant execute on function
  private.current_confirmed_email(),
  private.user_json(public.profiles)
to authenticated;

revoke all on function
  public.admin_begin_invite(text, text, text, text, text),
  public.admin_begin_email_change(uuid, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_begin_invite(text, text, text, text, text),
  public.admin_begin_email_change(uuid, text)
to authenticated;
