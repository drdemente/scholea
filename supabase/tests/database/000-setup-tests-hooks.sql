-- Test helpers for the pgTAP suite. Runs first (file names sort) and is not a
-- migration: nothing here ever reaches a hosted project.
--
-- Run the suite with:  supabase test db
--
-- Every other file wraps its work in begin; ... rollback; so tests leave no
-- data behind. This file commits, because the files after it use what it
-- installs. It is safe to run again: everything is created or replaced in place.
--
-- Helper API (schema "tests"):
--   tests.create_user(email, role default 'researcher', password_set default true) -> uuid
--       Inserts an auth.users row the way Auth does, which fires the real
--       profile trigger. The address must end in @example.test. The password is
--       random and never known. password_set => false gives an invited account:
--       no password, email unconfirmed, must_set_password = true. Call it as the
--       test's session user, that is before login_as() or after logout().
--   tests.login_as(email)
--       Become that user as the Data API would present them: a fresh
--       auth.sessions row, request.jwt.claims with sub, role and session_id,
--       then role "authenticated". May be called while logged in as someone else.
--   tests.resume_as(email)
--       Present again the token login_as() last issued to that user, without
--       touching auth.sessions. Use it to prove a revoked or signed-out token
--       is refused.
--   tests.as_anon()
--       Become a caller with no account (role "anon").
--   tests.logout()
--       Stop impersonating: back to the session user, no claims.
--   tests.user_id(email) -> uuid
--       Callable while logged in as anyone.
--   tests.session_id() -> uuid
--       The session id in the current claims.
--   tests.throws_code(sql, code, status default null, description default null) -> TAP line
--       Passes when the statement raises the PostgREST error private.fail()
--       produces, with that code (and HTTP status when given).
--   tests._present(user_id, email, session_id)
--       Low level: present any claims as "authenticated". For tokens that
--       login_as() would never issue (unknown user, someone else's session id,
--       no session id). Call it as the session user.
--   tests.as_owner() / tests.as_client()
--       Clients cannot read any table. A test that wants to look at stored rows
--       while somebody is logged in calls as_owner() first (the claims stay,
--       the role becomes the session user) and as_client() afterwards (back to
--       the role the claims name). Never call an RPC in between: it would run
--       with the owner's privileges.
--
-- Assert what a client can do only after login_as() or as_anon(), never as the
-- table owner: the owner bypasses row level security.
--
-- A developer's database is not empty. Count only rows the test created, and
-- see 020_profiles_sync.test.sql for how to make "the only master admin" true
-- inside a transaction.

set client_min_messages = warning;

create extension if not exists pgtap with schema extensions;

create schema if not exists tests;

-- Tokens handed out by login_as(), so resume_as() can present one again.
create table if not exists tests.issued_sessions (
  user_id    uuid primary key,
  email      text not null,
  session_id uuid not null
);

create or replace function tests.create_user(
  p_email        text,
  p_role         text default 'researcher',
  p_password_set boolean default true
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if p_email is null or p_email !~ '^[^@[:space:]]+@example\.test$' then
    raise exception 'tests.create_user: test accounts use an @example.test address, got %', coalesce(p_email, '<null>');
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, invited_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
    -- A fresh random password every time; nobody ever learns it.
    case when p_password_set
         then extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 4))
         else '' end,
    case when p_password_set then now() end,
    case when p_password_set then null else now() end,
    '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

  -- The trigger always creates a researcher. Roles are never taken from the
  -- insert, so a test that needs another role sets it the way an owner would.
  if p_role is distinct from 'researcher' then
    update public.profiles set role = p_role, updated_at = now() where id = v_id;
  end if;
  return v_id;
end
$$;

create or replace function tests.user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where u.email = lower(p_email);
$$;

create or replace function tests.session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '')::uuid;
$$;

