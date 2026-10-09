-- Scholea backend 10: comments and supervisor sign-offs.
--
-- Any member may comment. Only a supervisor or an owner may sign a step off.
-- Author and reviewer are always the caller, and the name stored beside each
-- row is read from the caller's profile: no function takes a name or an id to
-- write on behalf of someone else.
--
-- Each write also moves projects.collab_updated_at (the triggers of migration
-- 6) and adds its ledger entry, all in the one transaction of the call.

-- ---------------------------------------------------------------------------
-- Shapes (pure functions of their argument: they read no table)
-- ---------------------------------------------------------------------------
create or replace function private.comment_json(c public.project_comments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',          c.id,
    'project_id',  c.project_id,
    'step_id',     c.step_id,
    'author_id',   c.author_id,
    'author_name', c.author_name,
    'text',        c.body,
    'created_at',  private.to_ms(c.created_at));
$$;

-- A step has one sign-off, so its id is the project id and the step id joined.
create or replace function private.review_json(r public.project_reviews)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',            r.project_id || ':' || r.step_id,
    'project_id',    r.project_id,
    'step_id',       r.step_id,
    'status',        r.status,
    'reviewer_id',   r.reviewer_id,
    'reviewer_name', r.reviewer_name,
    'note',          r.note,
    'created_at',    private.to_ms(r.created_at));
$$;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

-- Returns {comments: [{id, project_id, step_id, author_id, author_name, text,
-- created_at}]} to a member, oldest first; for one step when p_step_id is given.
--
-- Security invoker: a non-member cannot see the project row, which is the 404.
create or replace function public.list_project_comments(p_project_id text, p_step_id text default null)
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
  return jsonb_build_object('comments', coalesce((
    select jsonb_agg(private.comment_json(c) order by c.created_at, c.id)
      from public.project_comments c
     where c.project_id = p_project_id
       and (p_step_id is null or c.step_id = p_step_id)), '[]'::jsonb));
end
$$;

-- Add a comment to a step. Any member. Returns {comment}.
--
-- The client may choose the id (p_id). That makes an upload safe to repeat: when
-- the comment with that id already exists in this project and was written by
-- the caller, it is returned as it is and nothing is written, so a comment
-- whose response was lost is not posted twice.
--
--   400 invalid_input  step id not 1..200 characters, text not 1..5000
--   409 conflict       the id belongs to another comment (another project or author)
create or replace function public.add_project_comment(
  p_project_id text,
  p_step_id    text,
  p_text       text,
  p_id         uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active();
  v_row public.project_comments%rowtype;
begin
  perform private.require_member(p_project_id, v_uid);

  if p_step_id is null or char_length(p_step_id) not between 1 and 200
     or p_text is null or char_length(p_text) not between 1 and 5000 then
    perform private.fail('invalid_input', 400);
  end if;

  -- Two uploads of the same id at the same moment: the second waits here for
  -- the first to commit and then inserts nothing.
  insert into public.project_comments (id, project_id, step_id, author_id, author_name, body, created_at)
  values (coalesce(p_id, gen_random_uuid()), p_project_id, p_step_id, v_uid,
          private.display_name(v_uid), p_text, clock_timestamp())
  on conflict (id) do nothing
  returning * into v_row;

  if found then
    perform private.log_activity(p_project_id, v_uid, 'comment.add', p_step_id);
  else
    select * into v_row from public.project_comments c where c.id = p_id;
    if not found or v_row.project_id <> p_project_id or v_row.author_id is distinct from v_uid then
      perform private.fail('conflict', 409);
    end if;
  end if;

  return jsonb_build_object('comment', private.comment_json(v_row));
end
$$;

-- ---------------------------------------------------------------------------
-- Reviews (supervisor sign-off)
-- ---------------------------------------------------------------------------

-- Returns {reviews: [{id, project_id, step_id, status, reviewer_id,
-- reviewer_name, note, created_at}]} to a member.
--
-- Security invoker: a non-member cannot see the project row, which is the 404.
create or replace function public.list_project_reviews(p_project_id text)
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
  return jsonb_build_object('reviews', coalesce((
    select jsonb_agg(private.review_json(r) order by r.step_id)
      from public.project_reviews r
     where r.project_id = p_project_id), '[]'::jsonb));
end
$$;

-- Sign a step off, or ask for changes. Supervisor or owner. A step has one
-- sign-off: a new one replaces the old one, with a new time. Returns {review}.
--
--   403 forbidden      viewer or editor
--   400 invalid_input  step id not 1..200 characters, status not 'approved' or
--                      'changes', note over 2000 characters
create or replace function public.set_project_review(
  p_project_id text,
  p_step_id    text,
  p_status     text,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_active();
  v_role text := private.require_member(p_project_id, v_uid);
  v_row  public.project_reviews%rowtype;
begin
  if v_role not in ('supervisor', 'owner') then
    perform private.fail('forbidden', 403);
  end if;
  if p_step_id is null or char_length(p_step_id) not between 1 and 200
     or p_status is null or p_status not in ('approved', 'changes')
     or char_length(p_note) > 2000 then
    perform private.fail('invalid_input', 400);
  end if;

  insert into public.project_reviews (project_id, step_id, status, reviewer_id, reviewer_name, note, created_at)
  values (p_project_id, p_step_id, p_status, v_uid, private.display_name(v_uid),
          nullif(p_note, ''), clock_timestamp())
  on conflict (project_id, step_id) do update
     set status        = excluded.status,
         reviewer_id   = excluded.reviewer_id,
         reviewer_name = excluded.reviewer_name,
         note          = excluded.note,
         created_at    = excluded.created_at
  returning * into v_row;

  perform private.log_activity(
    p_project_id, v_uid,
    case when p_status = 'approved' then 'review.approve' else 'review.request_changes' end,
    p_step_id);

  return jsonb_build_object('review', private.review_json(v_row));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.comment_json(public.project_comments),
  private.review_json(public.project_reviews)
from public, anon, authenticated, service_role;

-- Pure shapers, called by the two invoker list functions above.
grant execute on function
  private.comment_json(public.project_comments),
  private.review_json(public.project_reviews)
to authenticated;

revoke all on function
  public.list_project_comments(text, text),
  public.add_project_comment(text, text, text, uuid),
  public.list_project_reviews(text),
  public.set_project_review(text, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.list_project_comments(text, text),
  public.add_project_comment(text, text, text, uuid),
  public.list_project_reviews(text),
  public.set_project_review(text, text, text, text)
to authenticated;
