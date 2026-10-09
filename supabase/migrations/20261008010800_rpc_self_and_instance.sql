-- Scholea backend 8: the caller's own profile, and what an instance shows to everyone.
--
-- From here on the migrations add the functions clients call. The rules for
-- every one of them:
--   * it lives in "public", pins search_path to empty and qualifies every name;
--   * its first step is the identity check (private.require_active(), or the
--     narrower check in my_profile() below);
--   * it is SECURITY DEFINER only when it writes, or when it must read what the
--     caller's own SELECT policies do not show. Read-only functions that return
--     the caller's own rows stay SECURITY INVOKER, so row level security does
--     the filtering and the function only shapes the output;
--   * nothing is callable until it is granted by name at the end of its file.

-- ---------------------------------------------------------------------------
-- Helpers that invoker functions need
-- ---------------------------------------------------------------------------
-- A SECURITY INVOKER function runs as "authenticated", so the identity check it
-- starts with has to be executable by that role. Both functions only report on
-- the caller: the first returns the caller's own id or raises, the second says
-- whether the session named in the caller's own token still exists.
grant execute on function private.require_active(), private.session_is_live() to authenticated;

-- The User object every RPC returns. One definition, so the self-service and
-- the admin functions cannot drift apart. A pure function of its argument: it
-- reads no table.
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
    'emailConfirmed',    p.email_confirmed_at is not null);
$$;

-- The five settings that are not secret. get_public_instance() returns them to
-- anyone; the admin settings functions return the same object.
create or replace function private.instance_json()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'orgName',           s.org_name,
    'supportEmail',      s.support_email,
    'footerContact',     s.footer_contact,
    'accent',            s.accent,
    'enabledStudyTypes', to_jsonb(s.enabled_study_types))   -- null means every study type
    from public.instance_settings s
   where s.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- my_profile
-- ---------------------------------------------------------------------------
-- Who am I. Returns {user: User}.
--
-- This is the one function a person who has not set a password yet may call:
-- it is how the app learns that mustResetPassword is true. Everything else
-- about the caller is checked as usual:
--   401 unauthenticated    no caller, no profile, deleted, or the session is gone
--   403 account_suspended  suspended, with a session that is still live
--
-- Security invoker: the caller reads their own row through profiles_select_self.
create or replace function public.my_profile()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_p   public.profiles%rowtype;
begin
  select * into v_p from public.profiles where id = v_uid;
  if v_uid is null or not found or v_p.status = 'deleted' or not private.session_is_live() then
    perform private.fail('unauthenticated', 401);
  elsif v_p.status = 'suspended' then
    perform private.fail('account_suspended', 403);
  end if;
  return jsonb_build_object('user', private.user_json(v_p));
end
$$;

-- ---------------------------------------------------------------------------
-- update_my_profile
-- ---------------------------------------------------------------------------
-- Change your own name and institution, and nothing else. An argument that is
-- left out (null) keeps the current value; an empty string clears it. Values are
-- trimmed and limited to 200 characters. Returns {user: User}.
--
-- A change is audited as auth.profile_updated with the values before and after.
-- A call that changes nothing writes nothing.
--
--   400 invalid_input  a value is longer than 200 characters
create or replace function public.update_my_profile(
  p_name        text default null,
  p_institution text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_name text := btrim(p_name, E' \t\n\r');
  v_inst text := btrim(p_institution, E' \t\n\r');
  v_old  public.profiles%rowtype;
  v_new  public.profiles%rowtype;
begin
  if char_length(v_name) > 200 or char_length(v_inst) > 200 then
    perform private.fail('invalid_input', 400);
  end if;

  select * into v_old from public.profiles where id = v_uid for update;
  v_new := v_old;

  if (v_name is not null and v_name <> v_old.name)
     or (v_inst is not null and v_inst <> v_old.institution) then
    update public.profiles
       set name        = coalesce(v_name, name),
           institution = coalesce(v_inst, institution),
           updated_at  = now()
     where id = v_uid
    returning * into v_new;

    perform private.write_audit(
      v_uid, 'auth.profile_updated', 'user', v_uid::text,
      jsonb_build_object('name', v_old.name, 'institution', v_old.institution),
      jsonb_build_object('name', v_new.name, 'institution', v_new.institution));
  end if;

  return jsonb_build_object('user', private.user_json(v_new));
end
$$;

-- ---------------------------------------------------------------------------
-- get_public_instance
-- ---------------------------------------------------------------------------
-- The organisation name, support contact, accent colour and offered study
-- types. Returns {instance: {orgName, supportEmail, footerContact, accent,
-- enabledStudyTypes}}.
--
-- The only function in this backend with no identity check, and the only one a
-- caller without an account may run: the five values are shown to everyone who
-- opens the app. Security definer because clients cannot read the settings
-- table (only administrators can).
create or replace function public.get_public_instance()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('instance', private.instance_json());
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.user_json(public.profiles),
  private.instance_json()
from public, anon, authenticated, service_role;

-- A pure shaper, called by the invoker function above.
grant execute on function private.user_json(public.profiles) to authenticated;

revoke all on function
  public.my_profile(),
  public.update_my_profile(text, text),
  public.get_public_instance()
from public, anon, authenticated, service_role;

grant execute on function
  public.my_profile(),
  public.update_my_profile(text, text)
to authenticated;

grant execute on function public.get_public_instance() to anon, authenticated;
