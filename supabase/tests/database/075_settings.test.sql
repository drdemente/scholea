-- Instance settings: admin_get_settings() and admin_update_settings().
--
-- Legacy parity (old server, admin.test.ts "manages instance settings and
-- surfaces public contact info"): an administrator changes the organisation
-- name and support email, and the public projection shows them to everyone.
--
-- Changed on purpose: there are no shared API keys and no feature toggles. A
-- patch that carries either is refused instead of being silently dropped, and
-- nothing of it is stored anywhere. The accent is a hex colour or nothing, and
-- the study type list is never empty.
--
-- Who is let in is 060; get_public_instance() for visitors is 070.

begin;
select plan(107);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select tests.create_user('st-admin@example.test', 'admin');
select tests.create_user('st-master@example.test', 'master_admin');
select tests.create_user('st-researcher@example.test');

-- A developer's database may hold other settings; these tests start from the defaults.
update public.instance_settings
   set org_name = 'Scholea', support_email = '', footer_contact = '', accent = '', enabled_study_types = null,
       updated_at = '2026-01-01 00:00:00+00', updated_by = null
 where id = 1;

create function pg_temp.obj_keys(p jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p) k;
$$;

-- The settings audit rows written by this file's accounts, oldest first.
create function pg_temp.settings_audit()
returns table (actor_email text, target_type text, target_id text, before_data jsonb, after_data jsonb)
language sql stable security definer as $$
  select a.actor_email, a.target_type, a.target_id, a.before_data, a.after_data
    from public.audit_log a
   where a.action = 'admin.settings_updated' and a.actor_email like 'st-%@example.test'
   order by a.created_at, a.id;
$$;

create function pg_temp.settings_row()
returns table (org_name text, support_email text, footer_contact text, accent text,
               enabled_study_types text[], updated_at timestamptz, updated_by uuid)
language sql stable security definer as $$
  select s.org_name, s.support_email, s.footer_contact, s.accent, s.enabled_study_types, s.updated_at, s.updated_by
    from public.instance_settings s where s.id = 1;
$$;

-- Send one value for one key, and say what came back for that key, or the
-- code and details of the refusal.
create function pg_temp.try(p_key text, p_value jsonb) returns text
language plpgsql as $$
declare
  v_state   text;
  v_message text;
begin
  return public.admin_update_settings(jsonb_build_object(p_key, p_value)) -> 'settings' ->> p_key;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  if v_state = 'PGRST' then
    return 'ERROR ' || (v_message::jsonb ->> 'code') || ' ' || coalesce(v_message::jsonb ->> 'details', '');
  end if;
  return 'ERROR ' || v_state;
end
$$;

grant execute on function pg_temp.obj_keys(jsonb), pg_temp.settings_audit(), pg_temp.settings_row(),
  pg_temp.try(text, jsonb) to authenticated, anon;

-- ===========================================================================
-- admin_get_settings
-- ===========================================================================

select tests.login_as('st-admin@example.test');
select is(current_user::text, 'authenticated', 'from here on the caller is a client, not the table owner');

select is(
  public.admin_get_settings(),
  '{"settings":{"orgName":"Scholea","supportEmail":"","footerContact":"","accent":"","enabledStudyTypes":null}}'::jsonb,
  'admin_get_settings: {settings} with the stock defaults; null means every study type');
select is(
  pg_temp.obj_keys(public.admin_get_settings() -> 'settings'),
  'accent,enabledStudyTypes,footerContact,orgName,supportEmail',
  'admin_get_settings: exactly five keys. No API key names, no feature toggles');

-- ===========================================================================
-- admin_update_settings (admin.test.ts 4)
-- ===========================================================================

select is(
  public.admin_update_settings('{"orgName":"Demo University Research","supportEmail":"support@demo.example.test"}'),
  '{"settings":{"orgName":"Demo University Research","supportEmail":"support@demo.example.test",
                "footerContact":"","accent":"","enabledStudyTypes":null}}'::jsonb,
  'admin_update_settings: returns {settings} as they are now');
select is(public.admin_get_settings() -> 'settings' ->> 'orgName', 'Demo University Research',
  'admin_update_settings: admin_get_settings shows the change');

