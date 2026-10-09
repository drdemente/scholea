-- The audit log is append-only for everyone, and instance_settings is a single
-- row that only accepts well-formed values.

begin;
select plan(35);

select tests.create_user('audit-actor@example.test', 'admin');

-- ===========================================================================
-- Audit log
-- ===========================================================================

select columns_are('public', 'audit_log',
  array['id', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id',
        'before_data', 'after_data', 'created_at'],
  'audit_log has the legacy columns (before and after as jsonb)');

select lives_ok(
  $$ select private.write_audit(tests.user_id('audit-actor@example.test'), 'tap.with_actor',
                                'user', 'target-1', '{"role":"researcher"}', '{"role":"supervisor"}') $$,
  'write_audit records an action');

select results_eq(
  $$ select actor_id, actor_email, target_type, target_id, before_data, after_data, created_at is not null
       from public.audit_log where action = 'tap.with_actor' $$,
  $$ values (tests.user_id('audit-actor@example.test'), 'audit-actor@example.test', 'user', 'target-1',
             '{"role":"researcher"}'::jsonb, '{"role":"supervisor"}'::jsonb, true) $$,
  'write_audit snapshots the actor email from the profile and stores before and after');

select private.write_audit(null, 'tap.no_actor');
select results_eq(
  $$ select actor_id, actor_email, target_type, target_id, before_data, after_data
       from public.audit_log where action = 'tap.no_actor' $$,
  $$ values (null::uuid, null::text, null::text, null::text, null::jsonb, null::jsonb) $$,
  'write_audit accepts a null actor (the instance owner acting from SQL) and optional details');

select private.write_audit(gen_random_uuid(), 'tap.unknown_actor');
select is((select actor_email from public.audit_log where action = 'tap.unknown_actor'), null,
  'write_audit never invents an email for an actor it cannot find');

-- These run as the table owner, the most privileged caller there is.
select throws_ok(
  $$ update public.audit_log set action = 'tap.rewritten' where action = 'tap.with_actor' $$,
  '42501', 'public.audit_log is append-only: update is not allowed',
  'audit rows cannot be updated, even by the owner');
select throws_ok(
  $$ delete from public.audit_log where action = 'tap.with_actor' $$,
  '42501', 'public.audit_log is append-only: delete is not allowed',
  'audit rows cannot be deleted, even by the owner');
select throws_ok(
  $$ truncate public.audit_log $$,
  '42501', 'public.audit_log is append-only: truncate is not allowed',
  'the audit log cannot be truncated, even by the owner');
select is((select count(*)::integer from public.audit_log where action = 'tap.with_actor'), 1,
  'after every refused attempt the row is still there, unchanged');

-- The log outlives the people in it.
delete from auth.users where id = tests.user_id('audit-actor@example.test');
select results_eq(
  $$ select actor_email from public.audit_log where action = 'tap.with_actor' $$,
  $$ values ('audit-actor@example.test') $$,
  'deleting the actor leaves their audit rows in place');

-- ===========================================================================
-- Instance settings
-- ===========================================================================

select columns_are('public', 'instance_settings',
  array['id', 'org_name', 'support_email', 'footer_contact', 'accent',
        'enabled_study_types', 'updated_at', 'updated_by'],
  'instance_settings has only the agreed columns: no shared API keys, no feature toggles');

select results_eq(
  $$ select id::integer from public.instance_settings $$, $$ values (1) $$,
  'there is exactly one settings row');

-- A developer's database may hold edited settings, so look at a fresh row.
delete from public.instance_settings;
insert into public.instance_settings default values;
select results_eq(
  $$ select id::integer, org_name, support_email, footer_contact, accent, enabled_study_types, updated_by
       from public.instance_settings $$,
  $$ values (1, 'Scholea', '', '', '', null::text[], null::uuid) $$,
  'a fresh settings row carries the stock defaults: every study type, no accent, no contact');

select throws_ok(
  $$ insert into public.instance_settings (id) values (2) $$, '23514', null,
  'a second settings row cannot be added');
select throws_ok(
  $$ insert into public.instance_settings (id) values (1) $$, '23505', null,
  'the settings row cannot be duplicated');

-- accent: '' or lowercase #rrggbb.
select lives_ok($$ update public.instance_settings set accent = '#a1b2c3' $$, 'accent: lowercase #rrggbb is accepted');
select lives_ok($$ update public.instance_settings set accent = '' $$,        'accent: empty (stock palette) is accepted');
select throws_ok($$ update public.instance_settings set accent = '#A1B2C3' $$, '23514', null, 'accent: uppercase hex is rejected');
select throws_ok($$ update public.instance_settings set accent = '#abc' $$,    '23514', null, 'accent: short hex is rejected');
select throws_ok($$ update public.instance_settings set accent = 'a1b2c3' $$,  '23514', null, 'accent: a missing # is rejected');
select throws_ok($$ update public.instance_settings set accent = 'rebeccapurple' $$, '23514', null, 'accent: a colour name is rejected');
select throws_ok($$ update public.instance_settings set accent = '#a1b2c3; background:url(x)' $$, '23514', null,
  'accent: trailing text after the colour is rejected');
select throws_ok($$ update public.instance_settings set accent = E'#a1b2c3\n' $$, '23514', null,
  'accent: a trailing newline is rejected');

-- enabled_study_types: null (all), or at least one well-formed id.
select lives_ok(
  $$ update public.instance_settings set enabled_study_types = array['rct', 'systematic-review', 'cohort2'] $$,
  'study types: a list of ids is accepted');
select lives_ok(
  $$ update public.instance_settings set enabled_study_types = array[repeat('a', 64)] $$,
  'study types: an id of 64 characters is accepted');
select lives_ok(
  $$ update public.instance_settings set enabled_study_types = null $$,
  'study types: null (every type) is accepted');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = '{}' $$, '23514', null,
  'study types: an empty list is rejected (limiting needs at least one type)');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array[repeat('a', 65)] $$, '23514', null,
  'study types: an id of 65 characters is rejected');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array['rct', 'Bad_Id'] $$, '23514', null,
  'study types: an id with other characters is rejected');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array['rct', ''] $$, '23514', null,
  'study types: an empty id is rejected');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array['rct', null] $$, '23514', null,
  'study types: a null id is rejected');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array['rct,cohort'] $$, '23514', null,
  'study types: two ids smuggled into one element are rejected');
select throws_ok(
  $$ update public.instance_settings set enabled_study_types = array[array['rct'], array['cohort']] $$, '23514', null,
  'study types: a nested list is rejected');

-- Length limits.
select throws_ok($$ update public.instance_settings set org_name = repeat('x', 201) $$, '23514', null,
  'org_name is limited to 200 characters');
select throws_ok($$ update public.instance_settings set footer_contact = repeat('x', 501) $$, '23514', null,
  'footer_contact is limited to 500 characters');

select * from finish();
rollback;
