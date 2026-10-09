-- Scholea backend 1/7: default privileges, the private schema, shared helpers.
--
-- Authorization lives in Postgres. Clients get SELECT only, guarded by row
-- level security. Every write is a security definer function in "public" that
-- checks the caller, applies the change and writes its audit or activity row in
-- the same transaction. Helpers that must not be reachable through the Data API
-- live in "private", a schema the API does not expose.

-- ---------------------------------------------------------------------------
-- Default privileges
-- ---------------------------------------------------------------------------
-- These apply to the role that runs the migrations, which is the role that owns
-- everything created below. Postgres grants EXECUTE on every new function to
-- PUBLIC unless that default is removed globally (a per-schema revoke cannot
-- remove it). From here on nothing new is callable or readable by an API role
-- unless a migration grants it by name.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Private schema
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
-- Policies and invoker functions call a few granted helpers, so signed-in
-- callers need to resolve names here. Each function is still granted one by one.
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Errors
-- ---------------------------------------------------------------------------
-- Every refusal goes through this function. PostgREST turns SQLSTATE 'PGRST'
-- into the HTTP status in "detail" and the JSON body in "message", so a client
-- sees error.code = '<snake_case_code>' together with the real status.
create or replace function private.fail(p_code text, p_status integer, p_details text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PGRST' using
    message = jsonb_build_object('code', p_code, 'message', p_code, 'details', p_details, 'hint', null)::text,
    detail  = jsonb_build_object('status', p_status, 'headers', jsonb_build_object())::text;
end
$$;

-- ---------------------------------------------------------------------------
-- Time
-- ---------------------------------------------------------------------------
-- RPCs emit epoch milliseconds under the legacy key names. Floored, so the value
-- matches what Date.getTime() gives for the same instant. The epoch of a
-- timestamptz does not depend on the session time zone, hence immutable.
create or replace function private.to_ms(p_ts timestamptz)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select floor(extract(epoch from p_ts) * 1000)::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Instance roles
-- ---------------------------------------------------------------------------
-- researcher < supervisor < admin < master_admin. Null for anything else, so a
-- caller has to decide what an unknown role means instead of getting a rank.
create or replace function private.role_rank(p_role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_role
           when 'researcher'   then 0
           when 'supervisor'   then 1
           when 'admin'        then 2
           when 'master_admin' then 3
         end;
$$;

-- Least-privilege management matrix (canManageRole in the legacy server): a
-- master admin manages anyone, an admin manages (and may assign) only
-- researcher and supervisor, nobody else manages anyone. Never null, so
-- "if not can_manage_role(...)" cannot fall through on a missing value.
create or replace function private.can_manage_role(p_actor text, p_target text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    case
      when p_actor = 'master_admin' then true
      when p_actor = 'admin'        then p_target in ('researcher', 'supervisor')
      else false
    end,
    false);
$$;