-- Set the claims and the role exactly as PostgREST does for a signed-in request.
create or replace function tests._present(p_user_id uuid, p_email text, p_session_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user_id,
    'role', 'authenticated',
    'aud', 'authenticated',
    'email', p_email,
    'session_id', p_session_id,
    'is_anonymous', false,
    'iat', extract(epoch from now())::bigint,
    'exp', extract(epoch from now())::bigint + 3600)::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

create or replace function tests.login_as(p_email text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id  uuid;
  v_sid uuid := gen_random_uuid();
begin
  perform set_config('role', 'none', true);          -- back to the session user first
  select u.id into v_id from auth.users u where u.email = lower(p_email);
  if v_id is null then
    raise exception 'tests.login_as: no user %', coalesce(p_email, '<null>');
  end if;

  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (v_sid, v_id, now(), now(), 'aal1');

  insert into tests.issued_sessions (user_id, email, session_id)
  values (v_id, lower(p_email), v_sid)
  on conflict (user_id) do update set session_id = excluded.session_id, email = excluded.email;

  perform tests._present(v_id, lower(p_email), v_sid);
end
$$;

create or replace function tests.resume_as(p_email text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_issued tests.issued_sessions%rowtype;
begin
  perform set_config('role', 'none', true);
  select * into v_issued from tests.issued_sessions s where s.email = lower(p_email);
  if not found then
    raise exception 'tests.resume_as: % has not logged in during this test', coalesce(p_email, '<null>');
  end if;
  perform tests._present(v_issued.user_id, v_issued.email, v_issued.session_id);
end
$$;

create or replace function tests.as_anon()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end
$$;

create or replace function tests.logout()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end
$$;

create or replace function tests.as_owner()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('role', 'none', true);
end
$$;

create or replace function tests.as_client()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  if v_role is null or v_role not in ('anon', 'authenticated') then
    raise exception 'tests.as_client: nobody is logged in';
  end if;
  perform set_config('role', v_role, true);
end
$$;

create or replace function tests.throws_code(
  p_sql         text,
  p_code        text,
  p_status      integer default null,
  p_description text default null
)
returns text
language plpgsql
-- No search_path pin here: the statement under test must resolve names exactly
-- as it would for the test that passed it in.
as $$
declare
  v_desc    text := coalesce(p_description,
                             'raises ' || p_code || coalesce(' (HTTP ' || p_status || ')', ''));
  v_want    text := p_code || coalesce(' (HTTP ' || p_status || ')', '');
  v_state   text;
  v_message text;
  v_detail  text;
  v_code    text;
  v_status  integer;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics
      v_state   = returned_sqlstate,
      v_message = message_text,
      v_detail  = pg_exception_detail;

    if v_state <> 'PGRST' then
      return extensions.ok(false, v_desc) || E'\n' || extensions.diag(
        '    wanted: ' || v_want || E'\n    caught: ' || v_state || ': ' || v_message);
    end if;

    begin
      v_code   := v_message::jsonb ->> 'code';
      v_status := (v_detail::jsonb ->> 'status')::integer;
    exception when others then
      return extensions.ok(false, v_desc) || E'\n' || extensions.diag(
        '    wanted: ' || v_want || E'\n    caught a PGRST error that is not JSON: ' || v_message);
    end;

    if v_code is distinct from p_code or (p_status is not null and v_status is distinct from p_status) then
      return extensions.ok(false, v_desc) || E'\n' || extensions.diag(
        '    wanted: ' || v_want || E'\n    caught: ' || coalesce(v_code, '<null>')
        || ' (HTTP ' || coalesce(v_status::text, '<null>') || ')');
    end if;
    return extensions.ok(true, v_desc);
  end;

  return extensions.ok(false, v_desc) || E'\n' || extensions.diag(
    '    wanted: ' || v_want || E'\n    caught: no error');
end
$$;

-- Tests run as anon and authenticated must be able to reach the helpers. Each
-- one runs with the caller's privileges, apart from tests.user_id().
grant usage on schema tests to anon, authenticated, service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;

begin;
select plan(1);
select ok(true, 'test helpers installed');
select * from finish();
rollback;
