-- Scholea backend 9: projects, content sync, members, step ownership, activity.
--
-- Who may do what on a project is decided by the caller's role on that project
-- (as the legacy server's project roles did), never by their instance role:
--   read, comment                any member
--   change content, title, step ownership   editor, owner
--   sign off a step              supervisor, owner
--   manage members, delete       owner
--
-- Somebody who is not a member gets 404 not_found for every project function,
-- whether or not the project exists, so a project's existence is never leaked.
--
-- Membership is created in exactly two places: create_project (the creator
-- becomes the owner) and accept_project_invitation (migration 11). There is no
-- function that adds a member by email.

-- ---------------------------------------------------------------------------
-- Private helpers (reachable only from the definer functions below)
-- ---------------------------------------------------------------------------

-- The Project object. content is never part of it: it can be megabytes, and
-- sync fetches it on its own through get_project_content(). list_my_projects()
-- builds the same keys inline for a whole list.
create or replace function private.project_json(p_project_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                 p.id,
    'title',              p.title,
    'study_type',         p.study_type,
    'owner_id',           p.owner_id,
    'rev',                p.rev,
    'content_updated_at', p.content_updated_at,
    'created_at',         private.to_ms(p.created_at),
    'updated_at',         private.to_ms(p.updated_at),
    'collab_updated_at',  private.to_ms(p.collab_updated_at))
    from public.projects p
   where p.id = p_project_id;
$$;

-- The member list of a project, oldest membership first. This is the only way
-- a member learns a co-member's email and name: profiles are not readable.
create or replace function private.project_members_json(p_project_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'project_id', m.project_id,
        'user_id',    m.user_id,
        'role',       m.role,
        'added_at',   private.to_ms(m.added_at),
        'email',      coalesce(p.email, ''),
        'name',       p.name)
      order by m.added_at, m.user_id),
    '[]'::jsonb)
    from public.project_members m
    join public.profiles p on p.id = m.user_id
   where m.project_id = p_project_id;
$$;

