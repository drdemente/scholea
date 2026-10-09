<!--
Thanks for contributing to Scholea! Keep PRs focused: one study type, one
component, or one fix per PR. Describe *why*, not just *what*.
-->

## Summary

<!-- What does this change and why? -->

## Type of change

- [ ] Methodology / content (study-type config, checklist, appraisal instrument)
- [ ] Engineering (UI, engine, backend, tooling)
- [ ] Bug fix
- [ ] Documentation
- [ ] Other

## Methodology source (for content changes)

<!--
If you added or changed a study type, checklist, or appraisal instrument, cite
the canonical guideline it's grounded in (Cochrane Handbook, JBI, PRISMA 2020 &
extensions, EQUATOR, GRADE). Every study type is authored independently from its
own reporting guideline.
-->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] For engine changes: adding/altering a study type still requires only
      config + content, not engine changes
- [ ] For UI changes: the accessibility checklist in
      [CONTRIBUTING.md](../CONTRIBUTING.md) is satisfied (contrast, focus rings,
      reduced-motion, colour-plus-shape, light + dark)
- [ ] If `supabase/` changed: `supabase test db` passes (and `pnpm test:supabase`
      if the Edge Function, the email templates or sign-in behaviour changed);
      new policies and functions have a pgTAP test; `security definer` functions
      pin `search_path` and have `EXECUTE` revoked from `public` and the API
      roles, then granted by name; no API role is granted anything on a table;
      the change is a new migration file, not an edit of a merged one; nothing
      was pushed or deployed to a hosted Supabase project
- [ ] No secrets, secret keys, seeded accounts or default passwords committed
      (the Supabase URL and publishable key are public, but belong in
      `.env.local`, not in the repo)
