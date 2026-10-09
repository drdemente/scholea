-- Scholea backend 16: the names stored beside comments, sign-offs and ledger entries.
--
-- Every comment, sign-off and ledger entry keeps the name its author had when
-- it was written, so it stays readable after that person is renamed or leaves.
-- Two things were wrong with those names.
--
-- 1. Somebody with no name was stored under their full email address. The
--    address then stayed readable to every member of the project, also to
--    people who joined later, and also after the account was deleted, when the
--    address is supposed to survive in the audit log only.
--    Now the stand-in for a missing name is the part of the address before the
--    "@". When an account is deleted, by whatever route, every stored name of
--    it that was taken from its address becomes "Deleted user"; when its
--    address changes, they follow the new address (the triggers of migration
--    18 do both for changes that Auth makes).
--
-- 2. A name is free text, and two people may carry the same one. The ledger
--    summary counted by name, so two members with one name were shown as one
--    contributor. It now counts by account and says which account.
--    Every comment, sign-off and ledger entry already carries the id of its
--    author; that id, never the name, says who wrote it.

-- These columns are how the rows of one account are found. They are foreign
-- keys to profiles as well, so removing a profile needs them too.
create index project_comments_author_idx  on public.project_comments (author_id);
create index project_reviews_reviewer_idx on public.project_reviews (reviewer_id);
create index project_activity_actor_idx   on public.project_activity (actor_id);

-- ---------------------------------------------------------------------------
-- display_name
-- ---------------------------------------------------------------------------
-- The name snapshotted into comments, reviews and the activity ledger: the
-- profile name, or the part of the email before the "@" when no name is set.
-- Never the whole address.
create or replace function private.display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select coalesce(nullif(btrim(p.name), ''), nullif(split_part(p.email, '@', 1), ''))
       from public.profiles p
      where p.id = p_user_id),
    '');
$$;

-- ---------------------------------------------------------------------------
-- rename_address_snapshots
-- ---------------------------------------------------------------------------
-- Replace, in everything p_user_id wrote, each stored name that was taken from
-- the address p_email (the whole address, as older rows have it, or the part
-- before the "@") with p_to. Names the person chose are left alone.
--
-- Updating a comment or a sign-off moves projects.collab_updated_at (the
-- triggers of migration 6), so clients fetch the changed names.
create or replace function private.rename_address_snapshots(p_user_id uuid, p_email text, p_to text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full  text := nullif(lower(p_email), '');
  v_local text := nullif(split_part(lower(p_email), '@', 1), '');
begin
  if p_user_id is null or v_full is null or p_to is null then
    return;
  end if;

  update public.project_comments c
     set author_name = p_to
   where c.author_id = p_user_id
     and lower(c.author_name) in (v_full, v_local)
     and c.author_name <> p_to;

  update public.project_reviews r
     set reviewer_name = p_to
   where r.reviewer_id = p_user_id
     and lower(r.reviewer_name) in (v_full, v_local)
     and r.reviewer_name <> p_to;

  update public.project_activity a
     set actor_name = p_to
   where a.actor_id = p_user_id
     and lower(a.actor_name) in (v_full, v_local)
     and a.actor_name <> p_to;
end
$$;

-- A profile that is removed outright (the instance owner deletes the Auth user
-- for good, which takes the profile with it) leaves what it wrote behind
-- without an author. The names follow the same rule as for any other delete.
create or replace function private.scrub_names_of_removed_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.rename_address_snapshots(old.id, old.email, 'Deleted user');
  return old;
end
$$;

-- Runs after profiles_guard_last_master (triggers fire in name order), so a
-- delete that the guard refuses changes nothing.
create trigger profiles_scrub_names
  before delete on public.profiles
  for each row execute function private.scrub_names_of_removed_profile();

-- ---------------------------------------------------------------------------
-- admin_soft_delete_user
-- ---------------------------------------------------------------------------
-- As before (migration 12): delete an account while keeping its row, so audit
-- entries, comments and ledger entries that mention it stay meaningful. The
-- profile is marked deleted, loses its email and its sessions. Not reversible.
-- Returns {ok: true}.
--
-- New: the comments, sign-offs and ledger entries the account wrote under a
-- name taken from its address now read "Deleted user". From then on the
-- address is kept only in the audit log (admin.user_deleted, or
-- master.admin_deleted on the master surface, with the email and role the
-- account had).
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

    perform private.rename_address_snapshots(p_user_id, v_target.email, 'Deleted user');

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
-- get_project_activity
-- ---------------------------------------------------------------------------
-- The contribution ledger, newest first. Returns
--   {entries:      [{id, project_id, actor_id, actor_name, action, detail, created_at}],
--    contributors: [{actor, actorId, count, lastAt}]}
-- contributors summarises the returned entries by ACCOUNT, busiest first.
-- actor is the name on that account's newest entry and actorId is the account;
-- two members who carry the same name are two contributors. (Entries whose
-- account no longer exists have no id and are summarised by name.)
-- p_limit defaults to 300 and is kept between 1 and 1000.
--
-- Security definer: clients cannot read the tables (migration 19). The
-- membership check is the 404 somebody who is not a member gets.
create or replace function public.get_project_activity(p_project_id text, p_limit integer default 300)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_active();
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);
begin
  perform private.require_member(p_project_id, v_uid);

  return (
    with e as (
      select a.id, a.project_id, a.actor_id, a.actor_name, a.action, a.detail, a.created_at
        from public.project_activity a
       where a.project_id = p_project_id
       order by a.created_at desc, a.id desc
       limit v_limit
    ), c as (
      select e.actor_id,
             (array_agg(e.actor_name order by e.created_at desc, e.id desc))[1] as actor_name,
             count(*) as n,
             max(e.created_at) as last_at
        from e
       group by e.actor_id, case when e.actor_id is null then e.actor_name end
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
                 jsonb_build_object(
                   'actor',   c.actor_name,
                   'actorId', c.actor_id,
                   'count',   c.n,
                   'lastAt',  private.to_ms(c.last_at))
                 order by c.n desc, c.last_at desc, c.actor_name, c.actor_id)
          from c), '[]'::jsonb)));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.rename_address_snapshots(uuid, text, text),
  private.scrub_names_of_removed_profile()
from public, anon, authenticated, service_role;

revoke all on function
  public.admin_soft_delete_user(uuid, text),
  public.get_project_activity(text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_soft_delete_user(uuid, text),
  public.get_project_activity(text, integer)
to authenticated;
