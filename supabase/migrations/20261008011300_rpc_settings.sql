-- Scholea backend 13: instance settings.
--
-- What an administrator can set for everyone who signs in to this instance:
-- the organisation name, a support email, a contact line, an accent colour and
-- the study types offered for new projects. All five are shown to every
-- visitor through get_public_instance() (migration 8), so none of them is a
-- secret, and nothing here stores one: there are no shared API keys.

-- ---------------------------------------------------------------------------
-- admin_get_settings
-- ---------------------------------------------------------------------------
-- Returns {settings: {orgName, supportEmail, footerContact, accent,
-- enabledStudyTypes}}. enabledStudyTypes is null when every study type is
-- offered. Admin or master admin.
create or replace function public.admin_get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
  return jsonb_build_object('settings', private.instance_json());
end
$$;

-- ---------------------------------------------------------------------------
-- admin_update_settings
-- ---------------------------------------------------------------------------
-- Change settings. p_patch is a JSON object with any of the five keys below and
-- no other key; a key that is left out keeps its value. Returns {settings}, the
-- settings as they are now. Admin or master admin.
--
--   orgName            text, at most 200 characters
--   supportEmail       '' or an email address, at most 320 characters
--   footerContact      text, at most 500 characters
--   accent             '' for the stock palette, or a hex colour written #RGB
--                      or #RRGGBB in either letter case. It is stored as
--                      lower-case #rrggbb. The app treats it as a seed and
--                      fits its lightness for contrast, so nothing but a hex
--                      colour is ever accepted.
--   enabledStudyTypes  null to offer every study type, or a list of at least
--                      one id, each ^[a-z0-9-]{1,64}$. Only the format is
--                      checked, because the registry of study types lives in
--                      the app. Repeated ids are stored once.
--
-- Text values are trimmed. A change is audited as admin.settings_updated with
-- all five settings before and after. A patch that changes nothing writes
-- nothing.
--
--   400 invalid_input  not an object, an unknown key (shared API keys and
--                      feature toggles are not settings), or a value that
--                      breaks a rule above. The error's details name the key.
create or replace function public.admin_update_settings(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   public.profiles%rowtype := private.require_role('admin');
  v_cur     public.instance_settings%rowtype;
  v_org     text;
  v_support text;
  v_footer  text;
  v_accent  text;
  v_types   text[];
  v_key     text;
  v_before  jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform private.fail('invalid_input', 400, 'patch');
  end if;

  select k into v_key
    from jsonb_object_keys(p_patch) k
   where k not in ('orgName', 'supportEmail', 'footerContact', 'accent', 'enabledStudyTypes')
   order by k
   limit 1;
  if found then
    perform private.fail('invalid_input', 400, v_key);
  end if;

  perform private.admin_confirm_actor(v_actor);

  -- One writer at a time, and "before" is what this writer replaces.
  select * into v_cur from public.instance_settings s where s.id = 1 for update;
  v_before  := private.instance_json();
  v_org     := v_cur.org_name;
  v_support := v_cur.support_email;
  v_footer  := v_cur.footer_contact;
  v_accent  := v_cur.accent;
  v_types   := v_cur.enabled_study_types;

  if p_patch ? 'orgName' then
    v_org := btrim(p_patch ->> 'orgName', E' \t\n\r');
    if jsonb_typeof(p_patch -> 'orgName') <> 'string' or char_length(v_org) > 200 then
      perform private.fail('invalid_input', 400, 'orgName');
    end if;
  end if;

  if p_patch ? 'supportEmail' then
    v_support := btrim(p_patch ->> 'supportEmail', E' \t\n\r');
    if jsonb_typeof(p_patch -> 'supportEmail') <> 'string'
       or char_length(v_support) > 320
       or (v_support <> '' and v_support !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then
      perform private.fail('invalid_input', 400, 'supportEmail');
    end if;
  end if;

  if p_patch ? 'footerContact' then
    v_footer := btrim(p_patch ->> 'footerContact', E' \t\n\r');
    if jsonb_typeof(p_patch -> 'footerContact') <> 'string' or char_length(v_footer) > 500 then
      perform private.fail('invalid_input', 400, 'footerContact');
    end if;
  end if;

  if p_patch ? 'accent' then
    v_accent := lower(btrim(p_patch ->> 'accent', E' \t\n\r'));
    if jsonb_typeof(p_patch -> 'accent') <> 'string' then
      perform private.fail('invalid_input', 400, 'accent');
    end if;
    if v_accent ~ '^#[0-9a-f]{3}$' then                 -- #rgb is short for #rrggbb
      v_accent := '#' || substr(v_accent, 2, 1) || substr(v_accent, 2, 1)
                      || substr(v_accent, 3, 1) || substr(v_accent, 3, 1)
                      || substr(v_accent, 4, 1) || substr(v_accent, 4, 1);
    elsif v_accent <> '' and v_accent !~ '^#[0-9a-f]{6}$' then
      perform private.fail('invalid_input', 400, 'accent');
    end if;
  end if;

  if p_patch ? 'enabledStudyTypes' then
    if jsonb_typeof(p_patch -> 'enabledStudyTypes') = 'null' then
      v_types := null;
    else
      if jsonb_typeof(p_patch -> 'enabledStudyTypes') <> 'array'
         or exists (select 1
                      from jsonb_array_elements(p_patch -> 'enabledStudyTypes') e
                     where jsonb_typeof(e) <> 'string') then
        perform private.fail('invalid_input', 400, 'enabledStudyTypes');
      end if;

      -- Each id once, in the order it first appears.
      select array_agg(d.id order by d.first_at)
        into v_types
        from (select e.id, min(e.n) as first_at
                from jsonb_array_elements_text(p_patch -> 'enabledStudyTypes') with ordinality as e (id, n)
               group by e.id) d;

      -- An empty list aggregates to null, and null would mean "every type":
      -- limiting needs at least one. 100 is far above any real registry.
      if v_types is null or cardinality(v_types) > 100 or not private.valid_study_types(v_types) then
        perform private.fail('invalid_input', 400, 'enabledStudyTypes');
      end if;
    end if;
  end if;

  if v_org     is distinct from v_cur.org_name
     or v_support is distinct from v_cur.support_email
     or v_footer  is distinct from v_cur.footer_contact
     or v_accent  is distinct from v_cur.accent
     or v_types   is distinct from v_cur.enabled_study_types then
    update public.instance_settings
       set org_name            = v_org,
           support_email       = v_support,
           footer_contact      = v_footer,
           accent              = v_accent,
           enabled_study_types = v_types,
           updated_at          = now(),
           updated_by          = v_actor.id
     where id = 1;

    perform private.write_audit(
      v_actor.id, 'admin.settings_updated', 'instance', '1',
      v_before, private.instance_json());
  end if;

  return jsonb_build_object('settings', private.instance_json());
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.admin_get_settings(),
  public.admin_update_settings(jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_get_settings(),
  public.admin_update_settings(jsonb)
to authenticated;
