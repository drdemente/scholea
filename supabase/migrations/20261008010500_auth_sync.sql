-- Scholea backend 5/7: keep public.profiles in step with auth.users.
--
-- Supabase Auth owns the credentials; Scholea owns role and status. Two
-- triggers on auth.users create the profile and mirror the few columns the app
-- reads (email, confirmation, password set, last sign-in, soft delete), writing
-- the matching audit rows in Auth's own transaction. The functions live in
-- "private" because functions cannot be created in the auth schema.
--
-- A failing trigger here blocks sign-ups, so every branch is covered by
-- supabase/tests/database/020_profiles_sync.test.sql.

-- ---------------------------------------------------------------------------
-- Admin intents
-- ---------------------------------------------------------------------------
-- An administrator's authorised but not yet executed Auth action. The RPC that
-- authorises an invite or an email change records the intent; the trigger that
-- sees Auth perform it consumes the intent and writes the audit row with the
-- real actor. Roles travel this way and never through user metadata.
create table private.admin_intents (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('invite', 'email_change')),
  actor_id   uuid not null references public.profiles (id) on delete cascade,
  target_id  uuid references public.profiles (id) on delete cascade,
  email      text not null check (email = lower(email)),   -- invitee, or the new address
  payload    jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
                                                            -- role, name, institution, surface
  created_at timestamptz not null default now(),
  unique (kind, email),
  -- An invite must carry a real role: the trigger writes it straight into the profile.
  constraint admin_intents_invite_role check (
    kind <> 'invite'
    or coalesce(payload ->> 'role', '') in ('researcher', 'supervisor', 'admin', 'master_admin')
  )
);

-- No API role is granted anything here. Row level security with no policy is a
-- second lock in case a grant is ever added by mistake.
alter table private.admin_intents enable row level security;

-- ---------------------------------------------------------------------------
-- New auth user -> profile
-- ---------------------------------------------------------------------------
create or replace function private.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent private.admin_intents%rowtype;
  v_meta   jsonb   := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role   text    := 'researcher';                     -- never read from metadata
  v_name   text    := left(coalesce(v_meta ->> 'name', ''), 200);
  v_inst   text    := left(coalesce(v_meta ->> 'institution', ''), 200);
  v_nopw   boolean := coalesce(new.encrypted_password, '') = '';
begin
  if v_nopw then            -- only password-less creations (invites) can consume an admin intent
    delete from private.admin_intents i
     where i.kind = 'invite'
       and i.email = lower(new.email)
       and i.created_at > now() - interval '5 minutes'
    returning * into v_intent;
    if found then
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
  end if;
  return new;
end
$$;

create trigger scholea_on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_auth_user_created();

-- ---------------------------------------------------------------------------
-- Auth user changed -> profile
-- ---------------------------------------------------------------------------
create or replace function private.handle_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent    private.admin_intents%rowtype;
  v_old_email text;
  v_pending   boolean;
begin
  if new.deleted_at is not null then                    -- Auth soft delete (admin API or dashboard)
    if old.deleted_at is null then
      update public.profiles
         set status = 'deleted', email = null, updated_at = now()
       where id = new.id and status <> 'deleted';
    end if;
    return new;
  end if;

  if new.email is distinct from old.email then
    select p.email into v_old_email from public.profiles p where p.id = new.id;
    update public.profiles set email = lower(new.email), updated_at = now() where id = new.id;
    delete from private.admin_intents i
     where i.kind = 'email_change'
       and i.target_id = new.id
       and i.email = lower(new.email)
       and i.created_at > now() - interval '5 minutes'
    returning * into v_intent;
    perform private.write_audit(
      coalesce(v_intent.actor_id, new.id),
      case when v_intent.id is not null then 'admin.user_updated' else 'auth.email_changed' end,
      'user', new.id::text,
      jsonb_build_object('email', v_old_email),
      jsonb_build_object('email', lower(new.email)));
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

  if new.last_sign_in_at is not null and new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.profiles set last_login_at = new.last_sign_in_at where id = new.id;
    perform private.write_audit(new.id, 'auth.login', 'user', new.id::text, null, null);
  end if;
  return new;
end
$$;

create trigger scholea_on_auth_user_updated
  after update of email, email_confirmed_at, encrypted_password, last_sign_in_at, deleted_at
  on auth.users
  for each row execute function private.handle_auth_user_updated();
