-- Scholea backend 7/7: row level security, policies and table grants.
--
-- Clients can read and nothing else. There is no INSERT, UPDATE or DELETE
-- policy and no write grant on any table: every write goes through a security
-- definer RPC. Tables are not FORCE ROW LEVEL SECURITY, so those functions
-- (owned by the table owner) bypass the policies by design.

alter table public.profiles            enable row level security;
alter table public.audit_log           enable row level security;
alter table public.instance_settings   enable row level security;
alter table public.projects            enable row level security;
alter table public.project_members     enable row level security;
alter table public.project_invitations enable row level security;
alter table public.project_comments    enable row level security;
alter table public.project_reviews     enable row level security;
alter table public.step_ownership      enable row level security;
alter table public.project_activity    enable row level security;

-- ---------------------------------------------------------------------------
-- Profiles, audit log, settings
-- ---------------------------------------------------------------------------
-- Unconditional on purpose: a suspended user must be able to read their own
-- status to be told why they are locked out.
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Co-members of a project cannot read each other's profile rows. Member lists
-- come from a definer RPC that returns only what a member may see.
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select private.is_admin()));

create policy audit_select_admin on public.audit_log
  for select to authenticated
  using ((select private.is_admin()));

-- Everyone else reads the public subset through get_public_instance().
create policy settings_select_admin on public.instance_settings
  for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- Projects: members only
-- ---------------------------------------------------------------------------
create policy projects_select_member on public.projects
  for select to authenticated
  using (id in (select private.my_project_ids()));

create policy members_select_member on public.project_members
  for select to authenticated
  using (project_id in (select private.my_project_ids()));

create policy comments_select_member on public.project_comments
  for select to authenticated
  using (project_id in (select private.my_project_ids()));

create policy reviews_select_member on public.project_reviews
  for select to authenticated
  using (project_id in (select private.my_project_ids()));

create policy ownership_select_member on public.step_ownership
  for select to authenticated
  using (project_id in (select private.my_project_ids()));

create policy activity_select_member on public.project_activity
  for select to authenticated
  using (project_id in (select private.my_project_ids()));

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
-- These two policies are defence in depth. The table itself is NOT granted to
-- any API role (see below), because a direct read would show the owner a
-- 'declined' status, and declining must stay silent to the inviter. Clients
-- use the invitation RPCs, which present a declined invitation as pending.

-- The invitee: pending, unexpired invitations to their own confirmed address.
create policy invitations_select_invitee on public.project_invitations
  for select to authenticated
  using (
    (select private.is_active())
    and status = 'pending'
    and expires_at > now()
    and email = (select private.current_confirmed_email())
  );

-- An owner of the project. project_members is read through its own policy
-- here, so this inherits the active-account and live-session check.
create policy invitations_select_owner on public.project_invitations
  for select to authenticated
  using (
    exists (select 1
              from public.project_members m
             where m.project_id = project_invitations.project_id
               and m.user_id = (select auth.uid())
               and m.role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- Table grants
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated, service_role;

-- authenticated: SELECT only, filtered by the policies above.
-- anon: no table access.
-- service_role: no table access. The Edge Function calls the Auth admin API
--   with it and never touches these tables, so a leaked secret key cannot read
--   projects or settings through the Data API.
grant select on
  public.profiles,
  public.audit_log,
  public.instance_settings,
  public.projects,
  public.project_members,
  public.project_comments,
  public.project_reviews,
  public.step_ownership,
  public.project_activity
to authenticated;
-- public.project_invitations: deliberately absent, see above.

-- ---------------------------------------------------------------------------
-- Function grants (private helpers)
-- ---------------------------------------------------------------------------
-- Start from nothing, whatever the default privileges were when these were created.
revoke all on all functions in schema private from public, anon, authenticated, service_role;

-- What a signed-in caller may run directly: the helpers the policies above
-- evaluate, plus the two that invoker RPCs use to shape errors and timestamps.
-- Each returns a fact about the caller only.
grant execute on function
  private.is_active(),
  private.is_admin(),
  private.is_master(),
  private.my_project_ids(),
  private.current_confirmed_email(),
  private.fail(text, integer, text),
  private.to_ms(timestamptz)
to authenticated;
