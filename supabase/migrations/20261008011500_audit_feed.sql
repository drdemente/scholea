-- Scholea backend 15: the audit log stays readable however large it gets.
--
-- The audit log is the only record of who did what, and nobody can change or
-- remove a row. Reading it had one weak spot: admin_list_audit() returned the
-- newest 1000 rows and nothing older, with no way to ask for more or to filter.
-- Every account can write rows for free (a sign-in, a change of its own name),
-- so anybody could push the administrative entries out of that window and
-- leave the administrators blind.
--
-- This migration closes that in three ways:
--   * admin_list_audit() pages through the whole log, however long;
--   * it filters on the server, and p_kind => 'admin' leaves out the entries
--     accounts write about themselves, so they cannot bury the others;
--   * an account may change its own name and institution 30 times an hour.

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The administrative entries, newest first. Partial, so reading them costs the
-- same whatever the number of auth.* rows around them.
create index audit_log_admin_idx
  on public.audit_log (created_at desc, id desc)
  where action not like 'auth.%';

-- One actor's entries: the actor filter, and the hourly limit below.
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- admin_list_audit
-- ---------------------------------------------------------------------------
-- The audit log, newest first. Admin or master admin. Returns
--   {entries: [{id, actorId, actorEmail, action, targetType, targetId, before,
--               after, createdAt}],
--    nextCursor}
-- nextCursor is null on the last page. Otherwise pass it back as p_before,
-- with the same filters, to get the entries that come next (older ones).
--
--   p_limit      entries per page: 200 when left out, kept between 1 and 1000
--   p_before     a nextCursor from an earlier answer
--   p_kind       'admin' for what administrators and the instance owner did
--                (everything except auth.*), 'auth' for what accounts did to
--                themselves (auth.*: sign-ins, password and profile changes).
--                Left out: both.
--   p_action     one action name, for example 'admin.user_deleted'
--   p_done_by    entries written by this account
--   p_target_id  entries about this target (a user id, or '1' for the instance)
--   p_from       entries at or after this time, in epoch milliseconds
--   p_to         entries before this time, in epoch milliseconds
--
--   400 invalid_input  unknown kind, a cursor this function did not issue, an
--                      action or target id over 200 characters, a time that is
--                      negative or past the year 9999
--
-- Security definer: clients cannot read the audit_log table (migration 19), so
-- the role check below is the only gate.
--
-- plan_cache_mode: the filters are optional, so the query is planned for the
-- values of each call. A plan made once for every combination could not use
-- the index of the administrative entries.
drop function public.admin_list_audit(integer);

