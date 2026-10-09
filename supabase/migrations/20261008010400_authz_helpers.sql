-- Scholea backend 4/7: who is calling, and are they still allowed to.
--
-- Every policy and every RPC re-checks the caller on each request. A JWT stays
-- cryptographically valid until it expires, so the helpers below also require
-- that the session it names still exists in auth.sessions. Suspension, deletion,
-- sign-out and "revoke sessions" therefore take effect on the very next request.
--
-- All of these are security definer and return facts about the caller only.

-- True while the session named in the caller's JWT still exists and belongs to them.
create or replace function private.session_is_live()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1
                   from auth.sessions s
                  where s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
                    and s.user_id = (select auth.uid()));
$$;

-- Active account, password set, live session.
create or replace function private.is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1
                   from public.profiles p
                  where p.id = (select auth.uid())
                    and p.status = 'active'
                    and not p.must_set_password)
     and private.session_is_live();
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active()
     and exists (select 1
                   from public.profiles p
                  where p.id = (select auth.uid())
                    and p.role in ('admin', 'master_admin'));
$$;

create or replace function private.is_master()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active()
     and exists (select 1
                   from public.profiles p
                  where p.id = (select auth.uid())
                    and p.role = 'master_admin');
$$;

-- First statement of every definer RPC. Returns the caller's id or raises:
--   401 unauthenticated          no caller, no profile, deleted, or session gone
--   403 account_suspended        suspended, with a session that is still live
--   403 password_reset_required  invited, password not set yet
create or replace function private.require_active()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles%rowtype;
begin
  select * into v_p from public.profiles where id = v_uid;
  if v_uid is null or not found or v_p.status = 'deleted' or not private.session_is_live() then
    perform private.fail('unauthenticated', 401);
  elsif v_p.status = 'suspended' then
    perform private.fail('account_suspended', 403);
  elsif v_p.must_set_password then
    perform private.fail('password_reset_required', 403);
  end if;
  return v_uid;
end
$$;

-- require_active(), then 403 forbidden unless the caller's instance role ranks
-- at least p_min. Returns the caller's profile row.
create or replace function private.require_role(p_min text)
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid    := private.require_active();
  v_min integer := private.role_rank(p_min);
  v_p   public.profiles%rowtype;
begin
  if v_min is null then
    raise exception 'require_role: unknown role %', coalesce(p_min, '<null>');
  end if;
  select * into v_p from public.profiles where id = v_uid;
  if not found or coalesce(private.role_rank(v_p.role), -1) < v_min then
    perform private.fail('forbidden', 403);
  end if;
  return v_p;
end
$$;
