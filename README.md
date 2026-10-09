# Scholea

> **Rigor that feels like a journey, not a chore.**

Scholea is an open-source, student-focused **guided research pathway**. It walks a
researcher through every common study type (systematic review, meta-analysis,
scoping/narrative/umbrella review, cross-sectional, cohort, case-control, RCT,
quasi-experimental, diagnostic accuracy, qualitative, survey, mixed-methods,
case report/series, economic evaluation and animal/preclinical studies) from
**idea → feasibility → protocol → search → screening → extraction → appraisal →
analysis → reporting-standard-compliant draft → export**.

It runs as a static web app and as an installable desktop app from one codebase.
It works without an account, and the research pathway itself works offline
(literature search and AI help need a connection). An optional account adds sync
across devices and project sharing.

> ⚠️ **Honesty note:** AI-assisted text in Scholea is a *structured draft to a
> reporting standard*, never "ready to submit." Scholea teaches and scaffolds; it
> does not ghostwrite. All guidance is grounded in canonical sources (Cochrane
> Handbook, JBI, PRISMA 2020 & extensions, EQUATOR, GRADE).

---

## What is in it

| Area | What you get |
|------|--------------|
| Guided pathways | 17 study types, each a step-by-step pathway authored from its own reporting guideline, with guidance at three levels of detail (Basic, Medium, Advanced) and validation checks as you go |
| Literature | Search across Europe PMC, Crossref, OpenAlex, PubMed and ClinicalTrials.gov (any key is your own), RIS import, deduplication, dual-reviewer screening with a live Cohen's kappa, full-text eligibility |
| Appraisal and analysis | Risk-of-bias matrix, meta-analysis with forest and funnel plots, diagnostic 2×2 with ROC, reliability, sample size and general statistics, all from reference-tested functions |
| Reporting | PRISMA 2020, CONSORT and STROBE flow diagrams, reporting-standard checklists, a compiled manuscript draft (Markdown, Word, LaTeX, print), and ethics document scaffolds |
| AI help (optional) | Field-level drafting with your own key (Anthropic or any OpenAI-compatible endpoint), always labelled a draft to review |
| Collaboration | Per-step discussion, supervisor sign-off and an activity ledger on every project. With an account: sync across devices, sharing by invitation with roles, and comments and sign-offs shared with the team |
| Administration (optional) | For whoever runs an account backend: instance roles, invitations by emailed code, suspension, an audit log and instance settings. These are functions of the backend, not screens of the app (see below) |

The app opens on a **Projects** home, where you resume or switch between studies.

