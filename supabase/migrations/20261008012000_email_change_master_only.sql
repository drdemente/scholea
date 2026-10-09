-- Changing the email of an account that is already in use is a master-admin action.
--
-- An admin email change takes effect at once, and whoever reads the new mailbox
-- can then use "Forgot password" to get into the account. The address the
-- account had before is not told (Auth sends no notice for admin changes). That
-- makes the change an account takeover in the wrong hands, so it is limited to
-- the role that already has full control of the instance.
--
-- A plain admin can still correct the address of an account nobody can use yet:
-- an invitation whose password has not been set, or a sign-up that was never
-- confirmed. Those hold no data and no working password.
--
-- Everything else about the function is unchanged from the previous migration.

create or replace function public.admin_begin_email_change(p_user_id uuid, p_new_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.profiles%rowtype := private.require_role('admin');
  v_email  text := private.normalize_email(p_new_email);
  v_target public.profiles%rowtype;
  v_same   boolean;
begin
  if v_email is null then
    perform private.fail('invalid_input', 400);
  end if;

  v_target := private.admin_target(v_actor, p_user_id);

  -- An account in use: its holder confirmed the address and has a password.
  if v_actor.role <> 'master_admin'
     and v_target.email_confirmed_at is not null
     and not v_target.must_set_password then
    perform private.fail('forbidden', 403, 'master_admin_required');
  end if;

  v_same := coalesce(lower(v_target.email) = v_email, false);

  if not v_same then
    -- Auth's own records are asked too, for the reason given in admin_begin_invite.
    if exists (select 1 from public.profiles p where lower(p.email) = v_email and p.id <> p_user_id)
       or exists (select 1 from auth.users u where lower(u.email) = v_email and u.id <> p_user_id) then
      perform private.fail('email_taken', 409);
    end if;

    delete from private.admin_intents i where i.created_at <= now() - interval '5 minutes';

    insert into private.admin_intents (kind, actor_id, target_id, email, payload, created_at)
    values ('email_change', v_actor.id, p_user_id, v_email, '{}'::jsonb, clock_timestamp())
    on conflict (kind, actor_id, email, target_id) do update
       set payload    = excluded.payload,
           created_at = excluded.created_at;
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', not v_same,
    'email', v_email,
    'emailConfirmed', v_target.email_confirmed_at is not null);
end
$$;

comment on function public.admin_begin_email_change(uuid, text) is
  'Authorizes an admin email change and records the intent. Accounts already in use (confirmed, password set) can only be changed by a master admin.';
