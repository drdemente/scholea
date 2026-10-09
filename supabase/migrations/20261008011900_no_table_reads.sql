-- Scholea backend 19: clients read through functions only, never from a table.
--
-- Until now a signed-in client could SELECT nine tables, and row level
-- security decided which rows came back. The rows were safe. The row COUNTS
-- were not: the Data API will answer a request with the planner's estimate of
-- how many rows match (the header "Prefer: count=planned"), and the planner
-- estimates from statistics about the whole table, before any policy is
-- applied. With a few requests anybody with an account could learn how many
-- accounts, administrators, projects and comments an instance holds, whether a
-- given address appears in the audit log, and, by narrowing a filter step by
-- step, sample values of columns they may not read.
--
-- A table that cannot be selected cannot be planned, so this migration takes
-- the SELECT grants away. Everything a client reads now comes from a security
-- definer function that checks the caller first and returns only what that
-- caller may see. The policies of migration 7 stay as a second lock, in case a
-- grant is ever added back by mistake.
--
-- Two earlier migrations already switched their own function over: 15
-- (admin_list_audit) and 16 (get_project_activity).

-- ---------------------------------------------------------------------------
-- Functions whose body already names the rows the caller may read
-- ---------------------------------------------------------------------------
-- Each of these filters on the caller's own id, or checks the caller's role
-- itself before it reads, so it needs no other change: it now reads as the
-- owner of the tables instead of through a policy.
alter function public.my_profile()                        security definer;
alter function public.list_my_projects()                  security definer;
alter function public.admin_list_users(text, text, text)  security definer;
alter function public.admin_get_user(uuid)                security definer;
alter function public.master_list_admins()                security definer;

-- ---------------------------------------------------------------------------
-- Functions that left "is the caller a member" to row level security
-- ---------------------------------------------------------------------------
-- They now ask it themselves. Somebody who is not a member still gets 404
-- not_found, whether or not the project exists.

-- Returns {content, rev, updatedAt} to a member (migration 9).
create or replace function public.get_project_content(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
  v_cur record;
begin
  perform private.require_member(p_project_id, v_uid);

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

-- Returns {ownership: [{project_id, step_id, owner_id}]} to a member (migration 9).
create or replace function public.list_step_ownership(p_project_id text)
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

  return jsonb_build_object('ownership', coalesce((
    select jsonb_agg(
             jsonb_build_object('project_id', o.project_id, 'step_id', o.step_id, 'owner_id', o.owner_id)
             order by o.step_id)
      from public.step_ownership o
     where o.project_id = p_project_id), '[]'::jsonb));
end
$$;

-- Returns {comments: [{id, project_id, step_id, author_id, author_name, text,
-- created_at}]} to a member, oldest first; for one step when p_step_id is given
-- (migration 10).
create or replace function public.list_project_comments(p_project_id text, p_step_id text default null)
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

  return jsonb_build_object('comments', coalesce((
    select jsonb_agg(private.comment_json(c) order by c.created_at, c.id)
      from public.project_comments c
     where c.project_id = p_project_id
       and (p_step_id is null or c.step_id = p_step_id)), '[]'::jsonb));
end
$$;

-- Returns {reviews: [{id, project_id, step_id, status, reviewer_id,
-- reviewer_name, note, created_at}]} to a member (migration 10).
create or replace function public.list_project_reviews(p_project_id text)
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

  return jsonb_build_object('reviews', coalesce((
    select jsonb_agg(private.review_json(r) order by r.step_id)
      from public.project_reviews r
     where r.project_id = p_project_id), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- my_account
-- ---------------------------------------------------------------------------
-- The caller's own account record, as the app keeps it on the device:
--   {id, email, name, institution, role, status, must_set_password, created_at}
-- or null when the account no longer exists. It replaces the direct read of
-- the caller's own profiles row.
--
-- Unlike every other function, this one answers whatever state the account is
-- in: suspended, deleted, or signed out everywhere. That is its purpose. The
-- app asks it to learn WHY it can no longer do anything, and tells the person
-- "your account was suspended" instead of failing without a reason. It says
-- nothing about anybody but the bearer of the token, and a token is all it
-- takes: the row level security policy it replaces was unconditional for the
-- same reason.
create function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                p.id,
    'email',             p.email,                          -- null once the account is deleted
    'name',              p.name,
    'institution',       p.institution,
    'role',              p.role,
    'status',            p.status,
    'must_set_password', p.must_set_password,
    'created_at',        p.created_at)
    from public.profiles p
   where p.id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.get_project_content(text),
  public.list_step_ownership(text),
  public.list_project_comments(text, text),
  public.list_project_reviews(text),
  public.my_account()
from public, anon, authenticated, service_role;

grant execute on function
  public.get_project_content(text),
  public.list_step_ownership(text),
  public.list_project_comments(text, text),
  public.list_project_reviews(text),
  public.my_account()
to authenticated;

-- The helpers that were granted so that security invoker functions could call
-- them (migrations 7, 8 and 10). No such function is left. What stays granted
-- in "private" is what the policies evaluate: is_active(), is_admin(),
-- is_master(), my_project_ids() and current_confirmed_email().
revoke execute on function
  private.require_active(),
  private.session_is_live(),
  private.fail(text, integer, text),
  private.to_ms(timestamptz),
  private.user_json(public.profiles),
  private.comment_json(public.project_comments),
  private.review_json(public.project_reviews)
from authenticated;

-- No API role may read any table. anon and service_role never could.
revoke select on
  public.profiles,
  public.audit_log,
  public.instance_settings,
  public.projects,
  public.project_members,
  public.project_comments,
  public.project_reviews,
  public.step_ownership,
  public.project_activity
from authenticated;