The app has no admin console. Administration is part of the backend in
[`supabase/`](./supabase), and the database decides what each caller may do.
If you run your own instance, the
[deployment guide](./docs/deployment.md#5-roles-and-administration) lists the
functions to call from a tool of your own, and says what can be done from SQL
and the Supabase dashboard.

## Tech stack

- **Frontend:** React + TypeScript + Vite, Tailwind CSS, Framer Motion, Zustand
- **Desktop:** Tauri v2 (wraps the same Vite build → `.msi`/`.dmg`/`.deb`/`.AppImage`)
- **Local-first storage:** IndexedDB via Dexie
- **Statistics:** pure, reference-tested functions in `src/lib/stats/`
  (meta-analysis, agreement, diagnostics, sample size, general statistics); the
  meta-analysis runs in a Web Worker. Optional cross-checks against WebR +
  `metafor` and Pyodide + SciPy are fetched on demand and never bundled
- **Citations:** a built-in APA 7 / Vancouver / Harvard formatter; citeproc-js
  with CSL styles is fetched on demand for other journal styles
- **Accounts and sync (optional):** Supabase. Auth for sign-in, Postgres
  functions for every read and write (with Row Level Security as a second lock),
  and one Edge Function. Schema, policies, functions and tests live in
  [`supabase/`](./supabase). There is no server to run

## Getting started

```bash
pnpm install
pnpm dev        # web dev server at http://localhost:5193
pnpm test       # unit tests (Vitest)
pnpm typecheck  # type-check
pnpm build      # production web build → dist/
```

That is the whole app in its guest-only form: no account UI and no requests to
any account backend. It is the default, and it is how CI builds.

### The account backend, locally (optional)

Accounts need a Supabase project. For development that is a local stack, which
needs Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
(this repository is developed against CLI 2.111.0).

```bash
# Start the parts of the local stack Scholea uses, and apply supabase/migrations
supabase start -x studio,postgres-meta,imgproxy,storage-api,realtime,logflare,vector,supavisor

# Point the app at it: write the two public settings to .env.local (git-ignored)
supabase status -o env | awk -F= '
  $1 == "API_URL"         { print "VITE_SUPABASE_URL=" $2 }
  $1 == "PUBLISHABLE_KEY" { print "VITE_SUPABASE_PUBLISHABLE_KEY=" $2 }
' | tr -d '"' > .env.local

pnpm dev        # the same dev server, now with a Sign in button
```

Create an account in the app. No email leaves your machine: the local stack
catches every message, and you read the confirmation code in its mail catcher
at <http://127.0.0.1:56324>. Delete `.env.local` to get the guest-only app back,
and run `supabase stop` to stop the stack.

Backend tests (both need the local stack running; the second also needs
[Deno](https://deno.com) 2):

```bash
supabase test db      # database tests (pgTAP): privileges, policies, every function
pnpm test:supabase    # Edge Function and sign-in flows, end to end
```

CI ([`.github/workflows`](./.github/workflows)) type-checks, tests and builds
the web app with no backend configured, and runs the database and Edge Function
tests against a local Supabase stack. On a version tag it builds the web bundle
plus desktop installers for macOS, Windows and Linux, and attaches them to the
tag's release: see
[Publishing a release](./docs/deployment.md#publishing-a-release).

### Desktop (Tauri)

Requires the [Rust toolchain](https://www.rust-lang.org/tools/install). Once Rust
is installed:

```bash
pnpm tauri dev      # run the desktop app
pnpm tauri build    # produce installers
```

The `src-tauri/` config is committed and ready; the desktop binary is not built
in environments without Rust.

## Project shape

```
src/
  components/glass/     Glass surface primitives (Panel, Overlay, Button, BackgroundMesh)
  components/ui/        Form fields, confirm dialog, states and toasts shared by the screens
  components/pathway/   The Pathway Map, the signature navigation element
  components/shell/     AppShell, TopBar, LevelToggle, CommandPalette (⌘K)
  components/runner/    StepRunner, per-step discussion, and the rich step tools
  components/charts/    Forest, funnel, ROC and bar charts
  components/appraisal/ Risk-of-bias traffic lights (colourblind-safe)
  features/             Screens: projects · runner · chooser · paper · ethics · checklist ·
                        collab · help · settings · auth · instance
  lib/
    study/              Study-type configs: methodology as DATA, not code
    stats/              Pure, reference-validated statistics
    sources/            Literature-source adapters (bring your own key)
    paper/              Manuscript compile, citations, export
    db/                 Dexie schema + activity log (local-first)
    platform/           web / tauri adapter (one feature API, two targets)
    workers/            Stats Web Worker
    theme/              Zustand store: light/dark + level
    supabase/           Client for the optional account backend (absent when not configured)
    account/            Session and the sign-in, sign-up and password flows
    collab/             Link records, project sync, invitations, comments and sign-offs
    instance/           The organisation's settings, as the app applies them
  styles/tokens.css     Design tokens (light / dark themes)
supabase/               The optional account backend: migrations, database tests,
                        the Edge Function, email templates, local stack config
src-tauri/              Desktop shell (Tauri v2)
proxy/                  PubMed proxy for the web build
docs/                   Architecture, deployment, user guide
```

**Methodology content is data, not code.** Study-type roadmaps, with their step
guidance and validation checks, live as structured config in `src/lib/study/`,
and the reporting checklists in `src/lib/checklist/checklists.ts`, so
methodologists can review and PR them without touching the engine. One piece is
not there yet: the risk-of-bias instrument (the RoB 2 domains) is defined inside
its tool, `src/components/runner/tools/AppraisalTool.tsx`.

## Accounts and your data

You never need an account. Without one, nothing you write is sent to an account
service: your projects live in the browser's or the desktop app's storage on
your device. (Literature searches and AI help call the outside services you turn
on, with your own keys.)

An account adds sync and sharing, and is provided by whoever built your copy of
Scholea. A build with accounts contains a Supabase project URL and a publishable
key. Neither is a secret. Anyone can read them, and by themselves they reach only
the public sign-up and sign-in endpoints and the organisation's public settings
(its name, contact details, accent colour and list of study types). Everything
else needs a signed-in account, and the database checks every call. Forks that
build without these two values get the full guest-only app.

With an account, the projects you add to it, their comments and sign-offs, and
your name, institution and email address are stored in that Supabase project.
Projects you keep on your device are never uploaded unless you choose to add
them. Whoever operates the Supabase project can read what is stored in it, so do
not sync data that identifies patients or participants. Your API keys are never
part of what syncs.

## Accessibility

WCAG 2.1 AA target: colourblind-safe data viz (shape + colour), full keyboard
navigation with visible focus rings, `prefers-reduced-motion` and
`prefers-reduced-transparency` honoured, screen-reader labels, scalable type.

## Documentation

- [User guide](./docs/USER_GUIDE.md): how to use Scholea, also built into the app's Help
- [Architecture](./docs/architecture.md): the layered, methodology-as-data design, and where trust is decided
- [Adding a study type](./docs/adding-a-study-type.md): extend Scholea with a config, not code
- [Deployment](./docs/deployment.md): shipping the app with no backend, and running and administering your own account backend
- [Security policy](./SECURITY.md): how to report a vulnerability, and the design notes behind accounts

## License

[Apache-2.0](./LICENSE). Fonts (Plus Jakarta Sans, Inter, Source Serif 4,
JetBrains Mono) are bundled under the SIL Open Font License.

See [CONTRIBUTING.md](./CONTRIBUTING.md) to get involved.
