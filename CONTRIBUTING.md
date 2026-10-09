# Contributing to Scholea

Thanks for helping make rigorous research feel like a journey. Scholea is built
to be contributed to, especially by **methodologists**, not only engineers.

## Two kinds of contribution

### 1. Methodology content (no coding required)

Study-type roadmaps, step guidance, validation checks and reporting checklists
are stored as **structured data, separate from code**:

- Study-type configs: `src/lib/study/`
- Reporting-standard checklists: `src/lib/checklist/checklists.ts`

One instrument is not data yet: the risk-of-bias domains (RoB 2) are a constant
inside the appraisal tool, `src/components/runner/tools/AppraisalTool.tsx`.
Changing them means editing that component.

You can review and improve methodology by editing these data files and opening a
PR. Every study type is authored **independently from its own reporting
guideline**: no type inherits steps or methodology from another. Cite the
canonical source (Cochrane Handbook, JBI, PRISMA 2020 & extensions, EQUATOR,
GRADE) in your PR description.

### 2. Engineering

The pathway engine is **methodology-blind**: it renders whatever steps a config
provides, gates content by level, runs validation checks, and persists inputs.
**Adding or altering a study type should require only config + content, never
engine changes.** If you find yourself editing the engine to support one study
type, that's a design smell; open an issue first.

## Ground rules (from the project's hard constraints)

1. **Free + generous APIs only, bring-your-own-key per user.** Never hardcode a
   shared global key. The Supabase URL and publishable key in a build are not
   API keys in this sense. They identify the optional account backend and are
   public by design: anyone can read them, and the database decides what each
   caller may do. A secret key (`sb_secret_...`, or a legacy `service_role`
   key) must never appear in the repo, in a `VITE_*` variable, or in a build.
   A build that is given one stops with an error.
2. **Validated statistics only.** Never hand-roll statistical/meta-analytic math.
   Wrap established libraries and unit-test against published reference output.
   Every result must show method + assumptions + citation.
3. **Honesty in output.** AI-assisted text is a *structured draft to a reporting
   standard*, never "ready to submit."
4. **Security.** Scholea never stores or hashes a password itself: Supabase Auth
   does. Never commit secrets, secret keys, seeded accounts or default admin
   passwords. Who may do what is decided in the database, never only in the UI:
   a client can call functions and nothing else, every function checks its
   caller before it acts, and every table has Row Level Security as a second
   lock. New policies and functions ship with a pgTAP test.
5. **Accessibility is not optional.** WCAG 2.1 AA. See the checklist below.

## Local development

```bash
pnpm install
pnpm dev          # http://localhost:5193
pnpm test         # Vitest
pnpm typecheck    # tsc, no emit
pnpm build        # type-check + production build
```

That is the guest-only app: no account UI and no backend. Most contributions
need nothing more.

### The account backend (optional)

Only needed when you work on accounts, sync, sharing or anything under
`supabase/`. It needs Docker, the Supabase CLI (2.111.0 is the
version this repository is developed against) and, for the end-to-end tests,
Deno 2.

```bash
# Start the parts of the local stack Scholea uses, and apply supabase/migrations
supabase start -x studio,postgres-meta,imgproxy,storage-api,realtime,logflare,vector,supavisor

# Write the two public settings for the app (git-ignored)
supabase status -o env | awk -F= '
  $1 == "API_URL"         { print "VITE_SUPABASE_URL=" $2 }
  $1 == "PUBLISHABLE_KEY" { print "VITE_SUPABASE_PUBLISHABLE_KEY=" $2 }
' | tr -d '"' > .env.local

pnpm dev                # now with accounts
supabase test db        # database tests (pgTAP)
pnpm test:supabase      # Edge Function and sign-in flows, end to end (Deno)
supabase stop           # when you are done
```

- The local stack sends no real email. Read confirmation, reset and invitation
  codes in its mail catcher at <http://127.0.0.1:56324>.
- To keep plain `pnpm dev` guest-only while you work on accounts, write the same
  two lines to `.env.supabase.local` instead and run
  `pnpm exec vite --mode supabase`.
- `supabase db reset` rebuilds the local database from the migrations. It
  deletes every local account and project, which is what you want when testing
  a migration from scratch.
- A new instance has no administrator. To work on the admin functions locally,
  create an account in the app, then promote it:
  ```bash
  docker exec -i supabase_db_scholea psql -U postgres -d postgres \
    -c "select private.bootstrap_master_admin('you@example.test');"
  ```
- The app has no admin console. The admin functions are exercised by the
  database tests and the end-to-end tests
  (`supabase/tests/database/065_admin.test.sql`,
  `supabase/functions/tests/admin.e2e.test.ts`). To call them by hand as the
  account you promoted, see
  [docs/deployment.md](./docs/deployment.md#administering-your-own-instance).

## Changes under `supabase/`

The database is the security boundary, so changes there carry extra
expectations:

- **Tests.** `supabase test db` passes. A new policy or function comes with a
  pgTAP test in `supabase/tests/database/` that shows who is allowed and, just
  as importantly, who is refused. If you touched the Edge Function, the email
  templates or anything about sign-in, `pnpm test:supabase` passes too.
- **No table access.** No API role (`anon`, `authenticated`, `service_role`) is
  granted anything on a table. Clients read and write through functions. A new
  table still gets Row Level Security and policies, as the second lock.
- **Functions.** A `security definer` function pins `set search_path = ''`,
  identifies and checks its caller first (`private.require_active()`,
  `private.require_role(...)`), and has `EXECUTE` revoked from `public`, `anon`,
  `authenticated` and `service_role`, then granted by name to the one role that
  needs it. Helpers that clients must not reach live in the `private` schema.
- **Email templates.** Every flow uses a code that the person types into the
  app. A template prints `{{ .Token }}` and never contains a link.
- **Migrations are append-only.** Never edit a migration that has been merged.
  Add a new file that changes what the earlier one created.
- **Hosted projects are the maintainer's job.** Contributors never push
  migrations or deploy functions to anyone's hosted Supabase project
  (`supabase link`, `supabase db push`, `supabase functions deploy`,
  `supabase config push`). You develop and test against the local stack; the
  maintainer applies merged changes, following
  [docs/deployment.md](./docs/deployment.md).
- **No credentials.** Test accounts use `@example.test` addresses and passwords
  generated at run time. Nothing is seeded.

## Accessibility checklist (for any UI PR)

- [ ] Text on glass uses opaque tokens (`text-ink` / `text-ink-soft`), not opacity modifiers.
- [ ] Contrast ≥ 4.5:1 body / 3:1 large, tested against the mesh's worst-case stop.
- [ ] Interactive elements use `focus-visible:focus-ring` (double-layer ring).
- [ ] New animation gates on `useReducedMotion()` / `withReduced()`; transform/opacity only.
- [ ] If colour conveys meaning, an icon or shape conveys it too.
- [ ] Tested in both `data-mode="light"` and `data-mode="dark"`.

## Commit & PR

- Keep PRs focused. One study type, one component, or one fix per PR.
- Describe **why**, and cite methodology sources for content changes.
- Make sure `pnpm test` and `pnpm typecheck` pass, and `supabase test db` if you
  touched `supabase/`.
- User-facing copy and docs: plain sentences that are true of the code.

By contributing you agree your contributions are licensed under the project's
[Apache-2.0](./LICENSE) license.