-- The caller's role on the project, or 404 not_found when they are not a member.
create or replace function private.require_member(p_project_id text, p_user_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_role text := private.project_role_of(p_project_id, p_user_id);
begin
  if v_role is null then
    perform private.fail('not_found', 404);
  end if;
  return v_role;
end
$$;

-- Every change to who is on a project takes this lock first, so membership
-- changes of one project happen one at a time and each one decides on roles it
-- read after the previous change was committed.
create or replace function private.lock_project_membership(p_project_id text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.projects p where p.id = p_project_id for update;
end
$$;

-- For the functions only an owner may call: 404 not_found for a non-member and
-- 403 forbidden for any other member, then the membership lock, then the same
-- check again, because the caller may have been demoted or removed while this
-- call waited for the lock. With p_hide, a member who is not an owner gets
-- not_found too (used where even the existence of the thing is owner-only).
create or replace function private.lock_project_as_owner(
  p_project_id text,
  p_user_id    uuid,
  p_hide       boolean default false
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_role text;
begin
  for i in 1 .. 2 loop
    v_role := private.project_role_of(p_project_id, p_user_id);
    if v_role is null or (p_hide and v_role <> 'owner') then
      perform private.fail('not_found', 404);
    elsif v_role <> 'owner' then
      perform private.fail('forbidden', 403);
    end if;
    if i = 1 then
      perform private.lock_project_membership(p_project_id);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- list_my_projects
-- ---------------------------------------------------------------------------
-- The projects the caller is a member of, most recently touched first, each
-- with the caller's role. Returns {projects: [Project & {role}]}.
--
-- An empty list always means "you are in no project". A caller who is not
-- allowed in gets an error instead, so a client can never mistake "suspended"
-- or "signed out" for "all my projects are gone".
--
-- Security invoker: row level security limits the rows to the caller's projects.
create or replace function public.list_my_projects()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  return jsonb_build_object('projects', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',                 p.id,
               'title',              p.title,
               'study_type',         p.study_type,
               'owner_id',           p.owner_id,
               'role',               m.role,
               'rev',                p.rev,
               'content_updated_at', p.content_updated_at,
               'created_at',         private.to_ms(p.created_at),
               'updated_at',         private.to_ms(p.updated_at),
               'collab_updated_at',  private.to_ms(p.collab_updated_at))
             order by p.updated_at desc, p.id)
      from public.project_members m
      join public.projects p on p.id = m.project_id
     where m.user_id = v_uid), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- create_project
-- ---------------------------------------------------------------------------
-- Create a project with an id chosen by the client (proj_<uuid v4, lower case>)
-- and make the caller its owner. Returns {project: Project & {role: 'owner'}}.
--
-- Safe to repeat: the client stores the id before the first attempt, so a
-- retry after a lost response sends the same id and gets the same project back.
--
--   400 invalid_input  bad id format, title not 1..300, study type not 1..100
--   409 conflict       the id is taken and the caller is not its owner
create or replace function public.create_project(p_id text, p_title text, p_study_type text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  if p_id is null
     or p_id !~ '^proj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_title is null
     or char_length(p_title) not between 1 and 300
     or p_study_type is null
     or char_length(p_study_type) not between 1 and 100 then
    perform private.fail('invalid_input', 400);
  end if;

  -- Two attempts with the same id at the same moment: the second waits here
  -- for the first to commit and then inserts nothing.
  insert into public.projects (id, title, study_type, owner_id)
  values (p_id, p_title, p_study_type, v_uid)
  on conflict (id) do nothing;

  if found then
    insert into public.project_members (project_id, user_id, role, added_by)
    values (p_id, v_uid, 'owner', v_uid);
    perform private.log_activity(p_id, v_uid, 'project.create', p_title);
  elsif private.project_role_of(p_id, v_uid) is distinct from 'owner' then
    perform private.fail('conflict', 409);
  end if;

  return jsonb_build_object(
    'project', private.project_json(p_id) || jsonb_build_object('role', 'owner'));
end
$$;

-- ---------------------------------------------------------------------------
-- get_project
-- ---------------------------------------------------------------------------
-- Returns {project: Project, role, members: [Member]} to a member.
create or replace function public.get_project(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_role text := private.require_member(p_project_id, v_uid);
begin
  return jsonb_build_object(
    'project', private.project_json(p_project_id),
    'role',    v_role,
    'members', private.project_members_json(p_project_id));
end
$$;

-- ---------------------------------------------------------------------------
-- update_project_title
-- ---------------------------------------------------------------------------
-- Editor or owner. Returns {project: Project}.
--   403 forbidden      viewer or supervisor
--   400 invalid_input  title not 1..300 characters
create or replace function public.update_project_title(p_project_id text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_role text := private.require_member(p_project_id, v_uid);
begin
  if v_role not in ('editor', 'owner') then
    perform private.fail('forbidden', 403);
  end if;
  if p_title is null or char_length(p_title) not between 1 and 300 then
    perform private.fail('invalid_input', 400);
  end if;

  update public.projects set title = p_title, updated_at = now() where id = p_project_id;
  return jsonb_build_object('project', private.project_json(p_project_id));
end
$$;

-- ---------------------------------------------------------------------------
-- delete_project
-- ---------------------------------------------------------------------------
-- Owner only. Removes the project with its members, invitations, comments,
-- reviews, step owners and activity. Returns {ok: true}.
create or replace function public.delete_project(p_project_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  perform private.lock_project_as_owner(p_project_id, v_uid);
  delete from public.projects where id = p_project_id;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- get_project_content
-- ---------------------------------------------------------------------------
-- Returns {content, rev, updatedAt} to a member. content is the JSON document
-- as a string, exactly as it was pushed (null until the first push); updatedAt
-- is the pushing client's clock in epoch milliseconds.
--
-- Security invoker: a non-member cannot see the row, which is the 404.
create or replace function public.get_project_content(p_project_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cur record;
begin
  perform private.require_active();

  select p.content, p.rev, p.content_updated_at
    into v_cur
    from public.projects p
   where p.id = p_project_id;
  if not found then
    perform private.fail('not_found', 404);
  end if;
  return jsonb_build_object('content', v_cur.content, 'rev', v_cur.rev, 'updatedAt', v_cur.content_updated_at);
end
$$;

-- ---------------------------------------------------------------------------
-- put_project_content
-- ---------------------------------------------------------------------------
-- Push the whole content document. Editor or owner.
--
-- Last writer wins, with one exception. The caller says which revision it last
-- saw (p_base_rev) and when its copy was last edited (p_updated_at, its own
-- clock). The push is refused only when BOTH hold: the server has moved past
-- that revision, and the server's copy was edited later than the caller's.
-- A refusal is returned as data, not raised, because it carries the server copy
-- the client needs in order to reconcile:
--   {ok: true,  rev}
--   {ok: false, error: 'conflict', content, rev, updatedAt}
--
-- The document is stored as the text it arrived as. It must be a JSON object
-- with an object "stepData" and an object "stepStatus" whose values are
-- {complete: boolean, needsAttention: boolean}, and at most 20 MB.
--
--   403 forbidden      viewer or supervisor
--   400 invalid_input  missing argument, negative revision or time, bad title,
--                      over 20 MB, not JSON, or not that shape
create or replace function public.put_project_content(
  p_project_id text,
  p_content    text,
  p_base_rev   integer,
  p_updated_at bigint,
  p_title      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_role text := private.require_member(p_project_id, v_uid);
  v_bs   constant text := chr(92);   -- a backslash, spelled so that no string setting can change it
  v_doc  jsonb;
  v_cur  record;
  v_rev  integer;
begin
  if v_role not in ('editor', 'owner') then
    perform private.fail('forbidden', 403);
  end if;

  if p_content is null or p_base_rev is null or p_base_rev < 0 or p_updated_at is null or p_updated_at < 0
     or (p_title is not null and char_length(p_title) not between 1 and 300)
     or octet_length(p_content) > 20 * 1024 * 1024 then
    perform private.fail('invalid_input', 400);
  end if;

  begin
    -- Is it JSON at all. The json type checks the syntax without decoding
    -- string escapes, so text with \u0000 or half of a surrogate pair passes
    -- (both occur in text extracted from PDFs, and jsonb rejects both).
    perform p_content::json;

    -- The shape is then checked on a copy in which no string escape needs
    -- decoding: every escaped backslash and every \u is replaced by two plain
    -- characters. Backslashes exist only inside strings and only as the start
    -- of an escape, so this changes what some strings say and nothing else:
    -- not the structure, and no key can turn into one of the names looked up
    -- below. Reading a key from the original instead would fail on the first
    -- \u0000 anywhere in the document, and that project could never sync again.
    v_doc := replace(replace(p_content, v_bs || v_bs, '__'), v_bs || 'u', '_u')::jsonb;
  exception when others then
    perform private.fail('invalid_input', 400);
  end;

  if jsonb_typeof(v_doc) is distinct from 'object'
     or jsonb_typeof(v_doc -> 'stepData')   is distinct from 'object'
     or jsonb_typeof(v_doc -> 'stepStatus') is distinct from 'object'
     or exists (select 1
                  from jsonb_each(v_doc -> 'stepStatus') s
                 where jsonb_typeof(s.value) is distinct from 'object'
                    or jsonb_typeof(s.value -> 'complete')       is distinct from 'boolean'
                    or jsonb_typeof(s.value -> 'needsAttention') is distinct from 'boolean') then
    perform private.fail('invalid_input', 400);
  end if;

  -- One writer at a time per project, so rev only ever goes up by one.
  select p.content, p.rev, p.content_updated_at
    into v_cur
    from public.projects p
   where p.id = p_project_id
     for update;
  if not found then
    perform private.fail('not_found', 404);
  end if;

  if v_cur.rev > p_base_rev and coalesce(v_cur.content_updated_at, 0) > p_updated_at then
    return jsonb_build_object(
      'ok', false, 'error', 'conflict',
      'content', v_cur.content, 'rev', v_cur.rev, 'updatedAt', v_cur.content_updated_at);
  end if;

  v_rev := v_cur.rev + 1;
  update public.projects
     set content            = p_content,
         rev                = v_rev,
         content_updated_at = p_updated_at,
         title              = coalesce(p_title, title),
         updated_at         = now()
   where id = p_project_id;

  perform private.log_activity(p_project_id, v_uid, 'content.sync', 'rev ' || v_rev);
  return jsonb_build_object('ok', true, 'rev', v_rev);
end
$$;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

-- Returns {members: [{project_id, user_id, role, added_at, email, name}]} to a member.
create or replace function public.list_project_members(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  perform private.require_member(p_project_id, v_uid);
  return jsonb_build_object('members', private.project_members_json(p_project_id));
end
$$;

-- Owner only. Returns {members}.
--   400 invalid_role   not viewer, editor, supervisor or owner
--   404 not_a_member   the target is not on the project
--   409 last_owner     the target is the only owner and would stop being one
create or replace function public.set_project_member_role(p_project_id text, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_active();
  v_target text;
begin
  perform private.lock_project_as_owner(p_project_id, v_uid);

  if p_role is null or p_role not in ('viewer', 'editor', 'supervisor', 'owner') then
    perform private.fail('invalid_role', 400);
  end if;

  v_target := private.project_role_of(p_project_id, p_user_id);
  if v_target is null then
    perform private.fail('not_a_member', 404);
  end if;
  if v_target = 'owner' and p_role <> 'owner' then
    perform private.assert_not_last_owner(p_project_id, p_user_id);
  end if;

  update public.project_members
     set role = p_role
   where project_id = p_project_id and user_id = p_user_id;

  return jsonb_build_object('members', private.project_members_json(p_project_id));
end
$$;

-- Owner only. The steps the removed member owned are released. Returns {ok: true}.
--   404 not_a_member   the target is not on the project
--   409 last_owner     the target is the only owner
create or replace function public.remove_project_member(p_project_id text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_active();
  v_target text;
begin
  perform private.lock_project_as_owner(p_project_id, v_uid);

  v_target := private.project_role_of(p_project_id, p_user_id);
  if v_target is null then
    perform private.fail('not_a_member', 404);
  end if;
  if v_target = 'owner' then
    perform private.assert_not_last_owner(p_project_id, p_user_id);
  end if;

  delete from public.project_members
   where project_id = p_project_id and user_id = p_user_id;

  return jsonb_build_object('ok', true);
end
$$;

-- Any member removes themselves. Returns {ok: true}.
--   409 last_owner     the caller is the only owner: hand the project over first
create or replace function public.leave_project(p_project_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
begin
  perform private.require_member(p_project_id, v_uid);      -- strangers stop here, before any lock
  perform private.lock_project_membership(p_project_id);

  if private.require_member(p_project_id, v_uid) = 'owner' then
    perform private.assert_not_last_owner(p_project_id, v_uid);
  end if;

  delete from public.project_members
   where project_id = p_project_id and user_id = v_uid;

  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Step ownership
-- ---------------------------------------------------------------------------

-- Returns {ownership: [{project_id, step_id, owner_id}]} to a member.
--
-- Security invoker: a non-member cannot see the project row, which is the 404.
create or replace function public.list_step_ownership(p_project_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  perform private.require_active();

  if not exists (select 1 from public.projects p where p.id = p_project_id) then
    perform private.fail('not_found', 404);
  end if;
  return jsonb_build_object('ownership', coalesce((
    select jsonb_agg(
             jsonb_build_object('project_id', o.project_id, 'step_id', o.step_id, 'owner_id', o.owner_id)
             order by o.step_id)
      from public.step_ownership o
     where o.project_id = p_project_id), '[]'::jsonb));
end
$$;

-- Editor or owner. Returns {ownership}, the whole list.
--   403 forbidden           viewer or supervisor
--   400 invalid_input       step id not 1..200 characters, or no owner given
--   400 owner_not_a_member  the new step owner is not on the project
create or replace function public.set_step_owner(p_project_id text, p_step_id text, p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_role text := private.require_member(p_project_id, v_uid);
begin
  if v_role not in ('editor', 'owner') then
    perform private.fail('forbidden', 403);
  end if;
  if p_step_id is null or char_length(p_step_id) not between 1 and 200 or p_owner_id is null then
    perform private.fail('invalid_input', 400);
  end if;

  -- "The step owner is a member" is a foreign key, so it holds even if that
  -- member is removed at this very moment.
  begin
    insert into public.step_ownership (project_id, step_id, owner_id)
    values (p_project_id, p_step_id, p_owner_id)
    on conflict (project_id, step_id) do update set owner_id = excluded.owner_id;
  exception when foreign_key_violation then
    perform private.fail('owner_not_a_member', 400);
  end;

  perform private.log_activity(p_project_id, v_uid, 'ownership.set', p_step_id);
  return public.list_step_ownership(p_project_id);
end
$$;

-- ---------------------------------------------------------------------------
-- get_project_activity
-- ---------------------------------------------------------------------------
-- The contribution ledger, newest first. Returns
--   {entries:      [{id, project_id, actor_id, actor_name, action, detail, created_at}],
--    contributors: [{actor, count, lastAt}]}
-- contributors summarises the returned entries by actor name, busiest first.
-- p_limit defaults to 300 and is kept between 1 and 1000.
--
-- Security invoker: a non-member cannot see the project row, which is the 404.
create or replace function public.get_project_activity(p_project_id text, p_limit integer default 300)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);
begin
  perform private.require_active();

  if not exists (select 1 from public.projects p where p.id = p_project_id) then
    perform private.fail('not_found', 404);
  end if;

  return (
    with e as (
      select a.id, a.project_id, a.actor_id, a.actor_name, a.action, a.detail, a.created_at
        from public.project_activity a
       where a.project_id = p_project_id
       order by a.created_at desc, a.id desc
       limit v_limit
    ), c as (
      select e.actor_name, count(*) as n, max(e.created_at) as last_at
        from e
       group by e.actor_name
    )
    select jsonb_build_object(
      'entries', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id',         e.id,
                   'project_id', e.project_id,
                   'actor_id',   e.actor_id,
                   'actor_name', e.actor_name,
                   'action',     e.action,
                   'detail',     e.detail,
                   'created_at', private.to_ms(e.created_at))
                 order by e.created_at desc, e.id desc)
          from e), '[]'::jsonb),
      'contributors', coalesce((
        select jsonb_agg(
                 jsonb_build_object('actor', c.actor_name, 'count', c.n, 'lastAt', private.to_ms(c.last_at))
                 order by c.n desc, c.last_at desc, c.actor_name)
          from c), '[]'::jsonb)));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.project_json(text),
  private.project_members_json(text),
  private.require_member(text, uuid),
  private.lock_project_membership(text),
  private.lock_project_as_owner(text, uuid, boolean)
from public, anon, authenticated, service_role;

revoke all on function
  public.list_my_projects(),
  public.create_project(text, text, text),
  public.get_project(text),
  public.update_project_title(text, text),
  public.delete_project(text),
  public.get_project_content(text),
  public.put_project_content(text, text, integer, bigint, text),
  public.list_project_members(text),
  public.set_project_member_role(text, uuid, text),
  public.remove_project_member(text, uuid),
  public.leave_project(text),
  public.list_step_ownership(text),
  public.set_step_owner(text, text, uuid),
  public.get_project_activity(text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.list_my_projects(),
  public.create_project(text, text, text),
  public.get_project(text),
  public.update_project_title(text, text),
  public.delete_project(text),
  public.get_project_content(text),
  public.put_project_content(text, text, integer, bigint, text),
  public.list_project_members(text),
  public.set_project_member_role(text, uuid, text),
  public.remove_project_member(text, uuid),
  public.leave_project(text),
  public.list_step_ownership(text),
  public.set_step_owner(text, text, uuid),
  public.get_project_activity(text, integer)
to authenticated;