select results_eq(
  $$ select * from pg_temp.settings_audit() $$,
  $$ values ('st-admin@example.test', 'instance', '1',
             '{"orgName":"Scholea","supportEmail":"","footerContact":"","accent":"","enabledStudyTypes":null}'::jsonb,
             '{"orgName":"Demo University Research","supportEmail":"support@demo.example.test",
               "footerContact":"","accent":"","enabledStudyTypes":null}'::jsonb) $$,
  'admin_update_settings: audited as admin.settings_updated on instance 1, with all five settings before and after');
select results_eq(
  $$ select updated_by, updated_at > '2026-01-01 00:00:00+00' from pg_temp.settings_row() $$,
  $$ values (tests.user_id('st-admin@example.test'), true) $$,
  'admin_update_settings: records who changed the settings and when');

-- The public projection: unauthenticated, and the same five values.
select tests.as_anon();
select is(public.get_public_instance() -> 'instance' ->> 'orgName', 'Demo University Research',
  'a visitor without an account sees the new organisation name');
select is(public.get_public_instance() -> 'instance' ->> 'supportEmail', 'support@demo.example.test',
  'and the support email');
select tests.login_as('st-researcher@example.test');
select is(public.get_public_instance() -> 'instance' ->> 'orgName', 'Demo University Research',
  'a signed-in researcher sees it too: the settings take effect for everyone');
select tests.login_as('st-admin@example.test');
select is(public.get_public_instance() -> 'instance', public.admin_get_settings() -> 'settings',
  'what administrators edit is exactly what everyone is shown');

-- A key that is left out keeps its value.
select is(
  public.admin_update_settings('{"footerContact":"Research Office"}') -> 'settings',
  '{"orgName":"Demo University Research","supportEmail":"support@demo.example.test",
    "footerContact":"Research Office","accent":"","enabledStudyTypes":null}'::jsonb,
  'admin_update_settings: a key that is left out keeps its value');
select is(
  (select array[before_data ->> 'footerContact', after_data ->> 'footerContact',
                before_data ->> 'orgName', after_data ->> 'orgName']
     from pg_temp.settings_audit() offset 1),
  array['', 'Research Office', 'Demo University Research', 'Demo University Research'],
  'admin_update_settings: each change is audited against the values it replaced');

-- ---------------------------------------------------------------------------
-- Text values
-- ---------------------------------------------------------------------------
select is(pg_temp.try('orgName', '"  Padded University \n"'), 'Padded University',
  'orgName: trimmed');
select is(char_length(pg_temp.try('orgName', to_jsonb(repeat('o', 200)))), 200, 'orgName: 200 characters are accepted');
select is(pg_temp.try('orgName', to_jsonb(repeat('o', 201))), 'ERROR invalid_input orgName',
  'orgName: 201 characters are refused, and the error names the key');
select is(pg_temp.try('orgName', '5'), 'ERROR invalid_input orgName', 'orgName: a number is refused');
select is(pg_temp.try('orgName', 'null'), 'ERROR invalid_input orgName', 'orgName: null is refused');
select is(pg_temp.try('orgName', '""'), '', 'orgName: may be empty');

select is(pg_temp.try('footerContact', to_jsonb(E'  Research Office\nRoom 12  '::text)), E'Research Office\nRoom 12',
  'footerContact: trimmed at the ends, a line break inside is kept');
select is(char_length(pg_temp.try('footerContact', to_jsonb(repeat('f', 500)))), 500,
  'footerContact: 500 characters are accepted');
select is(pg_temp.try('footerContact', to_jsonb(repeat('f', 501))), 'ERROR invalid_input footerContact',
  'footerContact: 501 characters are refused');
select is(pg_temp.try('footerContact', '["a"]'), 'ERROR invalid_input footerContact',
  'footerContact: a list is refused');

select is(pg_temp.try('supportEmail', '" Help@Example.test "'), 'Help@Example.test',
  'supportEmail: an address is accepted, trimmed, in the letter case it was typed');
select is(pg_temp.try('supportEmail', '""'), '', 'supportEmail: empty hides the contact');
select is(pg_temp.try('supportEmail', '"not an address"'), 'ERROR invalid_input supportEmail',
  'supportEmail: text that is not an address is refused');
select is(pg_temp.try('supportEmail', '"Help Desk <help@example.test>"'), 'ERROR invalid_input supportEmail',
  'supportEmail: a display name around the address is refused (the app makes a mailto link of it)');
select is(pg_temp.try('supportEmail', '"help@nodot"'), 'ERROR invalid_input supportEmail',
  'supportEmail: a domain without a dot is refused');
