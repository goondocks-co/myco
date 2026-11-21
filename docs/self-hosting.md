# Run your own Myco

A Deployment is one Myco server. It holds your projects' sessions, spores and plans, serves the dashboard and agent tools, and queues Myco's own work. A separately registered [runner](runners.md) does that work using a coding agent signed in on its machine.

Install the Myco binary using the [installation steps](quickstart.md#1.-install), then choose where the Deployment lives:

| Run it on | Choose this when | What you need |
|---|---|---|
| Cloudflare | Teammates, remote runners or cloud agents need to reach it | A Cloudflare account and supported Node.js on the machine you deploy from; setup offers a private Wrangler install |
| This machine | You want a personal Myco reached only from this machine | The Myco binary on macOS, Linux or Windows x64; no Node.js or container runtime. Windows ARM64 cannot host one |

**At beta, self-hosting on your own machine supports loopback access only.** Use Cloudflare for a shared address. VM hosting and exposing a local server are covered only in the [unsupported appendix](#unsupported-self-hosting).

Choose the address before setting up GitHub sign-in. The sign-in callback belongs to that address; changing it means configuring sign-in again and signing machines in again.

From a repository you want to connect, start with:

```bash
myco setup
```

On a fresh machine, choose **Start a new Myco**, then Cloudflare or this machine. Setup continues an existing setup from what it finds on this machine; it asks which Myco to use when it cannot choose. To explicitly create a Deployment, use:

```bash
myco setup --create cloudflare
myco setup --create local
```

Setup asks for the account and address before creating Cloudflare resources. For local hosting, it asks for a port and whether to start at login or wait for you to run `myco server run --target local` in another terminal. It guides GitHub registration, private owner linking and this machine's sign-in, then asks about a project and a runner. A runner is a separate choice; creating a server never starts agent work by itself.

Rerun `myco setup` after an interruption, including a partial Cloudflare create. Existing resources are reused. Changing the account, address or resource names asks for approval again. Setup prints the private owner link and its expiry so you can open it yourself if a browser does not open.

`myco setup --status` reports progress without changing it; add `--check-remote` to check server reachability and sign-in. Hosted owner linking is checked through your Cloudflare login during setup; status leaves that check pending.

## Finish in the dashboard

Open **Today** and follow **Get started** for the next action. The checklist reflects what Myco can verify, including a live captured session, a ready runner and recent work that produced results. Imported history alone does not complete live capture. See [The dashboard](dashboard.md#get-started).

Creating a server does not start a runner. Choose a machine for Myco's work only when you want it to run tasks; for a loopback Deployment it must be this machine. Follow [Runners](runners.md) for sign-in, capacity and updates, and [Join a Myco](quickstart.md) for capture checks. To invite teammates, use **People & machines** → **Invite a teammate**; **Connect GitHub** gives them dashboard sign-in.

For automatic work, enable **Work on a schedule** in **Settings** → **Myco’s work**. The project switches **Context for sessions**, **Code map** and **Learning** are on by default. Scheduling starts off.

## Manual server commands

Use these when you want to perform the owner steps individually. Choose the address before configuring GitHub sign-in, then create the server, configure sign-in and link its first owner.

Server commands select the sole Deployment held on this machine, or default to local when there is none. If this machine holds both local and Cloudflare Deployments, pass `--target local` or `--target cloudflare`. The examples name their target explicitly. A retained Compose installation requires an explicit supported target; Compose itself is retired.

### On this machine

Run these in order, while the server is stopped:

```bash
myco server create --target local
myco server github-app --target local --url http://127.0.0.1:8787
myco server setup-owner --target local
myco server install --target local
```

`create` prepares storage and generates keys. `github-app` opens GitHub to register one public App for dashboard sign-in and read-only repository access; confirm there and return to the terminal. It requests Contents, Pull requests and Metadata read permissions, with webhook delivery disabled. `setup-owner` prints a private account-link URL. `install` starts the server and runs it whenever you log in. Run `create` before `install`; a home without a created Deployment is refused with `create` as the next step.

After the server starts, open the private link, sign in with GitHub, check the account and choose **Connect this account**, then **Open Projects**. The link expires after 15 minutes. Keep it private: whoever uses it can become the administrator.

If the link expires, stop the foreground server with Ctrl-C, or stop its installed service with `myco server uninstall --target local`. Rerun `myco server setup-owner --target local`, then start it again. The replacement link invalidates the previous one. Once an account is connected, owner setup refuses; use the existing sign-in and invitation flow instead.

The address is `http://127.0.0.1:8787`. If that port is taken, pass `--port <number>` to `myco server create --target local` and use that port in the sign-in URL too. Data lives in `~/.myco/server/local/`; service output goes to `~/.myco/logs/server.log`.

### On Cloudflare

Install Node.js from [nodejs.org](https://nodejs.org/en/download) on the machine you deploy from, then run:

```bash
myco setup --create cloudflare
```

Setup checks Node against the engine requirement declared by the Wrangler used to build this binary. If Node is missing or too old, it names the version needed and asks you to install it before retrying. Setup offers, with consent, to install the binary’s pinned Wrangler under `<MYCO_HOME>/server/tools/` (normally `~/.myco/server/tools/`). This needs no root access or global npm prefix. It then offers Cloudflare sign-in and account selection.

An existing Wrangler found in local/global npm packages is preferred when its major matches the bundled Wrangler; otherwise Myco uses its private pinned copy. A failed operator check also falls back to that copy and reports why; if neither works, the refusal retains the first meaningful diagnostic.

Discovery reads npm configuration and installed package manifests through Node; it starts no npm CLI and contacts no registry. Version probes disable Node compile caches, npm updates/logs and Wrangler logs/metrics. Commands execute the selected JavaScript entry directly through Node, so command-time package fetching is unavailable. `myco doctor` and `myco setup --status` report the selected version and runnable command. Identity-check failures retain Wrangler's diagnostic; only signed-out results offer browser login.

Older or damaged private tools are replaced by the same consented setup step. Under the operator lock, setup stages and verifies the replacement while existing tools stay available, then swaps it into place and restores the old folders if publication fails. Cleanup of unused installation folders is best-effort and does not fail a successful installation. Cloudflare credentials are removed from the install environment; npm global mode and location are explicitly overridden. Other server verbs never install tools; a missing compatible tool directs you back to setup.

The manual commands below use the account id chosen during setup. Myco requires it explicitly for a new Deployment so resources go into the account you choose.

```bash
myco server create --target cloudflare --account-id <account-id>
myco server github-app --target cloudflare --url <address-printed-by-create>
myco server setup-owner --target cloudflare
```

`create` provisions storage and deploys the server carried by your binary. Add `--dry-run` to preview the resources it would create or keep. Repeating a create keeps existing resources and keys and resumes unfinished provisioning.

For a domain you own in the same Cloudflare account, add `--url https://myco.example.com` to the create command. Otherwise use the printed `workers.dev` address. Make this choice before `github-app`; let that command choose its host-derived app name because GitHub App names are global.

Complete GitHub registration, then open the private link from `setup-owner` and choose **Connect this account**. The link expires after 15 minutes; rerunning setup replaces it. Hosted owner setup works through your Cloudflare login while the server keeps serving. It requires configured GitHub sign-in and refuses once an account is connected.

### Sign this machine in

After linking the owner, run this from a repository you want to capture:

```bash
myco setup --join <address>
```

Approve the printed code in a browser signed in to the dashboard, then follow **Get started** on **Today**. Start a new coding-agent session after setup. Runner enrollment remains an explicit choice.

## Check and stop the server

```bash
myco server status --target local
myco server status --target cloudflare
```

Run the command for your target. Local status distinguishes an installed service from a server actually answering; a loaded service alone does not prove it is healthy. Hosted status reports the recorded account, address and deployed version, and names any failure to read live state.

To watch a local server in this terminal, use `myco server run --target local`. Stop it with Ctrl-C. `myco server uninstall --target local` stops the installed service and keeps data; it does not stop a separate foreground process.

`myco server destroy --target cloudflare --yes` removes the Worker while keeping storage and keys. A later create can bring it back. `myco server destroy --target local --data --yes` deletes the local Deployment's data.

`myco remove` unregisters this home's member integrations and worker/runner services while preserving data. `--purge` deletes only the named 2.0 entries: `member/`, `skills/`, `bin/`, `install.json`, `runtime.command`, `runtime.home`, `logs/`, `runner/`, `worker/`, `installer-audit/`, `setup.json` and `last-update-check.json`. It preserves 1.4 files, their cutover receipt, `backups/cutover-*` and unknown entries, prints what remains, and removes the home directory only when empty. The confirmation lists each deletion. Purging a custom home requires a valid `install.json`; the default `~/.myco` home is also admitted. A membership alone does not authorize deleting generic directories such as `bin/` or `logs/`. The home is checked again after confirmation and deletion uses its unchanged canonical path. Purge refuses the user home, its ancestors, filesystem roots, the current directory and symlinked homes.

A home holding `server/` or a Cloudflare operator record refuses purge unless you also pass `--allow-deployment-loss`. Back up the Deployment first; the override admits deletion of `server/`, including its data and operator records. An installed native Deployment service blocks purge even with the override: run `myco server uninstall --target local` first. After `myco cutover` reports the move complete, check retained 1.4 backups before deleting legacy files by hand. In every other migration state, run `myco cutover --dry-run` and keep those files.

## Set up repository access

Dashboard **Settings → Sign-in and access → GitHub App** carries the whole setup as a checklist. Each step is read live from GitHub and this server when the section opens and when you press **Check again**; nothing is marked done by hand. It names this server's App and its owner, links straight to the App's own pages, and shows the one command that needs the operator's machine with this Deployment's target and address filled in:

1. **Sign-in is configured.** This server holds the App's Client ID and secret; the step does not run a sign-in itself.
2. **The App requests read-only repository permissions.** The step names each missing permission and links to the App's permissions page: set repository Contents, Pull requests and Metadata to Read-only and save; leave account permissions and the callback URL unchanged. GitHub then asks each account the App is installed on to accept the change. An App installed nowhere yet has nothing to accept. The step reflects what the App requests; an installation that has not accepted them is named under the next step, when GitHub's installation detail says so.
3. **The private key is imported.** On the App's settings page, generate a private key. GitHub moves its settings pages: look for the App's private keys, today under Credentials → Key pairs → New key. GitHub downloads a `.pem` file; import it with the command the step shows, for example:

   ```sh
   myco server github-app --target cloudflare --url https://myco.example.com --private-key-file <downloaded.pem>
   # A native server is stopped around the import:
   myco server uninstall --target local
   myco server github-app --target local --url http://127.0.0.1:8787 --private-key-file <downloaded.pem>
   myco server install --target local
   ```

4. **Installed on an account.** Install the App, from the step's link, on each account that owns repositories code tasks should read, choosing **Only select repositories**. An organization owner may need to approve the installation.
5. **Approved here.** The App is public so anyone can sign in with it, which also means anyone can install it. The step lists installations by accounts this server has not approved, each with **Approve**. Approve only accounts you own or trust.
6. **A Project reads its repository.** Connect a repository to a Project (below). The section says "Repository access is set up" only once GitHub lets the App read a connected Project's repository. It tries at most three connected Projects, most recently connected first. When none of those can be read and others were not tried, it says access could not be confirmed for the Projects checked, names them, and how to check another: open that Project's Settings → Repository and save its repository again, which checks it with GitHub. Otherwise it says how many steps remain and which is next.

A rate limit on GitHub's side reads as "GitHub's rate limit was reached; try again after …", never as a rejected key.

GitHub may ask you to confirm access (your password, passkey or two-factor code) before it opens an App's settings; confirm, and the page opens.

Before the key is imported, the server identifies its App by the name registration gives it, derived from the server's address, and GitHub's public page for that App, kept only when its Client ID matches this server's. An App renamed on GitHub, or a server reached only at a loopback address, is not identified until the key is imported: the section then names the expected App name and Client ID and links to your Apps and your organizations.

`myco server github-app --target local|cloudflare --url <address>` on an already configured server prints the same steps in the terminal: the App's name and owner, direct links, the exact import command and, after a successful import, the steps that remain (install, connect). To install or rotate a sign-in pair, explicitly use `--existing --client-id <id> --client-secret-stdin`; this installs the supplied pair even when sign-in is already configured. Fresh registration and explicit credential installation finish sign-in before attempting repository-key setup. An absent, invalid or unverifiable key leaves sign-in installed and prints the command to finish repository access.

Piped PEM input uses `--private-key-stdin`; key bytes never belong in command arguments. The command signs an App JWT with the existing Client ID and checks `GET /app` for matching identity and all three reads before storing anything. A wrong key or missing permission leaves sign-in untouched. An interrupted or unacknowledged write can be replayed by rerunning without a key input; an unfinished import remains in the private operator journal until completion or `--discard-pending`. Remove the downloaded PEM after the dashboard shows the key step done; the command leaves it on disk and names its path. After verifying a rotated key, delete the old key in GitHub.

Cloudflare stores `GITHUB_APP_PRIVATE_KEY` as a Worker secret, installed through the existing secret-bulk stdin route. Native stores the same single-line base64 PKCS#8 value in owner-only `server/local/secrets.env`; its private `.bak` can retain the prior key after rotation. An interrupted command holds the key only in its protected pending journal (0600 inside the target’s 0700 directory). No key is stored in the database or sent to members or runners. A native runner sharing the server’s OS user can read that user’s secret files; use separate OS users when that boundary is needed.

The App key is replaceable, not recovery material: backups do not require it, and restore ignores it if present in `--secrets-from`. After restore, generate a new key in GitHub and run the import again. Sign-in, capture and everything that does not read a repository work without the key; code tasks and release checks wait, and the dashboard names the command that sets it up.

### Connect a Project's repository

Myco reads Project repositories only through this Deployment's App. Nothing else gives it repository access: there is no per-Project token and no other Git host.

1. In the dashboard, open the Project's **Settings → Repository** and press **Connect repository**. The dialog lists every installation of the App. An installation by an account this server has not approved is shown as "Installed by an account this server has not approved", with its login and whether it is an organization or a personal account, and an **Approve** action.
2. Choose an approved account, then one of the repositories its installation selected, and the branch. **Save repository**. The server confirms the choice with GitHub before storing it, by GitHub's numeric repository and installation ids.
3. When the App is installed nowhere, or the repository is not listed, the dialog links to the App's install page and to the chosen account's installation settings in GitHub. Install it or add the repository there, return, and press **Refresh GitHub access**.

**Find repositories for my Projects**, in the GitHub App section, proposes for each Project with no repository the one repository, across approved accounts' installations, whose name equals the Project's (ignoring case), with its default branch. A Project with no such repository, or more than one, gets no proposal. Up to five pages (500 repositories) of each approved account, on the first page of installations, are searched; when that does not cover everything, nothing is proposed, and each Project with a same-named repository seen reads "Not every repository could be checked; connect this one by hand from its Settings → Repository." Nothing is connected until you press **Connect** on a row or **Connect all**; each connection is saved and checked with GitHub exactly as the dialog saves it.

The GitHub App section lists the approved accounts; **Remove approval** stops new tokens for that account's installations. Release tracking reads the same connected repository; it has no repository or token of its own.

Updating to the release that brings this removes every per-Project token and connection and drops release tracking's own repository. Before updating, note each Project's repository and branch, and turn **Work on a schedule** off. Between the schema change and the new server going live, the previous server answers repository and release settings, code-task starts, member capture delivery and runner claims with "unavailable, retry later" (members keep their capture and deliver it afterwards), its release checks and scheduled code work fail on each wake, and sign-in keeps working. Finish the update so the new server goes live, then connect each Project again. A key a previous server saved under a retired name during that window is removed by the new server's own housekeeping.

Revoking a token is attempted every time, and it is confirmed only when GitHub accepts it. A token can stay usable until it expires, at most the hour GitHub gives it, in these cases: a request deadline fires after GitHub issued the token and before its answer reached the server; the platform fails to send an answer the server handed over; a run is cancelled while its repository answer is arriving, and the answer does not finish or cannot be read within the runner's ten-second cleanup allowance; GitHub refuses or does not answer the revoke request, which is tried once and logged; or the server or runner process stops while it holds the token. A checkout or release token can read one repository. The token used to list an installation's repositories can read repository metadata only, for the repositories that installation was given.

Each code task's runner receives a one-hour token that can read only the connected repository's contents, and revokes it as soon as its checkout finishes. A release check mints its own token for contents and pull requests, and revokes it when the check ends. Tokens are never stored or shown. Whether a task can start is decided from what the server has stored (a connection and the App key); GitHub is asked only when source is prepared, when a release check runs, and when an admin refreshes installations.

## Back up and restore

For a recent mistake or bad update on a hosted Deployment, Cloudflare Time Travel is the everyday database protection: it can put the database back to any minute within the last 30 days on Workers Paid, or 7 days on Free. Before an update changes an existing database's schema, Myco obtains and durably records a restore point; it refuses the schema change if that fails. Deleted stored objects are held for at least 30 days regardless of plan, preserving the bytes an older database names. Objects deleted before the hold was installed remain unavailable. [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [plan limits](https://developers.cloudflare.com/d1/platform/limits/).

Time Travel restores the existing database in place. Myco does not yet coordinate it with writers, runners, Durable Objects or search; read [the database-only restore boundary](architecture/hosted-rewind.md) before using it. Its history belongs to the database and account: it is not a copy you hold elsewhere. Deleting a database loses its earlier Time Travel history, even if Cloudflare later undeletes the database within its separate seven-day window. [Cloudflare database undeletion](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/undelete/).

Use a complete copy you hold for losing the database or account, recovering beyond the available history, or moving to another Deployment. Keep it outside the source Deployment's account and keep its recovery credentials separately. Native Deployments have no Time Travel; their complete copies provide recovery.

Make a complete copy with the backup command for your target:

```bash
myco server backup --to <backup-directory>
myco server backup --target cloudflare --to <backup-directory>
```

The command snapshots the database, copies every stored object the snapshot names, and verifies the copy. It does not copy recovery credentials; keep the credentials it names separately. Repeat the same command to resume an interrupted backup. Until it completes, the source retains objects the snapshot needs, so storage can grow.

Health’s **Create backup** is a separate relational export for additive restore, limited to 64 MiB. It reads while writes continue and omits stored files, settings and secrets. It is not the complete recovery copy described here.

Each hosted backup pauses database requests while it exports the database: the dashboard and tools cannot read or save data, capture waits on members’ machines for later delivery, and larger databases take longer. The pause ends when the database export ends; the later download, local snapshot reconstruction and object copy do not keep the database paused. This is a whole-database export, not a paged export. Capture already written to a member's spool remains there through retryable failures and is delivered on a later hook or drain after the Deployment answers again. A native backup copies the database and stored objects while the Deployment keeps serving. [Cloudflare export limitation](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations).

**Settings → Backups → Back up every** controls scheduled backups. Each hosted backup pauses database requests while it exports the database: the dashboard and tools cannot read or save data, capture waits on members’ machines for later delivery, and larger databases take longer. A hosted scheduled copy remains in the source account until an operator downloads it and turns it into a verified recovery artifact; it is not an independent copy the operator already holds. The schedule is optional, not a prerequisite for Time Travel. Choose its interval only with the export pause in mind.

To retain stored provider keys on restore, keep the original wrapping key separately from the backup. Native Deployments hold it in `<MYCO_HOME>/server/local/secrets.env`; new hosted Deployments write it to `<MYCO_HOME>/server/cloudflare/secrets.env` with owner-only permissions before sending it to Secrets Store. Never publish this file. Hosted Deployments created before this change have no wrapping key the operator can hold and restore with `--new-credentials`. The backup data itself remains restorable without that key.

Restore into a fresh Myco home and fresh resources. To replace a retired source, set `MYCO_HOME` to a new directory, then run the appropriate command:

```bash
myco server restore --target local --from <backup-directory> --secrets-from <credentials-file> --source-retired --yes
myco server restore --target cloudflare --from <backup-directory> --secrets-from <credentials-file> --account-id <account-id> --source-retired --yes
```

`--source-retired` confirms that the original serving instance has been retired. Replacement retains its identity and memberships; two addresses do not make those copies separate Mycos. If the source will remain serving, use `--fork` instead: it creates a separate Myco, keeps history and revokes copied credentials, invitations and active runs. The owner signs in again and reconnects machines.

With `--new-credentials`, omit `SECRET_WRAP_KEY` from the credentials file: restore installs a fresh key and removes the sealed credentials from its private copy before serving. It lists each credential name and where to enter it again; history is preserved. Supplying both the flag and a wrapping key is refused. Without this flag, the original key must open every stored credential.

With `--new-signin`, only the original wrapping key is required when keeping stored credentials; combine `--new-signin --new-credentials` to omit `--secrets-from` entirely. Both paths work with `--fork` as well as replacement. For example: `myco server restore --target cloudflare --from <backup-directory> --new-credentials --new-signin --account-id <account-id> --source-retired --yes`. Then configure GitHub sign-in afterward with `myco server github-app --target local --url <address>` or `myco server github-app --target cloudflare --url <address>`. Hosted create re-runs preserve an existing Secrets Store key. Create and status report whether this machine holds the key file; they cannot verify it against Secrets Store. Keep that file for a restore that retains stored credentials. If it is absent and no independent copy exists, restore asks for stored credentials again with `--new-credentials`. Restore keeps its source and refuses an existing destination. For local recovery, start the restored server with `myco server install --target local`. Verify dashboard sign-in, projects, history, search and new capture before relying on the replacement.

## Update and recover an update

Update the operator machine's binary first, then deploy the server it carries:

```bash
myco update
myco server update --target local
```

For Cloudflare, use `myco server update --target cloudflare` instead. Updating this machine alone does not update the Deployment. See [Updating Myco](upgrade.md) for member and runner updates.

**Before a local storage-format change, make and verify a full backup and keep its recovery credentials.** An older binary refuses newer storage. Local storage has no D1 Time Travel; recover into a fresh directory with a compatible backup or apply a forward fix.

A Cloudflare update that advances an existing database's schema obtains a D1 Time Travel bookmark before migration. It saves the bookmark, schema versions, timestamp and previous Worker version in `~/.myco/server/cloudflare/record.json` under `schemaUpdates`. If it cannot obtain a valid bookmark, it refuses before changing remote resources. A code-only update needs no bookmark. Keep a full backup for disaster recovery too.

If Wrangler reports a migration error, the update checks the live schema before settling the result. Reaching the target confirms the migration was applied: the update names the provider error and confirmed version, records completion and continues to the Worker. An unchanged schema is reported as failed with nothing applied, and the Worker is not attempted. Any other version, including an intermediate version in a multi-migration update, keeps the outcome unknown and names the version reached. A failed probe also leaves the outcome unknown; check `myco server status --target cloudflare` before retrying.

For a code rollback:

```bash
myco server rollback --target cloudflare
```

Bare rollback selects the version observed serving before the latest admitted update attempt, including a code-only update. If that earlier version could not be proved (including older operator records), it refuses and asks for `--version <id>`; `wrangler deployments list` lists the versions. After a failed or unacknowledged update, it uses that attempt's observed prior version. It checks the current deployment and refuses if that prior version is still serving or the current version cannot be proved. Repeating create clears the saved rollback target.

This rolls back the Worker, **not the database or blobs**. The update also prints a Cloudflare Time Travel command, which restores the database alone. Myco does not yet coordinate it with capture, in-flight work, Durable Object state or the external vector index. Those would remain at their newer state, and a database restored separately also requires a compatible Worker version:

```bash
myco server rollback --target cloudflare --account-id <account-id> --version <worker-version-before-update>
```

A database restore discards writes after its bookmark and does not restore R2 objects. Hosted object deletion retains released bytes for at least 30 days; this cannot recover objects deleted before the retention policy was installed. The hold is 30 days regardless of the Cloudflare plan. See [hosted stored-data retention and database recovery](architecture/hosted-rewind.md) for what remains inconsistent after a database-only restore. Keep the restore output, including its undo bookmark. A complete recovery artifact is separate and may not exist for a hosted Deployment; verify which artifacts you hold and their coverage before choosing full recovery into fresh resources.

## Custom-domain requests blocked before Myco

If login, capture, import or tool calls get an HTTP 403 or HTML challenge instead of a Myco response, check Cloudflare **Security Events** for the request's Ray ID. A 403 alone does not prove a firewall rule blocked it. If those events identify a zone rule, use a narrowly scoped **Skip** rule for the Myco hostname and affected paths. Place it **first**, before the blocking custom rules, and select only the rules Security Events identifies. Keep logging enabled; see Cloudflare's [Skip action](https://developers.cloudflare.com/waf/custom-rules/skip/).

Match only the affected routes: `/auth/` paths for sign-in and device polling, `/api/device/` paths for approval, `/mcp` for tool calls, and `/members/`, `/events`, `/blobs/` and `/import/` for joining, capture and imports. For example, when these routes are blocked:

```text
(http.host eq "myco.example.com" and (
  starts_with(http.request.uri.path, "/auth/") or
  starts_with(http.request.uri.path, "/api/device/") or
  http.request.uri.path eq "/mcp" or
  starts_with(http.request.uri.path, "/members/") or
  http.request.uri.path eq "/events" or
  starts_with(http.request.uri.path, "/blobs/") or
  starts_with(http.request.uri.path, "/import/")
))
```

Extend an exception only when evidence identifies another blocked route. Myco still checks credentials. Retry `myco import` from the affected repository, or resume a 1.4 move with `myco cutover`.

<a id="unsupported-self-hosting"></a>

## Appendix: exposing a self-hosted server (unsupported for beta)

VMs, VPS hosting, Fly.io, Cloudflare Tunnel and Tailscale Funnel are outside the supported beta self-hosting path. Use Cloudflare when other machines or cloud agents need access. A cloud agent cannot reach your laptop's loopback address.

A VM needs persistent storage and a service that stays alive after logout. Fly.io needs persistent volume storage; this guide provides no beta deployment recipe for it. A named Cloudflare Tunnel or Tailscale Funnel can supply a public HTTPS address, but that also requires correct sign-in callbacks and trusted caller-address handling.

For a reverse proxy, stop the local server before editing its record. `myco server status --target local` prints **Directory**; the settings file is **`server.json` inside that directory**, normally `~/.myco/server/local/server.json`. Preserve its other fields. Set `origin` to the public origin, `sourceFrom` to `proxy`, `trustedHeader` to the header your proxy overwrites with the caller's address, and `trustedHops` to the number of trusted proxies (at least 1). The proxy must prevent callers from forging that trusted header and rewrite the upstream Host to a loopback literal at the native listening port. Native serving keeps both loopback families available; the public origin controls sign-in URLs. Register GitHub sign-in for the public origin before starting again. Direct loopback access uses `sourceFrom: "socket"`.

### Plain server image

The plain server image runs the server and keeps its data on a mounted volume. It runs no coding agent. Publish its port on loopback and set `MYCO_BIND=all` so the published port reaches it inside the container. Set `MYCO_ORIGIN` to the address your members use. The image brings the mounted storage up to date before starting the server.

Normal startup requires an existing database at `MYCO_DATABASE`; a missing volume or database is refused. To initialize a new mounted volume explicitly, run `docker run --rm -v <volume>:/data <image> --bootstrap-only` with `MYCO_DATABASE` configured for that mount, then start it normally with the same volume. The entrypoint drops privileges before bootstrapping and exits after initialization. With loopback transport, `MYCO_ORIGIN` must name an HTTP or HTTPS loopback literal. Its authority is the allowed Host, including any published port, such as `http://127.0.0.1:9000` for a host port mapped to the container's port 8787. Proxy transport retains its explicit trusted-source configuration.

An upgrade preserves the configured daily budget and prepares and validates its governor during operator migration. Deployments with an active validated governor continue automatic work within that budget. If activation is refused or remains unverified, the server still starts and capture, reads and manual work remain available; automatic work stays queued under a budget hold. Queue expiry for automatic work begins when activation succeeds; time waiting for activation does not expire that work. Startup reports the activation problem. For a row-count preflight refusal, review `agent.run_retention_days`, allow terminal-run retention to finish, and retry the operator update. Resolve the reported index or preflight problem and rerun the operator update or container migration; successful activation releases automatic work subject to the preserved budget and recorded spend. Existing in-flight attempts are retained and counted, and the upgrade does not reset spending or change the budget value.

Search indexing runs inside the server, including behind a trusted reverse proxy. Agent work needs a separately registered runner, just as it does on a native server. For cloud execution, register a runner on a cloud VM and sign its coding agent in there.

The Compose lifecycle target and harness image are retired. `myco server create --target local` creates a native Deployment. If you already have one, `--target local` selects it even when an old Compose bundle is still held on disk. Keep that bundle and its data until you have chosen how to move them.


### Runtime pins for source development

An explicit `MYCO_HOME` takes precedence. Otherwise a project can select a home with `.myco/runtime.home` and a program with `.myco/runtime.command` only after you approve their values for this local repository on this machine:

```bash
myco member trust-pins --root /absolute/path/to/repository
```

Review both files before approving them. Approval is stored under `~/.myco/project-pin-trust/`, separate from the project and independent of the selected Myco home. If the user home is a Git checkout, approvals live in its protected Git metadata (`.git/myco-project-pin-trust/` for an ordinary home repository), outside versioned working files. Registered Git worktrees share approval for the same values. A different build or home path needs explicit approval; a new clone requires approval even at the same filesystem path. Submodules, separate Git directories and dotfiles repositories are supported. `myco member join` approves an existing same-home pin or publishes a new home pin with its approval. Cutover validates approval destinations before changing registrations and publishes its program pin with approval. A failed approval leaves the prior pin intact. Source installation itself creates no project pins.

An unapproved or unreadable pin is ignored. Capture continues through the machine pin or default home, with at most one warning on stderr. To stop using an override, remove its project pin files. `myco remove --purge` also removes this installation's approvals from the shared user store and preserves other installations' approvals. For an isolated source test, use the absolute build artifact and scratch home variables described in the dogfood-worktree skill.
