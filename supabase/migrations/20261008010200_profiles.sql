-- Scholea backend 2/7: profiles and the last usable master admin guard.
--
-- One row per auth.users row, created and kept in sync by the triggers in
-- migration 5. Role and status live here and nowhere else: they are never read
-- from the JWT or from user metadata.

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              text,                                  -- null once deleted
  name               text not null default '' check (char_length(name) <= 200),
  institution        text not null default '' check (char_length(institution) <= 200),
  role               text not null default 'researcher'
                     check (role in ('researcher', 'supervisor', 'admin', 'master_admin')),
  status             text not null default 'active'
                     check (status in ('active', 'suspended', 'deleted')),
  must_set_password  boolean not null default false,        -- invited, no password yet
  email_confirmed_at timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Not unique: auth.users owns email uniqueness.
create index profiles_email_idx   on public.profiles (lower(email)) where email is not null;
create index profiles_role_idx    on public.profiles (role) where status <> 'deleted';
create index profiles_created_idx on public.profiles (created_at desc);

-- ---------------------------------------------------------------------------
-- Last usable master admin
-- ---------------------------------------------------------------------------
-- A usable master admin is active, has confirmed their email and has set a
-- password. The instance must always keep one, so demoting, suspending or
-- deleting the last one is refused. This is a table trigger, so it holds on
-- every path: both admin surfaces, the bootstrap function, and a soft or hard
-- delete of the auth user from the dashboard.
create or replace function private.guard_last_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'master_admin' and old.status = 'active' and not old.must_set_password
     and (tg_op = 'DELETE' or new.role <> 'master_admin' or new.status <> 'active') then
    -- One transaction at a time may remove a master admin, so two concurrent
    -- removals cannot each see the other as the remaining one.
    perform pg_advisory_xact_lock(hashtextextended('scholea:last_master', 0));
    if not exists (select 1
                     from public.profiles p
                    where p.id <> old.id
                      and p.role = 'master_admin'
                      and p.status = 'active'
                      and not p.must_set_password
                      and p.email_confirmed_at is not null) then
      perform private.fail('last_master_admin', 409);
    end if;
  end if;
  return coalesce(new, old);
end
$$;

create trigger profiles_guard_last_master
  before update of role, status or delete on public.profiles
  for each row execute function private.guard_last_master();