select is(char_length(pg_temp.try('supportEmail', to_jsonb(repeat('a', 307) || '@example.test'))), 320,
  'supportEmail: 320 characters are accepted');
select is(pg_temp.try('supportEmail', to_jsonb(repeat('a', 308) || '@example.test')), 'ERROR invalid_input supportEmail',
  'supportEmail: 321 characters are refused');
select is(pg_temp.try('supportEmail', 'null'), 'ERROR invalid_input supportEmail', 'supportEmail: null is refused');

-- ---------------------------------------------------------------------------
-- Accent: nothing, or a hex colour stored as lower-case #rrggbb
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select t.sent, pg_temp.try('accent', to_jsonb(t.sent))
       from unnest(array['#1A7F5A', '#1a7f5a', '#ABC', '#abc', E' #AbC \n', '#000', '#FFFFFF', ''])
            with ordinality as t (sent, n)
      order by t.n $$,
  $$ values ('#1A7F5A', '#1a7f5a'), ('#1a7f5a', '#1a7f5a'), ('#ABC', '#aabbcc'), ('#abc', '#aabbcc'),
            (E' #AbC \n', '#aabbcc'), ('#000', '#000000'), ('#FFFFFF', '#ffffff'), ('', '') $$,
  'accent: #RGB and #RRGGBB in either letter case become lower-case #rrggbb; empty means the stock palette');

select is(pg_temp.try('accent', to_jsonb(t.sent)), 'ERROR invalid_input accent',
         'accent: refused, ' || t.why)
  from (values
    (1,  'rebeccapurple',            'a colour name'),
    (2,  '1a7f5a',                   'a missing #'),
    (3,  '#12',                      'two digits'),
    (4,  '#1234',                    'four digits'),
    (5,  '#12345',                   'five digits'),
    (6,  '#1234567',                 'seven digits'),
    (7,  '#aabbccdd',                'eight digits (no alpha channel)'),
    (8,  '#gggggg',                  'letters that are not hex digits'),
    (9,  'rgb(26, 127, 90)',         'an rgb() colour'),
    (10, '#abc;}body{display:none}', 'CSS after the colour'),
    (11, E'#aab\nbcc',               'a line break inside the colour'),
    (12, '#abc #def',                'two colours'),
    (13, 'var(--violet-500)',        'a CSS variable'),
    (14, '#',                        'a lone #'),
    (15, 'color:#aabbcc',            'text before the colour'),
    (16, '##aabbcc',                 'two # signs')) t (n, sent, why)
 order by t.n;
select is(pg_temp.try('accent', '123456'), 'ERROR invalid_input accent', 'accent: refused, a number');
select is(pg_temp.try('accent', 'null'), 'ERROR invalid_input accent', 'accent: refused, null (send an empty string)');
select is((select accent from pg_temp.settings_row()), '',
  'accent: after every refused value the stored accent is what it was');
select is(pg_temp.try('accent', '"#1A7F5A"'), '#1a7f5a', 'accent: set for the checks below');

-- ---------------------------------------------------------------------------
-- The study type allow-list
-- ---------------------------------------------------------------------------
select is(
  public.admin_update_settings('{"enabledStudyTypes":["rct","systematic-review"]}') -> 'settings' -> 'enabledStudyTypes',
  '["rct","systematic-review"]'::jsonb,
  'enabledStudyTypes: a list of ids is stored');
select is((select enabled_study_types from pg_temp.settings_row()), array['rct', 'systematic-review'],
  'enabledStudyTypes: as a text array, in the order given');
select is(
  public.admin_update_settings('{"enabledStudyTypes":["rct","cohort","rct","case-control","cohort"]}')
    -> 'settings' -> 'enabledStudyTypes',
  '["rct","cohort","case-control"]'::jsonb,
  'enabledStudyTypes: a repeated id is stored once, where it first appeared');
select is(
  public.admin_update_settings('{"enabledStudyTypes":["some-future-type-2"]}') -> 'settings' -> 'enabledStudyTypes',
  '["some-future-type-2"]'::jsonb,
  'enabledStudyTypes: only the format is checked, the registry lives in the app');
select is(
  public.admin_update_settings(jsonb_build_object('enabledStudyTypes', jsonb_build_array(repeat('a', 64))))
    -> 'settings' -> 'enabledStudyTypes' ->> 0,
  repeat('a', 64),
  'enabledStudyTypes: an id of 64 characters is accepted');