create function public.admin_list_audit(
  p_limit     integer default 200,
  p_before    text    default null,
  p_kind      text    default null,
  p_action    text    default null,
  p_done_by   uuid    default null,
  p_target_id text    default null,
  p_from      bigint  default null,
  p_to        bigint  default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_kind   text := nullif(p_kind, '');
  v_action text := nullif(p_action, '');
  v_target text := nullif(p_target_id, '');
  v_at     timestamptz;
  v_id     uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_rows   jsonb;
  v_next   text;
begin
  perform private.require_role('admin');

  if v_kind not in ('admin', 'auth')
     or char_length(v_action) > 200 or char_length(v_target) > 200
     or p_from not between 0 and 253402300799999      -- the last millisecond of the year 9999
     or p_to   not between 0 and 253402300799999 then
    perform private.fail('invalid_input', 400);
  end if;

  -- The cursor is the time (to the microsecond, in UTC) and the id of the last
  -- entry of the page before, exactly as this function wrote them.
  if nullif(p_before, '') is not null then
    if p_before !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform private.fail('invalid_input', 400);
    end if;
    begin
      v_at := split_part(p_before, '_', 1)::timestamptz;
      v_id := split_part(p_before, '_', 2)::uuid;
    exception when others then
      perform private.fail('invalid_input', 400);
    end;
  end if;

  v_from := 'epoch'::timestamptz + p_from * interval '1 millisecond';
  v_to   := 'epoch'::timestamptz + p_to   * interval '1 millisecond';

  -- One row more than asked for says whether another page exists.
  with page as (
    select a.*
      from public.audit_log a
     where (v_at is null or (a.created_at, a.id) < (v_at, v_id))
       and (v_kind is null
            or (v_kind = 'admin' and a.action not like 'auth.%')
            or (v_kind = 'auth'  and a.action like 'auth.%'))
       and (v_action   is null or a.action = v_action)
       and (p_done_by  is null or a.actor_id = p_done_by)
       and (v_target   is null or a.target_id = v_target)
       and (v_from     is null or a.created_at >= v_from)
       and (v_to       is null or a.created_at <  v_to)
     order by a.created_at desc, a.id desc
     limit v_limit + 1
  ), numbered as (
    select page.*, row_number() over (order by page.created_at desc, page.id desc) as n
      from page
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',          e.id,
             'actorId',     e.actor_id,
             'actorEmail',  e.actor_email,
             'action',      e.action,
             'targetType',  e.target_type,
             'targetId',    e.target_id,
             'before',      e.before_data,
             'after',       e.after_data,
             'createdAt',   private.to_ms(e.created_at))
           order by e.n) filter (where e.n <= v_limit), '[]'::jsonb),
         max(case when e.n = v_limit and exists (select 1 from numbered x where x.n > v_limit)
                  then to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '_' || e.id::text
             end)
    into v_rows, v_next
    from numbered e;

  return jsonb_build_object('entries', v_rows, 'nextCursor', v_next);
end
$$;

-- ---------------------------------------------------------------------------
-- update_my_profile, with an hourly limit
-- ---------------------------------------------------------------------------
-- As before (migration 8): change your own name and institution, and nothing
-- else. A change is audited as auth.profile_updated; a call that changes
-- nothing writes nothing. Returns {user: User}.
--
-- New: at most 30 changes in any hour. Each change is an audit row that can
-- never be removed, so without a limit one account could grow the log without
-- end.
--
--   400 invalid_input  a value is longer than 200 characters
--   429 rate_limited   30 changes in the last hour
create or replace function public.update_my_profile(
  p_name        text default null,
  p_institution text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_name text := btrim(p_name, E' \t\n\r');
  v_inst text := btrim(p_institution, E' \t\n\r');
  v_old  public.profiles%rowtype;
  v_new  public.profiles%rowtype;
begin
  if char_length(v_name) > 200 or char_length(v_inst) > 200 then
    perform private.fail('invalid_input', 400);
  end if;

  -- The row lock also makes the count below exact: one change at a time per account.
  select * into v_old from public.profiles where id = v_uid for update;
  v_new := v_old;

  if (v_name is not null and v_name <> v_old.name)
     or (v_inst is not null and v_inst <> v_old.institution) then
    if (select count(*)
          from public.audit_log a
         where a.actor_id = v_uid
           and a.action = 'auth.profile_updated'
           and a.created_at > clock_timestamp() - interval '1 hour') >= 30 then
      perform private.fail('rate_limited', 429);
    end if;

    update public.profiles
       set name        = coalesce(v_name, name),
           institution = coalesce(v_inst, institution),
           updated_at  = now()
     where id = v_uid
    returning * into v_new;

    perform private.write_audit(
      v_uid, 'auth.profile_updated', 'user', v_uid::text,
      jsonb_build_object('name', v_old.name, 'institution', v_old.institution),
      jsonb_build_object('name', v_new.name, 'institution', v_new.institution));
  end if;

  return jsonb_build_object('user', private.user_json(v_new));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.admin_list_audit(integer, text, text, text, uuid, text, bigint, bigint),
  public.update_my_profile(text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_list_audit(integer, text, text, text, uuid, text, bigint, bigint),
  public.update_my_profile(text, text)
to authenticated;
