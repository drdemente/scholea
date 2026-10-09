# Architecture

Scholea is built around one idea: **a study type is data, not code.** A single
generic engine renders any research pathway from a declarative config, so adding
or changing a study type never touches the engine.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Study-type configs (DATA)   src/lib/study/                   │
│  17 study types authored from their own reporting guidelines  │
└───────────────┬─────────────────────────────────────────────┘
                │ resolved by registry (by studyType id)
┌───────────────▼─────────────────────────────────────────────┐
│  Pathway engine (CODE, methodology-blind)                     │
│  StepRunner · validation · levels · pathway · project-store   │
└───────────────┬─────────────────────────────────────────────┘
     tools ▼            ▼ stats/paper/sources (validated libs)
┌──────────────────┐  ┌──────────────────────────────────────┐
│ Tool registry    │  │ Data backbone · statistics · paper    │
│ search/screening │  │ OpenAlex/Crossref/EuropePMC · meta-   │
│ appraisal/…      │  │ analysis · citations · export         │
└──────────────────┘  └──────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│  Local-first storage (Dexie/IndexedDB) + platform adapter     │
│  projects · activity log · comments · sign-offs · settings    │
└───────────────┬─────────────────────────────────────────────┘
                │ optional: only in a build that was given a backend,
                │ and only for someone who is signed in
┌───────────────▼─────────────────────────────────────────────┐
│  Account layer (client)   src/lib/supabase · account · collab │
│  session · link records · project sync · invitations          │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS: sign-in, and calls to database functions
┌───────────────▼─────────────────────────────────────────────┐
│  Account backend   supabase/                                  │
│  Supabase Auth · Postgres functions with Row Level Security   │
│  as a second lock · one Edge Function (admin)                 │
└─────────────────────────────────────────────────────────────┘
```

## Key principles

- **Methodology-as-data.** The runner (`StepRunner`) knows nothing about any
  study type. It renders a `StudyTypeConfig`: level-gated guidance, structured
  inputs, declarative validation checks, and an optional rich `tool`. Swapping
  the config swaps the entire experience. See
  [adding-a-study-type.md](./adding-a-study-type.md).
- **Local-first & offline.** Everything a solo researcher does persists to
  IndexedDB and works with no network and no account. A `platform` adapter
  (`web` / `tauri`) keeps feature code identical on both targets.
- **Validated statistics only.** Statistics wrap vetted formulas/libraries and
  are reference-tested; every result surfaces its method, assumptions, and a
  citation. Scholea never hand-rolls unverified stats.
- **Honesty.** AI-assisted text is always labelled a *structured draft to a
  reporting standard*, never "ready to submit". The AI layer is optional and
  BYO-key.
- **Accounts are an optional layer.** The Supabase project URL and publishable
  key are read at build time (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`). Without them the Supabase client is never
  created, the session reports `unconfigured`, every piece of account UI renders
  nothing, and no request goes to a backend. With them, the app still opens
  straight into the research pathway; an account is something a person may add.

## Trust boundaries

The client is untrusted. It is open source, it runs on the user's machine, and
anyone can call the backend with their own code. So the client decides nothing:
it only decides what to offer. The database decides what is allowed.

- **Functions only.** The Data API exposes database functions and nothing else.
  No API role (`anon`, `authenticated`, `service_role`) holds any privilege on
  any table, so a client cannot select, insert, update or delete a row
  directly. Row Level Security stays enabled on every table as a second lock,
  in case a grant is ever added by mistake.
- **Every call re-checks the caller.** A function identifies its caller from
  the verified sign-in token, then requires that the account is active, that it
  has a password, and that the session named in the token still exists
  (`private.require_active()`). Only then does it check the role the action
  needs. Suspending an account, deleting it, or revoking its sessions therefore
  takes effect on the very next request. Two functions are deliberately looser,
  and both return only the caller's own record: `my_account()` answers whatever
  state the account is in, so the app can tell a suspended person why nothing
  works any more, and `my_profile()` also answers an invited person who has not
  chosen a password yet.