select is(
  jsonb_array_length(public.admin_update_settings(jsonb_build_object('enabledStudyTypes',
    (select jsonb_agg('type-' || g) from generate_series(1, 100) g))) -> 'settings' -> 'enabledStudyTypes'),
  100,
  'enabledStudyTypes: 100 ids are accepted');

select is(pg_temp.try('enabledStudyTypes', t.sent::jsonb), 'ERROR invalid_input enabledStudyTypes',
         'enabledStudyTypes: refused, ' || t.why)
  from (values
    (1,  '[]',                 'an empty list (limiting needs at least one type)'),
    (2,  '["rct","Bad_Id"]',   'an id with capitals or an underscore'),
    (3,  '["rct",""]',         'an empty id'),
    (4,  '["rct"," cohort"]',  'an id with a space'),
    (5,  '["rct",5]',          'a number in the list'),
    (6,  '["rct",null]',       'a null in the list'),
    (7,  '[["rct"]]',          'a nested list'),
    (8,  '"rct"',              'a single string instead of a list'),
    (9,  '{"rct":true}',       'an object instead of a list'),
    (10, 'true',               'a boolean'),
    (11, '["rct,cohort"]',     'two ids in one string')) t (n, sent, why)
 order by t.n;
select is(
  pg_temp.try('enabledStudyTypes', jsonb_build_array(repeat('a', 65))), 'ERROR invalid_input enabledStudyTypes',
  'enabledStudyTypes: refused, an id of 65 characters');
select is(
  pg_temp.try('enabledStudyTypes', (select jsonb_agg('type-' || g) from generate_series(1, 101) g)),
  'ERROR invalid_input enabledStudyTypes',
  'enabledStudyTypes: refused, more than 100 ids');
select is(cardinality((select enabled_study_types from pg_temp.settings_row())), 100,
  'enabledStudyTypes: after every refused value the stored list is what it was');

select is(
  public.admin_update_settings('{"enabledStudyTypes":null}') -> 'settings' -> 'enabledStudyTypes', 'null'::jsonb,
  'enabledStudyTypes: null offers every study type again');
select is((select enabled_study_types is null from pg_temp.settings_row()), true,
  'enabledStudyTypes: and is stored as null, not as an empty list');

-- ---------------------------------------------------------------------------
-- Keys that are not settings
-- ---------------------------------------------------------------------------
-- A recognisable marker stands in for a key value. It is not a secret.
select throws_ok(
  $$ select public.admin_update_settings('{"defaultApiKeys":{"openalex":"tap-shared-key-marker"}}') $$,
  'PGRST',
  '{"code": "invalid_input", "hint": null, "details": "defaultApiKeys", "message": "invalid_input"}',
  'shared API keys are not a setting: the patch is refused, and the error names the key');
select tests.throws_code(
  $$ select public.admin_update_settings('{"orgName":"With A Key","defaultApiKeys":{"ncbi":"tap-shared-key-marker"}}') $$,
  'invalid_input', 400,
  'a patch that mixes a real setting with an API key is refused as a whole');
select is(public.admin_get_settings() -> 'settings' ->> 'orgName', '',
  'and the real setting in it was not applied');
select tests.throws_code(format('select public.admin_update_settings(%L)', t.patch),
         'invalid_input', 400, 'refused: ' || t.why)
  from (values
    (1, '{"featureToggles":{"beta":true}}', 'feature toggles'),
    (2, '{"defaultApiKeysSet":["openalex"]}', 'API key names'),
    (3, '{"org_name":"Snake Case"}',        'a column name instead of the setting name'),
    (4, '{"updatedBy":"00000000-0000-4000-8000-000000000000"}', 'who changed the settings'),
    (5, '{"id":2}',                         'the row id'),
    (6, '[]',                               'a patch that is a list'),
    (7, '"orgName"',                        'a patch that is a string'),
    (8, 'null',                             'a patch that is JSON null')) t (n, patch, why)
 order by t.n;
select tests.throws_code($$ select public.admin_update_settings(null) $$, 'invalid_input', 400,
  'refused: no patch at all');

select is(
  (select count(*)::integer from pg_temp.settings_audit() a
    where a.before_data::text like '%tap-shared-key-marker%' or a.after_data::text like '%tap-shared-key-marker%'
       or a.after_data ? 'defaultApiKeys' or a.after_data ? 'featureToggles'),
  0, 'nothing of a refused API key reaches the audit log');
