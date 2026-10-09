-- Scholea backend 3/7: audit log (append-only) and instance settings.

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
-- Privileged actions with actor, target and before/after snapshots. No foreign
-- keys: the log outlives the users it mentions, so the actor email is a
-- snapshot taken when the row is written.
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  target_type text,
  target_id   text,
  before_data jsonb,
  after_data  jsonb,
  -- Not now(): rows written by one transaction (Auth confirms an email, sets a
  -- password and records the sign-in in one go) keep the order they happened in.
  created_at  timestamptz not null default clock_timestamp()
);

create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_target_idx  on public.audit_log (target_type, target_id);

-- Rows can be added and never changed or removed, whoever asks.
create or replace function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only: % is not allowed', tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_log_no_update_or_delete
  before update or delete on public.audit_log
  for each row execute function private.reject_mutation();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.reject_mutation();

-- The only way a row gets in. The actor email is read from the profile, never
-- passed by a caller. A null actor means the instance owner acted from SQL.
create or replace function private.write_audit(
  p_actor_id    uuid,
  p_action      text,
  p_target_type text  default null,
  p_target_id   text  default null,
  p_before      jsonb default null,
  p_after       jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if p_actor_id is not null then
    select p.email into v_email from public.profiles p where p.id = p_actor_id;
  end if;
  insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, before_data, after_data)
  values (p_actor_id, v_email, p_action, p_target_type, p_target_id, p_before, p_after);
end
$$;

-- ---------------------------------------------------------------------------
-- Instance settings (one row)
-- ---------------------------------------------------------------------------
-- The allow-list of study types: null means every type, otherwise at least one
-- id, each ^[a-z0-9-]{1,64}$. Only the format is checked, because the registry
-- of study types lives in the client.
create or replace function private.valid_study_types(p_ids text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ids is null
      or (coalesce(array_ndims(p_ids), 0) = 1
          and not exists (select 1
                            from unnest(p_ids) as t (id)
                           where t.id is null or t.id !~ '^[a-z0-9-]{1,64}$'));
$$;

-- What an administrator can change for signed-in users: organisation name,
-- support contact, accent colour and the study types offered for new projects.
-- There are no shared API keys: everyone uses their own.
create table public.instance_settings (
  id                  smallint primary key default 1 check (id = 1),
  org_name            text not null default 'Scholea' check (char_length(org_name) <= 200),
  support_email       text not null default '' check (char_length(support_email) <= 320),
  footer_contact      text not null default '' check (char_length(footer_contact) <= 500),
  -- '' means the stock palette; otherwise lowercase #rrggbb.
  accent              text not null default '' check (accent = '' or accent ~ '^#[0-9a-f]{6}$'),
  -- null means every study type.
  enabled_study_types text[] check (private.valid_study_types(enabled_study_types)),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.profiles (id) on delete set null
);

insert into public.instance_settings (id) values (1);
