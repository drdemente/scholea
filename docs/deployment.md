# Deployment

Scholea is one codebase that ships in two forms:

- **Guest-only.** No backend at all. This is what you get by default, and it is
  the complete research app.
- **With accounts.** The same app, built with the address of a Supabase project.
  People can still use it without an account; those who sign in get sync and
  sharing.

There is no Scholea server to run in either form. The optional account backend
is a Supabase project, defined entirely by the files in [`supabase/`](../supabase).
It is administered by calling its own functions: the app has no admin console
([section 5](#5-roles-and-administration)).

Contents:

1. [Shipping the app with no backend](#1-shipping-the-app-with-no-backend),
   including [Publishing a release](#publishing-a-release)
2. [Running the account backend locally](#2-running-the-account-backend-locally)
3. [A hosted Supabase project: maintainer checklist](#3-a-hosted-supabase-project-maintainer-checklist)
4. [Auth settings](#4-auth-settings)
5. [Roles and administration](#5-roles-and-administration), including
   [Administering your own instance](#administering-your-own-instance)
6. [Operations](#6-operations)
7. [Pointing a fork at your own project](#7-pointing-a-fork-at-your-own-project)
8. [Known limits](#8-known-limits)

## 1. Shipping the app with no backend

One local user, no sign-in, all data in the browser or the desktop app's
storage.

- **Desktop app.** Tauri v2 packages the build into `.dmg` (macOS),
  `.msi`/`.exe` (Windows), and `.deb`/`.AppImage` (Linux). Requires Rust and
  the platform toolchain locally:
  ```bash
  pnpm install
  pnpm tauri build      # artifacts in src-tauri/target/release/bundle/
  ```
- **Static web.** Deploy the `dist/` bundle to any static host:
  ```bash
  pnpm install && pnpm build   # → dist/
  ```
  CORS-friendly sources (OpenAlex, Crossref, Europe PMC) work directly. PubMed
  E-utilities are not CORS-enabled, so the web build needs a thin proxy; see
  [`proxy/README.md`](../proxy/README.md). The desktop app needs no proxy.

A build made this way contains no backend address and no key, shows no account
UI, and makes no request to an account backend. CI builds the app this way and
checks the bundle for addresses and keys. A version tag builds the web bundle
and the desktop installers; see [Publishing a release](#publishing-a-release).

A few optional extras are fetched from public CDNs when a person asks for them,
and are never bundled: the WebR + `metafor` and Pyodide + SciPy cross-checks,
and citeproc with CSL journal styles. When one cannot be loaded, the app says so
and keeps its built-in results and its built-in APA, Vancouver and Harvard
styles. Their addresses are constants in `src/lib/stats/webr.ts`,
`src/lib/stats/pyodide.ts` and `src/lib/paper/cite/csl.ts`. There is no setting
for them: to load them from somewhere else, change those constants and rebuild.

These extras are scripts loaded from other addresses. The desktop app's content
security policy (`src-tauri/tauri.conf.json`) names no script source besides the
app itself, so they may not load in the desktop app. That has not been tested;
the built-in results and styles do not depend on them.

### Publishing a release

The release workflow
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) builds
the web bundle and the desktop installers for macOS, Windows and Linux, and
attaches them to the GitHub Release of a version tag. A version tag starts
with `v`, as in `v0.2.0`. No other tag starts a build, and a release published
under another tag gets no files. The workflow builds the guest-only app unless
the two repository variables of
[step 8](#step-8-give-the-app-the-two-public-values) are set.

Before you tag, set the new version in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, commit, and push the
commit to `main`. Keep the version to numbers, as in `0.2.0`: the Windows
`.msi` installer cannot be built from a version with letters in it. The
installers are named after the version in `tauri.conf.json`, not after the tag.
When the two differ, the workflow says so in a warning on the run's page and
builds anyway. The tag is then on a commit with the wrong version, and building
it again changes nothing: correct the version and release under the next
number. `src-tauri/Cargo.lock` repeats the version and needs no edit: Cargo
rewrites that line the next time the desktop app is built on a computer, and
the changed file can be committed then.

Then start the build in one of two ways:

- **On GitHub.** Open Releases and choose "Draft a new release". Under "Choose
  a tag", type a new tag such as `v0.2.0` and choose "Create new tag". Leave
  the target on `main` and choose "Publish release". Publishing creates the tag
  on the newest commit of `main`, and the tag starts the build. The files
  appear on the release as each build finishes, the desktop installers last,
  several minutes later. "Save draft" creates no tag, so nothing is built until
  the release is published.
- **From the command line.** `git tag v0.2.0 && git push origin v0.2.0`. No
  release exists yet, so the workflow creates a draft and attaches the files to
  it. Publish the draft on the Releases page when the builds are done.

To build a tag again, after a failed run or to replace its files, open Actions,
choose the Release workflow, choose "Run workflow", leave the branch on `main`,
type the tag and choose the green "Run workflow" button. The run takes the
workflow from `main` and the code from the tag, uses the repository variables
as they are now, and replaces the files of the same name on the tag's release.
Each file is removed a moment before its replacement is attached. If a run
fails in between, that file is missing from the release until the workflow is
run again. "Re-run all jobs" on an earlier run is not the same: it runs the
workflow as it was for that run, so it does not pick up a later change to the
workflow.

Every build attaches its files to one release, which the workflow picks before
it builds anything: the published release of the tag, or else the tag's draft,
or else a new draft. A draft is marked "Draft" on the Releases page, and only
people who can write to the repository see it. When a tag has a published
release and a draft as well, the files go to the published one and the run says
so: delete the entry marked "Draft" with its trash icon. Deleting a release
leaves the tag in place.

A finished release holds the web bundle (`scholea-web-<tag>.zip`) and the
desktop files: for macOS a `.dmg` and an `.app.tar.gz`, for Windows an `.msi`
and a `-setup.exe`, and for Linux a `.deb`, an `.rpm` and an `.AppImage`.

The installers carry no developer certificate: that needs paid certificates,
which are not set up in this repository. Windows shows a SmartScreen warning
before it runs the installer; the person chooses "More info" and then "Run
anyway". A Windows 11 computer with Smart App Control turned on blocks the
installer and offers no way to allow a single app. The macOS app is signed ad
hoc, without an Apple developer identity, and is not notarized, so macOS
refuses to open a downloaded copy the first time. After that first try, the
person chooses "Open Anyway" under System Settings, Privacy & Security.

This repository leaves GitHub's "Enable release immutability" setting
(Settings, Releases) off. With it on, GitHub takes no new, changed or removed
files on a release once it is published: publishing on GitHub first fails when
the builds try to attach their files, and a tag whose release is published
cannot be built again. Use the command line way instead, where the workflow
fills a draft and you publish it when the builds are done.

## 2. Running the account backend locally

For development and for trying the account features. You need Docker and the
Supabase CLI. This repository is developed and tested against CLI **2.111.0**.

```bash
# From the repository root. Starts Postgres, Auth, the API gateway, PostgREST,
# the mail catcher and the edge runtime, and applies supabase/migrations.
supabase start -x studio,postgres-meta,imgproxy,storage-api,realtime,logflare,vector,supavisor

# Write the two public settings the app reads at build time.
supabase status -o env | awk -F= '
  $1 == "API_URL"         { print "VITE_SUPABASE_URL=" $2 }
  $1 == "PUBLISHABLE_KEY" { print "VITE_SUPABASE_PUBLISHABLE_KEY=" $2 }
' | tr -d '"' > .env.local

pnpm dev        # http://localhost:5193, now with a Sign in button
```

What to know about the local stack:

- **Ports.** It uses the 5632x block so it can run beside other local Supabase
  projects: API `http://127.0.0.1:56321`, Postgres `127.0.0.1:56322`, mail
  catcher `http://127.0.0.1:56324`.
- **Email.** Nothing is sent. Every message lands in the mail catcher; open it
  in a browser to read confirmation, reset and invitation codes.
- **Settings.** `supabase/config.toml` configures this local stack only. It
  matches what a hosted project should be set to (section 4), with two
  exceptions. The rate limits and the wait between emails are loosened so the
  tests are not throttled. And "Require current password" is not enforced,
  because the CLI has no setting for it.
- **First administrator.** Create an account in the app, then promote it:
  ```bash
  docker exec -i supabase_db_scholea psql -U postgres -d postgres \
    -c "select private.bootstrap_master_admin('you@example.test');"
  ```
  [Section 5](#administering-your-own-instance) says how that account then
  administers the instance. Against the local stack, the example there takes
  `SUPABASE_URL=http://127.0.0.1:56321` and the `PUBLISHABLE_KEY` that
  `supabase status -o env` prints.
- **Tests.** `supabase test db` runs the database tests (pgTAP).
  `pnpm test:supabase` runs the end-to-end tests of sign-up, password reset,
  invitations and every admin action, and needs Deno 2.
- **Starting over.** `supabase db reset` rebuilds the database from the
  migrations and deletes every local account and project. `supabase stop`
  stops the stack. Delete `.env.local` to get the guest-only app back.

`.env.local` is read by `pnpm dev`, `pnpm build` and `pnpm tauri build` alike.
If you would rather keep those guest-only, write the same two lines to
`.env.supabase.local` and run `pnpm exec vite --mode supabase`.

## 3. A hosted Supabase project: maintainer checklist

Everything in this section is done by the person who owns the Supabase project,
once, in this order. Contributors never do any of it.

**Never run `supabase config push`.** `supabase/config.toml` holds local-only
limits and addresses. Hosted settings are set by hand, from the table in
section 4.

### Step 1. Create the project

Create a project in the Supabase dashboard and note its project ref. About the
Free plan, as Supabase documented it when this was written:

- It allows two free projects per person, counted across the organisations you
  own or administer.
- A Free project that shows low activity over a week may be paused (see
  [Operations](#6-operations)).
- It has no automated backups.

### Step 2. Auth settings

Set the Auth settings listed in [section 4](#4-auth-settings). They decide how
sign-up, codes and passwords behave, and the app is written against those
values.

### Step 3. Email: custom SMTP, then the rate limit

Connect an email provider as custom SMTP (Supabase's documentation names
Resend, AWS SES, Postmark, SendGrid, ZeptoMail and Brevo among others), then
raise the email rate limit on the Auth rate limits page.

This step is not optional. Supabase's built-in sender delivers only to the
addresses of the project's own team, at about two emails an hour, so without it
no real person can confirm a sign-up. Right after custom SMTP is switched on,
Supabase applies a low limit (30 emails an hour when this was written); raise it
to what your provider and your user numbers call for.

### Step 4. Email templates

Paste each file from [`supabase/templates/`](../supabase/templates) into the
email template of the same kind, with its subject. Supabase's documentation
names the hosted templates as below; if the dashboard words them differently,
match them by purpose.

| File | Hosted template | Subject |
|---|---|---|
| `confirmation.html` | Confirm sign up | Your Scholea confirmation code |
| `recovery.html` | Reset password | Your Scholea password reset code |
| `invite.html` | Invite user | Your Scholea invitation code |
| `magic_link.html` | Magic link or OTP | Your Scholea sign-in code |
| `email_change.html` | Change email address | Confirm your new Scholea email address |
| `password_changed.html` | Password changed (a security notification, which also has to be switched on) | Your Scholea password was changed |

What this is for: the app has no way to open a link from an email, so every
flow uses a code that the person types in. The first five templates print the
code (`{{ .Token }}`) and contain no link. If a default template with a
confirmation link is left in place, that flow cannot be completed. The sixth
only tells a person that their password was changed. The app never asks for a
reauthentication email, so that template can stay as it is.

The templates say that a code expires in 24 hours. If you set a different
expiry in step 2, change that sentence before you paste.

### Step 5. Apply the migrations

From the repository root, on the commit you are releasing:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --dry-run     # lists the migrations that would be applied
supabase db push               # applies them
```

Read the dry run before the real push: on a new project it should list every
file in `supabase/migrations/`, oldest first. This creates the tables, the
functions, the policies and the triggers on Supabase Auth's user table. The
seed file is empty on purpose: no user and no administrator is created.

### Step 6. Deploy the Edge Function

```bash
supabase functions deploy admin
```

There are no secrets to set. The platform gives the function the project URL
and keys at run time. Do not pass `--no-verify-jwt`. The function does the
administrative actions that need Supabase's Auth admin API: inviting, changing
an email address, suspending and deleting (section 5). The research app never
calls it, so the app works without it. Only those actions fail until it is
deployed.

### Step 7. Post-deploy check

In the SQL editor:

```sql
select has_table_privilege('postgres', 'auth.one_time_tokens', 'SELECT');
```

It must answer `true`. What this is for: when an administrator changes
someone's email address, Scholea treats the new address as unconfirmed until
its holder types a code that was sent to it, and it recognises such a code by
reading Auth's own record of issued codes. If the answer is `false`, that
record cannot be read, an address changed by an administrator can never be
confirmed, and that person stops seeing project invitations. Do not go live in
that state; open an issue.

### Step 8. Give the app the two public values

Find the project URL and the publishable key (`sb_publishable_...`) in the
dashboard's API keys settings. They are public identifiers, not secrets.

- For builds on your own machine, put them in `.env.local` (git-ignored):
  ```dotenv
  VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
  ```
- For release builds, add them to the GitHub repository as **variables**, not
  secrets (Settings → Secrets and variables → Actions → Variables), under the
  same two names. The release workflow reads them from there, for the desktop
  installers and the web bundle alike. With neither set it releases the
  guest-only app.

The address must start with `https://`. The release workflow refuses anything
else, and the desktop app cannot reach a plain `http://` address other than
this computer's own, which is what the local stack uses.

Never use the secret key (`sb_secret_...`) or a legacy `service_role` key here.
A build writes these values into its files, where anyone can read them. Three
checks stand in the way:

- The release workflow stops before it builds anything.
- `pnpm build` stops with an error that names the setting, and writes nothing.
  So does `pnpm tauri build`, which runs `pnpm build` first. This covers every
  `VITE_*` value, whether it comes from the environment or from an `.env` file.
- The app itself never uses such a key.

The dev server is not a build and does not stop. Given a secret key, it serves
the guest-only app to your own machine, with the key's text in the scripts it
serves. If a secret key ever did end up in files that left your machine, replace
it in the Supabase dashboard.

### Step 9. Sign up and promote the first master admin

A new instance has no administrator, and nothing promotes anyone automatically.

1. Open the app (built with the two values), create an account with your own
   email address, and confirm it with the emailed code.
2. In the SQL editor run:
   ```sql
   select private.bootstrap_master_admin('you@example.org');
   ```
   It answers `{"created": true, ...}`. Other answers say why not:
   `no-active-user-with-that-email`, `email-not-confirmed-or-password-not-set`,
   or `master-exists` (an instance already has one).
3. The account is now a master admin. The app looks the same to it as to
   anyone else, because the app has no administration screens. The account
   administers the instance by calling the admin functions:
   [Administering your own instance](#administering-your-own-instance).

The bootstrap function cannot be reached through the API. It runs only from the
SQL editor or `psql`, as `postgres`.

### Step 10. Smoke test

With real email, on the hosted project:

- Sign up with a second address. The code arrives, and a wrong code is refused.
- Sign up again with an address that already has an account. The app shows the
  code step and no email arrives (see "Phone confirmations" in section 4).
- Forgot password: code, new password, and the old password stops working.
- As the master admin, invite a user with the `invite_user` action
  ([section 5](#administering-your-own-instance) has a script that does it).
  They enter the invitation code under "Have an invitation code?" and set a
  password.
- Suspend that user with `suspend_user` while they are signed in on another
  device. Their next action is refused and they see why. Activate them again
  with `activate_user`.
- Share a project: invite the second account, accept it there, comment in both
  directions, and sign a step off as a supervisor.
- Sign in on a second device and see the same projects.

Pay particular attention to the three steps where a password is saved after a
code: sign-up, the invitation and the reset. "Require current password"
(section 4) cannot be switched on in the local stack, so the automated tests do
not cover it. It was checked by hand against the Auth version the local stack
runs, with the setting forced on, and each of the three took a password with
one code. Your project may run a newer Auth. If the app asks anyone for a second
code straight after the first, open an issue.

## 4. Auth settings

The left column is what the local stack runs with (`supabase/config.toml`), and
what the tests run against. Set a hosted project to the right column by hand.
Dashboard wording changes over time; match settings by meaning.

| Setting | Local config | Set on the hosted project |
|---|---|---|
| Allow new users to sign up | `enable_signup = true` | On |
| Confirm email | `[auth.email] enable_confirmations = true` | On. An account cannot sign in until its address is confirmed with the code |
| Minimum password length | `minimum_password_length = 10` | 10. The app tells people "At least 10 characters." |
| Email code (OTP) length | `otp_length = 8` | 8. The app accepts codes of 6 to 10 digits |
| Email code (OTP) expiry | `otp_expiry = 86400` | 86400 seconds (24 hours), which is what the templates tell people |
| Phone sign-up | `[auth.sms] enable_signup = false` | Off |
| Phone confirmations | `[auth.sms] enable_confirmations = true` | On, even though phone sign-up is off. See below |
| Secure password change (a recent sign-in is needed to change a password) | `secure_password_change = true` | On. The app signs the person in again before it changes a password |
| Require current password when changing a password | no such key in CLI 2.111.0; not enforced locally | On. See below |
| CAPTCHA protection | not configured | **Off.** See below |
| Anonymous sign-ins | `enable_anonymous_sign_ins = false` | Off |
| Multi-factor authentication | TOTP and phone both off | Off. The app has no screen for a second factor |
| Rate limits | raised (`[auth.rate_limit]`) for the tests | Keep the hosted defaults, except the email limit from step 3 |
| Minimum time between emails to one address | `max_frequency = "1s"`, for the tests | Keep the hosted default. The app makes people wait a minute before asking for another code |
| Site URL and redirect URLs | `http://localhost:5193` and the desktop app's origins | The address of your web build. No email contains a link, so nothing depends on it |

**Phone confirmations.** Supabase Auth hides "this address already has an
account" from sign-up only when no sign-in provider confirms automatically.
With this on, signing up with an address that already has a confirmed account
answers like a fresh sign-up and sends nothing, and the app's code step says so
("If you already have a Scholea account with this address, no code is sent").
With it off, Auth says outright that the address is taken.

**Require current password.** With this on, Auth refuses a password change that
does not carry the account's current password, except in a session that began
with an emailed code. The app is written for both cases:

- **Change password** in the account menu signs the person in again with their
  current password and sends it along with the new one.
- **The password step after a code** (sign-up, invitation, reset) needs no
  current password: Auth treats a session that began with a typed code as a
  password-recovery session.

So people see no difference with the setting on. What it adds is that a session
that began with a password sign-in, if someone else gets hold of it, cannot be
used to change the password without knowing it. A session that began with a code
is not covered.

The setting does not stand in the way of one deliberate write. After a sign-up
code is accepted, the app writes the password the person typed over whatever the
account holds. This closes a gap: someone else could have registered the address
first, with their own password, before its owner confirmed it. The account ends
up with its owner's password, and the earlier one stops working.

If Auth refuses a password write after a code anyway (it can, under "Secure
password change", when the person comes back to an unfinished password step in a
session Auth considers too old), the app sends a reset code and asks for it
before it lets a password be set.

The local stack cannot switch this setting on, so `supabase test db` and
`pnpm test:supabase` run without it. What is written here was checked by hand
on Auth v2.194.0, the version the local stack runs, started with
`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD=true`: a password
sign-in session was refused a new password without the current one and with a
wrong one, and accepted with the right one. A session from an invitation code
and one from a reset code each set a password with no current one. A session
from a sign-up code replaced a different password that had been registered for
the address first.

**CAPTCHA.** Supabase offers CAPTCHA protection for sign-up, sign-in and
password reset, and it is the stronger answer to the probing described under
[Known limits](#8-known-limits). Do not turn it on yet. With it on, Auth refuses
every such request that carries no CAPTCHA token, and this version of the app
never sends one, so nobody could sign up, sign in with a password or reset one.
It can be turned on once the app has a CAPTCHA widget.

## 5. Roles and administration

The app has no admin console. The administration layer is the backend itself:
the instance roles, the `admin_*` and `master_*` database functions, the
`admin` Edge Function, the audit log and the instance settings, all in
[`supabase/`](../supabase). The maintainer administers the official instance
with a tool of their own, which is not part of the app. If you run your own
instance, you call the same functions from a tool of your own, or you work from
SQL and the Supabase dashboard:
[Administering your own instance](#administering-your-own-instance) says how.
No client protects anything. The database decides what each caller may do.

**Instance roles**, lowest first: `researcher < supervisor < admin < master_admin`.
Every new account is a `researcher`. `researcher` and `supervisor` hold no
privilege of their own; what a person can do in a project comes from their role
on that project, which its owner sets in Share.

| Acting role | Accounts it may manage | Roles it may assign |
|---|---|---|
| `master_admin` | any | any of the four |
| `admin` | `researcher`, `supervisor` | `researcher`, `supervisor` |
| `supervisor`, `researcher` | none | none |

What an administrator can do:

- **Users.** People are **invited**: they get a code by email and choose their
  own password. No temporary password exists anywhere. An administrator can
  also edit a name, institution and role, sign someone out everywhere (revoke
  sessions), suspend and reactivate, delete, and send an unused invitation
  again.
- **Administrators** (master admin only). Invite and manage admins and master
  admins, and give any account any of the four roles.
- **Audit log.** Every privileged change, with who made it, to what, and the
  values before and after. Reading is not recorded, and neither is sending an
  unused invitation again. Each account's own sign-ins, password changes and
  profile changes are recorded too. An entry can never be changed or removed.
- **Settings.** Organisation name, support email, a contact line, an accent
  colour, and the study types offered for new projects. They apply to
  **signed-in people only**; a guest always sees stock Scholea. There are no
  shared API keys: everyone enters their own.

Things an administrator should know first:

- **Suspension is immediate.** It ends the person's sessions in the same step,
  so their very next request is refused. Their projects are kept.
- **Deletion cannot be undone.** The account's record is kept for the audit
  log without its email address. The address becomes free, so the person could
  sign up again, as a new account with none of the old one's projects.
- **Changing the email of an account in use is for a master admin only.** It
  takes effect at once, the old address is not notified, and the new address
  stays unconfirmed until the person types a code sent to it. Whoever reads the
  new mailbox can then reset the password, so this moves the account. An admin
  may still correct the address of an account nobody can use yet (an unused
  invitation, or a sign-up that was never confirmed).
- **Administrators cannot open other people's projects.** Managing accounts
  does not make anyone a member of a project.
- **The last master admin is protected.** An instance must keep one usable
  master admin (active, confirmed address, password set). Demoting, suspending
  or deleting the last one is refused on every path, including a delete of the
  user from the Supabase dashboard.
- **No default admin.** Nothing is seeded. See step 9.

**If the only master admin can no longer sign in** (for example, the mailbox
and the password are both lost), the owner of the Supabase project can promote
another account from the SQL editor.
The second argument skips the "a master admin already exists" answer:

```sql
select private.bootstrap_master_admin('someone-else@example.org', true);
```

### Administering your own instance

An administration tool is a client like any other. It signs in as an account
whose role is `admin` or `master_admin`, with the project URL and the
**publishable** key, and then calls functions. Every function checks its caller
on every call, so the tool needs no key of its own and decides nothing. Do not
build one around the secret key. Its role is granted none of these functions,
so all it could do is change Supabase Auth directly, with the results described
under [From the Supabase dashboard](#from-the-supabase-dashboard).

Here is a complete example with `supabase-js`. It needs Node 22 or later and a
folder where `@supabase/supabase-js` is installed, such as a checkout of this
repository after `pnpm install`:

```js
// admin-example.mjs: sign in as an administrator, list accounts, invite one person.
import { createClient } from "@supabase/supabase-js";

const invitee = process.argv[2]; // the address to invite

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});

const signIn = await supabase.auth.signInWithPassword({
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
if (signIn.error) throw signIn.error;

// A database function.
const list = await supabase.rpc("admin_list_users", { p_status: "active" });
if (list.error) throw new Error(`admin_list_users: ${list.error.code}`);
console.log(`${list.data.total} active accounts`);

// An action of the Edge Function.
const invite = await supabase.functions.invoke("admin", {
  body: { action: "invite_user", email: invitee, role: "researcher" },
});
if (invite.error) {
  // A refusal carries the HTTP status and a JSON body: { error: "<code>", message? }
  const answer = invite.error.context;
  console.error("invite_user was refused:", answer?.status, await answer?.json?.());
} else {
  console.log(`Invited ${invite.data.user.email} as ${invite.data.user.role}`);
}

// End this script's own session. Without the scope, every session of the
// account would end, on every device.
await supabase.auth.signOut({ scope: "local" });
```

```bash
export SUPABASE_URL=https://<your-project-ref>.supabase.co
export SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
export ADMIN_EMAIL=you@example.org
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD   # typed without echo, kept out of the shell history
node admin-example.mjs new.person@example.org
```

**How a call answers.** A database function that refuses answers with an HTTP
status and a code in `error.code`, for example `403 forbidden`,
`403 forbidden_role`, `404 not_found` or `409 last_master_admin`. The Edge
Function answers a refusal with a status and a JSON body
`{ "error": "<code>" }`, sometimes with a `message`. Accounts come back as one
object everywhere: `id`, `email`, `name`, `institution`, `role`, `status`
(`active`, `suspended` or `deleted`), `mustResetPassword` (true until an invited
person has chosen a password), `emailConfirmed` (false until the holder of the
address has typed a code that was sent to it), and `createdAt` and
`lastLoginAt` in epoch milliseconds.

**Database functions**, called with `supabase.rpc(name, args)`. "Admin" in the
second column means an admin or a master admin. `admin_update_user` and
`admin_revoke_sessions` also need the caller to be allowed to manage the
account (the table above). The exact rules and error codes are in the comments
of [`20261008011200_rpc_admin.sql`](../supabase/migrations/20261008011200_rpc_admin.sql),
[`20261008011300_rpc_settings.sql`](../supabase/migrations/20261008011300_rpc_settings.sql)
and [`20261008011500_audit_feed.sql`](../supabase/migrations/20261008011500_audit_feed.sql).
Where a later migration defines a function again, the later one is in force.

| Function and arguments | Caller | What it does |
|---|---|---|
| `admin_list_users(p_q, p_status, p_role)` | Admin | Accounts, newest first, as `{users, total}`. Every argument is optional: `p_q` is text to find in the email, name or institution, `p_status` is `active`, `suspended` or `deleted` (left out: everyone who is not deleted), `p_role` is one of the four roles. At most 1000 accounts are returned, and `total` counts every match |
| `admin_get_user(p_user_id)` | Admin | One account, as `{user}` |
| `admin_update_user(p_user_id, p_patch)` | Admin | Changes the name, institution or role. `p_patch` is an object with any of the keys `name`, `institution` and `role`. Answers `{user}`. Audited as `admin.user_updated` |
| `admin_revoke_sessions(p_user_id)` | Admin | Signs the account out everywhere, at once. The person can sign in again. Answers `{ok, revoked}`. Audited as `admin.sessions_revoked` |
| `admin_list_audit(p_limit, p_before, p_kind, p_action, p_done_by, p_target_id, p_from, p_to)` | Admin | The audit log, newest first, as `{entries, nextCursor}`. Every argument is optional. `p_limit` is 200 unless given, and at most 1000. `p_kind` is `admin` (what administrators did, and what the owner of the Supabase project did from SQL or the dashboard) or `auth` (what accounts did to themselves). `p_action`, `p_done_by` (an account id) and `p_target_id` narrow the list. `p_from` and `p_to` are times in epoch milliseconds. To read the next, older page, pass `nextCursor` back as `p_before` with the same filters |
| `admin_get_settings()` | Admin | The instance settings, as `{settings}` |
| `admin_update_settings(p_patch)` | Admin | Changes settings. `p_patch` is an object with any of the keys `orgName`, `supportEmail`, `footerContact`, `accent` (`""` for the stock colours, or a hex colour such as `#0f766e`) and `enabledStudyTypes` (`null` for every study type, or a list of study type ids such as `["systematic-review", "cohort"]`; see below). Answers `{settings}`. Audited as `admin.settings_updated` |
| `master_list_admins()` | Master admin | Admins and master admins, as `{admins}` |
| `master_set_role(p_user_id, p_role)` | Master admin | Gives any account any of the four roles. Answers `{user}`. Audited as `master.role_changed` |

A study type id is the `id` of a config under
[`src/lib/study/`](../src/lib/study). The backend checks only the form of an
id. The app ignores an id it does not know, and offers every study type when it
knows none of the ids in the list.

**Actions of the `admin` Edge Function**, called with
`supabase.functions.invoke("admin", { body })`, where `body` is an object with
an `action` and the fields below. These are the steps that also need Supabase's
Auth admin API. Each one starts with a database function called with the
caller's own token, so the same rules decide. The source is in
[`supabase/functions/admin/`](../supabase/functions/admin).

| `action` | Other fields | What it does |
|---|---|---|
| `invite_user` | `email`, `role`, and optionally `name`, `institution`, `surface` | Creates the account with that role and emails its invitation code. Answers status 201 with `{user}`. Audited as `admin.user_created` |
| `resend_invite` | `userId`, and optionally `surface` | Emails a new code to an account that is still waiting for its invitation code. Any other account answers `409 not_pending`. Not audited |
| `update_email` | `userId`, `email` | Changes the address at once. For an account that is in use, only a master admin may (see the rule above), and an admin is answered `403 forbidden`. Answers `{user}`. Audited as `admin.user_updated` with the address before and after |
| `suspend_user` | `userId`, and optionally `surface` | Suspends the account, ends its sessions and blocks new sign-ins. Answers `{ok, revokedSessions}`. Audited as `admin.user_suspended` |
| `activate_user` | `userId`, and optionally `surface` | Lifts a suspension. Audited as `admin.user_activated` |
| `delete_user` | `userId`, and optionally `surface` | Deletes the account (see "Deletion cannot be undone"). Audited as `admin.user_deleted` |

`surface` is `"admin"` when left out. `"master"` is meant for a master admin
acting on admins and master admins. It refuses every caller who is not a master
admin, and it records the action under a `master.` name
(`master.admin_created`, `master.admin_suspended`, `master.admin_activated`,
`master.admin_deleted`). A surface never widens what the caller may do. For
`invite_user`, `role` is required on the admin surface. On the master surface
it may be `admin` or `master_admin`, and is `admin` when left out.

An action has a database step and an Auth step. If the Auth step fails, the
answer is `502 auth_sync_failed`, and whatever was done so far leaves the
account in the more restrictive state: a suspended account is already locked
out, for example. Run the same action again to finish it. `429 rate_limited`
means too many emails or requests in a short time. `502 smtp_not_configured`
means the email service refused to send to the address: check the email setup
of step 3.

Five more functions exist for the Edge Function: `admin_begin_invite`,
`admin_begin_email_change`, `admin_check_user_action`, `admin_set_user_status`
and `admin_soft_delete_user`. An administrator's token may call them, but each
is only the database half of an action. Called alone, `admin_set_user_status`
suspends an account without blocking its sign-in in Auth, and
`admin_soft_delete_user` deletes one without freeing its address. Use the
actions.

#### From the Supabase dashboard

The owner of the Supabase project can also work in its dashboard and SQL
editor. That is the right place for some things and the wrong place for others.
The functions above record who did what in the audit log, and they change
Scholea's own record of an account (`public.profiles`, which holds its role and
status) together with what Supabase Auth holds. A change made in the dashboard
does neither reliably.

Fine from the dashboard or the SQL editor:

- Reading. `select` from `public.profiles`, `public.audit_log` and
  `public.instance_settings` shows the accounts, the audit log and the
  settings.
- Promoting a master admin with `private.bootstrap_master_admin` (step 9 and
  above). It writes its own audit entry, `master.provisioned`.
- Auth settings, email templates and backups (sections 3, 4 and 6).

Use the functions instead for anything that changes an account or a setting:

- **A user added or invited in the dashboard** becomes an ordinary
  `researcher`, and nothing is written to the audit log. A role travels with
  an invitation only through `invite_user`.
- **A ban set in Auth alone is not a suspension.** It refuses new sign-ins, but
  Scholea's own status for the account stays `active`, and nothing is audited.
  A session that is already open keeps working until its access token expires
  (an hour by default), because Auth only refuses to renew it. `suspend_user`
  sets the status, ends the sessions, writes the audit entry and sets the ban.
- **An email address changed in the dashboard** takes effect, and stays
  unconfirmed until the person types a code sent to it, as after
  `update_email`. The audit entry is `admin.email_changed_unattributed`, with
  nobody named. After `update_email` it names the administrator.
- **A user deleted in the dashboard** has their Scholea record marked deleted,
  or removed together with the Auth user if the delete is a permanent one.
  Neither writes an audit entry. `delete_user` records who deleted the account,
  and the email and role it had.
- **Rows edited in SQL** (a role in `public.profiles`, a value in
  `public.instance_settings`) take effect and are not audited. Use
  `admin_update_user`, `master_set_role` and `admin_update_settings`.

Two rules hold on every path, the dashboard included. The last usable master
admin cannot be demoted, suspended or deleted. And an audit entry cannot be
changed or removed: a trigger refuses every update and delete of
`public.audit_log`.

## 6. Operations

**Pausing (Free plan).** Supabase may pause a Free project that shows low
activity over a week. While it is paused, signing in, sync, sharing and
administration fail. The app itself keeps working: people keep editing on their
devices. Once the project is back their changes upload, after signing in again
if the app asks for it. To restore a paused project, open it in the Supabase
dashboard and use the restore button there. Supabase allows this for a limited
time after pausing; after that it offers the data as a backup file to download
instead. Supabase describes pausing as something that happens to Free projects.

**Backups.** The Free plan has no automated backups; Supabase backs up paid
projects daily. On the Free plan, export the data yourself on a schedule and
keep the copies somewhere else. The schema needs no backup: it is the
migrations in this repository. The data is in two places, Scholea's tables
(schema `public`) and the accounts (Supabase's `auth` schema):

```bash
supabase db dump --linked --data-only --schema public,auth -f scholea-data.sql
```

This repository contains no tested restore procedure. Rehearse a restore into a
scratch project before you depend on these files.

**Rotating the publishable key.** The key is compiled into every web and
desktop build. If you replace it, every build already out in the world keeps
sending the old key, and from the moment the old key stops working those builds
can no longer sign in or sync. People's work on their devices is unaffected,
and nothing is lost: it uploads again once they run a build with the new key.
So the order matters. Create the new key, put it in `.env.local` and in the
GitHub variable, [publish a release](#publishing-a-release) and redeploy the
web build, give people time to update, and only then disable the old key. The publishable key is not a
secret, so there is no security reason to rotate it; a leaked **secret** key is
a different matter, and that one is never in a build or in this repository.

**Applying later changes.** New migrations and function changes arrive through
pull requests. After merging, repeat steps 5 and 6 (`supabase db push --dry-run`,
`supabase db push`, `supabase functions deploy admin`) and step 7.

## 7. Pointing a fork at your own project

A fork that sets nothing builds the guest-only app, and its CI needs no secret
and no variable. To give your fork accounts:

1. Create your own Supabase project and go through the checklist in section 3.
2. Locally, put your project's two values in `.env.local`.
3. For release builds, add `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` as repository variables of your fork.

Set both or neither. With only one of the two, the release workflow fails
before it builds, and a local build treats itself as having no backend. The
release workflow also refuses an address that is not `https://` followed by a
host name, and a secret key (step 8).

Your users' accounts and synced projects then live in your Supabase project,
and you are its operator, with everything that implies under
[Known limits](#8-known-limits).

## 8. Known limits

- **Throttling is per IP address, not per account.** Supabase Auth limits
  sign-in attempts by address of origin. There is no lockout of an account
  after repeated wrong passwords.
- **Auth can reveal whether an address is registered.** Scholea's own functions
  never tell anyone but an administrator. Auth's public endpoints can: a sign-in code can be requested only
  for an existing account, and a suspended account answers differently from an
  unknown one. Auth's rate limits slow this down. CAPTCHA would do more and
  cannot be used yet (section 4).
- **The operator can read what is stored.** Whoever operates the Supabase
  project can read every synced project, comment and account record. Synced
  data is not end-to-end encrypted. Tell your users not to sync data that
  identifies patients or participants.
- **Sync keeps the newest edit of a whole project.** Two people editing the
  same project at the same moment do not merge: the later save replaces the
  earlier one. There is no live collaboration; changes arrive at the next sync.
- **A project's content is limited to 20 MB** in an account. A larger project
  stays on the device and is not uploaded.
- **Sharing sends no email.** An invitation waits inside Scholea for whoever
  confirms that address. Limits: 20 pending invitations per project, 30 new
  invitations per person per day, and an invitation expires after 30 days.
- **Deleting an account does not hand over its projects.** A shared project
  whose only owner was deleted keeps working for its other members, but nobody
  can manage its team any more.
- **No self-service account deletion or email change** in the app, no
  multi-factor authentication, and no social sign-in.
- **The app has no admin console.** Accounts and settings are administered by
  calling the backend's functions (section 5).