select is(pg_temp.obj_keys(public.admin_get_settings() -> 'settings'),
  'accent,enabledStudyTypes,footerContact,orgName,supportEmail',
  'and the settings still have exactly five keys');
select is(position('tap-shared-key-marker' in public.get_public_instance()::text), 0,
  'and nothing of it is shown to anyone');

-- ---------------------------------------------------------------------------
-- All or nothing, and nothing when nothing changes
-- ---------------------------------------------------------------------------
select tests.throws_code(
  $$ select public.admin_update_settings('{"orgName":"Half Applied","accent":"not-a-colour"}') $$,
  'invalid_input', 400, 'a patch with one bad value is refused');
select is(public.admin_get_settings() -> 'settings' ->> 'orgName', '',
  'and none of it is applied');

select is(public.admin_update_settings('{"orgName":"Final University","supportEmail":"help@example.test",
  "footerContact":"Room 12","accent":"#0af","enabledStudyTypes":["rct"]}') -> 'settings',
  '{"orgName":"Final University","supportEmail":"help@example.test","footerContact":"Room 12",
    "accent":"#00aaff","enabledStudyTypes":["rct"]}'::jsonb,
  'all five settings can be changed in one call');

select tests.logout();
create temp table audit_before as select count(*)::integer as n from pg_temp.settings_audit();
grant select on audit_before to authenticated;
update public.instance_settings set updated_at = '2026-02-02 00:00:00+00' where id = 1;
select tests.resume_as('st-admin@example.test');

select is(public.admin_update_settings('{}') -> 'settings' ->> 'orgName', 'Final University',
  'an empty patch is accepted and returns the settings');
select is(
  public.admin_update_settings('{"orgName":" Final University ","accent":"#00AAFF","enabledStudyTypes":["rct","rct"]}')
    -> 'settings' ->> 'accent', '#00aaff',
  'sending the current values, written differently, is accepted');
select is((select count(*)::integer from pg_temp.settings_audit()), (select n from audit_before),
  'a patch that changes nothing writes no audit row');
select is((select updated_at from pg_temp.settings_row()), '2026-02-02 00:00:00+00'::timestamptz,
  'and does not touch the row');

-- ---------------------------------------------------------------------------
-- A master admin is an administrator too
-- ---------------------------------------------------------------------------
select tests.login_as('st-master@example.test');
select is(public.admin_get_settings() -> 'settings' ->> 'orgName', 'Final University',
  'a master admin reads the settings');
select is(public.admin_update_settings('{"orgName":"Master University"}') -> 'settings' ->> 'orgName',
  'Master University', 'a master admin changes them');
select results_eq(
  $$ select updated_by from pg_temp.settings_row() $$,
  $$ values (tests.user_id('st-master@example.test')) $$,
  'and is recorded as the one who did');
select is(
  (select array[a.actor_email, a.before_data ->> 'orgName', a.after_data ->> 'orgName']
     from pg_temp.settings_audit() a order by a.after_data ->> 'orgName' = 'Master University' desc limit 1),
  array['st-master@example.test', 'Final University', 'Master University'],
  'and in the audit row');

-- ---------------------------------------------------------------------------
-- Everyone else
-- ---------------------------------------------------------------------------
select tests.login_as('st-researcher@example.test');
select tests.throws_code($$ select public.admin_get_settings() $$, 'forbidden', 403,
  'a researcher cannot read the settings through the admin function');
select tests.throws_code($$ select public.admin_update_settings('{"orgName":"Mine Now"}') $$, 'forbidden', 403,
  'a researcher cannot change the settings');
select throws_ok($$ select 1 from public.instance_settings $$, '42501', null,
  'a researcher cannot read the settings row');
select throws_ok($$ update public.instance_settings set org_name = 'Mine Now' $$, '42501', null,
  'and cannot write to it');
select is(public.get_public_instance() -> 'instance' ->> 'orgName', 'Master University',
  'a researcher gets the public values, unchanged by the attempts');

select tests.as_anon();
select throws_ok($$ select public.admin_get_settings() $$, '42501', null,
  'a visitor without an account cannot call admin_get_settings');
select throws_ok($$ select public.admin_update_settings('{"orgName":"Anon"}') $$, '42501', null,
  'or admin_update_settings');
select tests.logout();

select * from finish();
rollback;