- **Roles live in the database.** A person's role is a column of `profiles`. It
  is never read from the token or from user metadata. A new account is always a
  `researcher`; an invited account gets its role from a server-side record
  written by the function that authorised the invitation.
- **Helpers stay private.** Functions that clients must not reach live in the
  `private` schema, which the API does not expose. Callable functions are
  `security definer`, pin an empty `search_path`, and are granted by name.
- **One Edge Function.** Some account actions need Supabase's Auth admin API:
  sending an invitation, changing an email address, banning and unbanning, and
  soft delete. The `admin` function does them. It verifies the caller's token,
  and the first step of every action is a database function called with the
  caller's own token, which authorises it. The secret key never leaves the
  function's runtime, and its role is granted nothing in Scholea's schema.
- **Administrators are not project members.** Administering accounts gives no
  access to anybody's project. Only the members of a project can read it.
  (Whoever operates the Supabase project itself can read everything in it; that
  is a different kind of trust, described in [SECURITY.md](../SECURITY.md).)
- **Codes, not links.** Every emailed step (confirm a sign-up, reset a
  password, accept an administrator's invitation, confirm a changed address)
  uses a one-time code typed into the app. After any such code the app requires
  a password to be saved before it does anything else, so the account ends up
  with a password its holder chose.
- **What is public.** One function, `get_public_instance()`, answers without
  signing in. It returns the organisation name, support email, contact line,
  accent colour and the list of study types offered for new projects.

The database tests in `supabase/tests/database/` hold these rules in place,
including a suite of escalation attempts (change your own role, read other
people's addresses, forge an audit row, add yourself to a project, call the
bootstrap function as a client).

## How sync works

**Link records.** Each project on a device has at most one link record, kept in
the device's local storage (`src/lib/collab/links.ts`). It says where the
project belongs: to an account (with that account's id, the project's server
id, the last synced revision and the person's role), or to this device only. A
project with no record is new. Three rules follow from it. Projects that belong
to an account show only while that account is the one the device shows, so the
app never shows one person's account projects to a second person who signs in
on the same device, and never uploads them into that second account. Projects
kept on the device always show and are never uploaded. And work done before signing in is pinned to the device at sign-in,
before the first sync can see it; it goes to the account only if the person
chooses "Add to my account". A project created while signed in gets its server
id on the device, written to the link record before the first request, so a
retried upload cannot create a second copy.

**Project content.** The research core always works from the local database.
For a signed-in person, `src/lib/collab/project-sync.ts` mirrors their account's
projects between the device and the backend. A project's content travels as one
document with a revision number. An upload names the revision it started from;
the server takes it unless its own copy has moved on and was edited later, in
which case it returns that copy instead. The newest edit wins for the whole
project: there is no merging of two people's simultaneous changes, and no live
collaboration. Sync runs when a person signs in, shortly after each edit, when
the device comes back online, when the window regains focus, and on "Sync now".
Viewers and supervisors never upload. A project whose server copy has gone
(deleted by its owner, or the person was removed) is kept as a device-only copy;
it is never re-created on the server and never deleted from the device.

**Comments and sign-offs.** These are rows of their own, not part of the
content document, so they cannot be overwritten by a content upload. What a
person writes on an account project goes into an outbox on the device and is
uploaded when possible; what the team wrote is copied down into a local mirror
(`src/lib/collab/collab-sync.ts`). The author's name and the right to sign off
come from the account and the person's role on the project, never from the
name and role typed into Settings. On a project kept on the device, comments
and sign-offs work as they always have, with the identity chosen on that
device.

## Roles

Two kinds of role exist, and they are independent.

**Roles on a project** decide what a member may do in that project:

| Project role | Read and comment | Edit content | Sign off steps | Invite, remove, change roles, delete |
|---|---|---|---|---|
| Viewer | yes | no | no | no |
| Editor | yes | yes | no | no |
| Supervisor | yes | no | yes | no |
| Owner | yes | yes | yes | yes |

Whoever creates a project is its owner. Other people join only by accepting an
invitation, as a viewer, editor or supervisor. An owner can then make a member
an owner. A project always keeps at least one owner: the last one cannot leave,
be removed or be given another role.

**Roles on the instance** decide who may administer accounts:
`researcher < supervisor < admin < master_admin`. `researcher` and `supervisor`
carry no privilege of their own in the database; what such a person can do in a
project comes from their role on that project. `admin` and `master_admin` may
call the admin functions.

| Acting role | Accounts it may manage | Roles it may assign |
|---|---|---|
| `master_admin` | any | any of the four |
| `admin` | `researcher`, `supervisor` | `researcher`, `supervisor` |
| `supervisor`, `researcher` | none | none |

Managing an account means editing its name, institution and role, revoking its
sessions, suspending or reactivating it, deleting it, and resending its
invitation. Three things are for a master admin alone: inviting and managing
admins, setting any role on any account, and changing the email address of an
account that is in use. Instance settings and the audit log are open to both
admin roles. The matrix is `private.can_manage_role` in the database, and
`supabase/tests/database/022_authz_helpers.test.sql` holds it in place.

**No admin console.** The app has none. Administration is a set of database
functions (`admin_*` and `master_*`) and the `admin` Edge Function,
open to any client that is signed in as an administrator. Such a client is as
untrusted as every other: it offers actions, and the database allows or refuses
each one. [deployment.md](./deployment.md#administering-your-own-instance)
lists the functions and their arguments.

**The last master admin.** An instance must always keep one usable master
admin: active, with a confirmed email address and a password. Demoting,
suspending or deleting the last one is refused. The rule is a trigger on the
`profiles` table, so it holds on every path, including a delete of the user from
the Supabase dashboard.

**No default admin.** Nothing is seeded, and nobody is promoted for signing up
first. The operator of an instance signs up in the app like anyone else and
then runs `private.bootstrap_master_admin(...)` once from the SQL editor. That
function is not reachable through the API. See
[deployment.md](./deployment.md).

## Where things live

| Concern | Path |
|---|---|
| Study-type configs (data) | `src/lib/study/configs/`, `src/lib/study/systematic-review.ts` |
| Pathway engine | `src/components/runner/`, `src/lib/study/` |
| Rich step tools | `src/components/runner/tools/` |
| Data sources (BYO-key) | `src/lib/sources/` |
| Validated statistics | `src/lib/stats/` |
| Paper compile/export | `src/lib/paper/` |
| Discussion and sign-off (local-first) | `src/lib/collab/collab.ts`, `src/components/runner/StepCollab.tsx` |
| Account client, session, sign-in flows | `src/lib/supabase/`, `src/lib/account/`, `src/features/auth/` |
| Link records, sync, invitations | `src/lib/collab/` |
| Shared form and feedback primitives | `src/components/ui/` |
| Organisation settings in the app | `src/lib/instance/` |
| Account backend | `supabase/` (migrations, tests, the `admin` function, email templates) |
| Administration (no console here: functions only) | `supabase/migrations/` (`*_rpc_admin.sql`, `*_rpc_settings.sql`, `*_audit_feed.sql`), `supabase/functions/admin/` |
| Desktop shell | `src-tauri/` |

See [deployment.md](./deployment.md) for shipping the app and for running an
account backend.

## "Legacy" in the backend's comments

Scholea's first account backend was a small Node server kept in `server/`. It
was removed when accounts moved to Supabase. Comments under `supabase/` that
speak of the legacy server, the old server or "legacy parity" mean that server:
the database tests were first written from its tests, so that the behaviour it
guaranteed was kept or changed on purpose.
