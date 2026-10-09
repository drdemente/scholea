# Security Policy

## Supported Versions

Scholea is pre-1.0 and under active development. Security fixes are applied to
the latest release and the `main` branch.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| < latest | ❌       |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) ("Report a
vulnerability" under the repository's **Security** tab). This creates a private
advisory visible only to you and the maintainers.

Please include as much of the following as you can:

- The type of issue (e.g. XSS, injection, auth bypass, privilege escalation,
  data exposure)
- Affected component: the web app, the desktop (Tauri) app, or the account
  backend defined in `supabase/` (migrations, policies, database functions, the
  Edge Function, email templates)
- Steps to reproduce, or a proof-of-concept. Use an account and a project of
  your own; do not access other people's data
- The impact, whether it needs an account, and which role (a guest, any
  signed-in person, a project member, an admin)

Never include passwords, one-time codes or keys in a report.

You can expect an initial response within a few days. We will keep you informed
as we work on a fix and will credit you in the advisory unless you prefer to
remain anonymous.

## Scope and design notes

### Local-first

Scholea works without an account. Then there is no backend: a person's projects
live in their own browser (IndexedDB) or desktop storage. Literature sources and
AI providers are called directly from the app with that person's own keys
(bring your own key). A build that was given no account backend has no account
UI and makes no request to one.

### Optional accounts on Supabase

Accounts add sync across devices and sharing, and they give whoever runs the
backend the means to administer accounts. They run on a Supabase project. This
repository holds everything that defines that backend (`supabase/`: schema,
policies, functions, the Edge Function, email templates, tests) and no
credentials. The project URL and publishable key that are compiled into a build
are public identifiers, not secrets.

The app has no admin console. Accounts are administered by calling the
backend's admin functions, which check the caller on every call like every
other function, so a tool that calls them is trusted no more than the app is
(see [docs/deployment.md](./docs/deployment.md#5-roles-and-administration)).

- **Passwords** are stored and verified by Supabase Auth. Scholea never stores
  or hashes one, and the app never keeps an access token outside the Supabase
  client's own session storage.
- **A functions-only Data API.** No API role (`anon`, `authenticated`,
  `service_role`) can read or write any table. Everything a client reads or
  changes goes through a database function. Row Level Security policies stay on
  every table as a second lock, in case a grant is ever added by mistake.
- **Authorization is decided in the database.** Each function identifies its
  caller from the verified sign-in token and re-checks, on every call, that the
  account is active, has a password, and that its session still exists. Then it
  checks the role the action needs. Roles are read from the database, never
  from the token or from anything the client sends. The UI only decides what to
  offer. (Two functions skip part of that check and return only the caller's
  own account record; docs/architecture.md says which and why.)
- **Immediate cut-off.** Because the session is re-checked on every call,
  suspending or deleting an account and "revoke sessions" take effect on the
  person's next request, not when their token expires. The same holds for a
  sign-out once the backend has been told of it.
- **One Edge Function** (`admin`) does the steps that need Supabase's Auth
  admin API: send an invitation, change an email address, ban, soft delete. It
  verifies the caller's token itself, and its first step is always a database
  function called with the caller's own token, so the database decides. The
  secret key exists only inside that function's runtime, where the platform
  provides it. It is used for the Auth admin API and nothing else: its role has
  no grant on any Scholea table or function.
- **One-time codes, no links.** Sign-up confirmation, password reset,
  administrator invitations and confirming a changed address all use a code
  that the person types into the app. No email from Scholea contains a link to
  click.
- **No default administrator.** Nothing is seeded, and signing up first grants
  nothing. The operator promotes the first master admin from the SQL editor
  (see [docs/deployment.md](./docs/deployment.md)).
- **Audit log.** Privileged actions and sign-in events are written to an
  append-only table in the same transaction as the change.
- **Research API keys** are stored on the device only. They are sent to the
  service they belong to and are never part of what syncs.

How these pieces fit together is described in
[docs/architecture.md](./docs/architecture.md).

### Known limits

- **No per-account lockout.** Supabase throttles sign-in attempts per IP
  address. Repeated wrong passwords do not lock an account.
- **Address enumeration through Auth.** Scholea's own functions never tell
  anyone but an administrator whether an email address has an account. Supabase
  Auth's public endpoints can: for example, a sign-in code can be requested only for an existing
  account, and a suspended account answers differently from an unknown one.
  Auth's rate limits slow this down. Supabase's CAPTCHA protection would do
  more, but the app does not send a CAPTCHA token yet, so it cannot be turned
  on (see docs/deployment.md).
- **The operator can read stored data.** Whoever operates the Supabase project
  can read everything stored in it. Synced projects are not end-to-end
  encrypted. Do not sync data that identifies patients or participants.
- **A master admin can take over an account.** A master admin can change the
  email address of any account on their instance, and whoever reads the new
  mailbox can then reset its password. The change is immediate, the old address
  is not notified, and the action is written to the audit log.
- **Signing out hides, it does not erase.** Projects from an account stay in
  the device's storage after sign-out, hidden by the app. API keys are kept in
  the app's local storage without encryption. Anyone who can use the same
  browser profile or desktop user account can reach both.
- **No multi-factor authentication and no social sign-in.**
