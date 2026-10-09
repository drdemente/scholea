-- Scholea backend 14: the first master admin.
--
-- A new instance has no administrator. Nothing promotes anyone automatically:
-- there is no default admin, no seeded account, and the first person to sign up
-- gets nothing for being first. The instance owner signs up in the app like
-- anyone else, confirms the address, and then runs this ONCE from the Supabase
-- SQL editor (or psql as postgres):
--
--   select private.bootstrap_master_admin('you@example.org');
--
-- It answers with a JSON object:
--   {"created": true, "userId": ..., "email": ...}
--   {"created": false, "reason": "master-exists"}
--   {"created": false, "reason": "no-active-user-with-that-email"}
--   {"created": false, "reason": "email-not-confirmed-or-password-not-set"}
--
-- p_force => true skips the "master-exists" answer. It is the way back in for
-- an instance whose only master admin lost their mailbox or was suspended:
--
--   select private.bootstrap_master_admin('you@example.org', true);
--
-- The function is in "private", which the API does not expose, and no API role
-- is granted it. It also refuses by itself when it is reached through the API,
-- in case a grant is ever added by mistake.
create or replace function private.bootstrap_master_admin(p_email text, p_force boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  -- Every Data API request logs in as "authenticator"; refuse all of them,
  -- whatever role they switch to.
  if session_user = 'authenticator'
     or current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
     or coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    raise exception 'bootstrap_master_admin: run from the SQL editor or psql as postgres'
      using errcode = '42501';
  end if;

  -- The lock the last-master guard takes, so a promotion and a removal of
  -- master admins never overlap.
  perform pg_advisory_xact_lock(hashtextextended('scholea:last_master', 0));

  if not coalesce(p_force, false)
     and exists (select 1 from public.profiles p where p.role = 'master_admin' and p.status <> 'deleted') then
    return jsonb_build_object('created', false, 'reason', 'master-exists');
  end if;

  select * into v_target
    from public.profiles p
   where lower(p.email) = lower(btrim(p_email, E' \t\n\r'))
     and p.status = 'active';
  if not found then
    return jsonb_build_object('created', false, 'reason', 'no-active-user-with-that-email');
  end if;
  if v_target.email_confirmed_at is null or v_target.must_set_password then
    return jsonb_build_object('created', false, 'reason', 'email-not-confirmed-or-password-not-set');
  end if;

  update public.profiles set role = 'master_admin', updated_at = now() where id = v_target.id;

  -- No actor: the instance owner acted from SQL.
  perform private.write_audit(
    null, 'master.provisioned', 'user', v_target.id::text,
    jsonb_build_object('role', v_target.role),
    jsonb_build_object('email', v_target.email, 'role', 'master_admin', 'forced', coalesce(p_force, false)));

  return jsonb_build_object('created', true, 'userId', v_target.id, 'email', v_target.email);
end
$$;

revoke all on function private.bootstrap_master_admin(text, boolean)
  from public, anon, authenticated, service_role, authenticator;
