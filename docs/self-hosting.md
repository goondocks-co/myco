# Run your own Myco

A Deployment is one Myco server. It holds your projects' sessions, spores and plans, serves the dashboard and agent tools, and queues Myco's own work. A separately registered [runner](runners.md) does that work using a coding agent signed in on its machine.

Install the Myco binary using the [installation steps](quickstart.md#1.-install), then choose where the Deployment lives:

| Run it on | Choose this when | What you need |
|---|---|---|
| Cloudflare | Teammates, remote runners or cloud agents need to reach it | A Cloudflare account; Node.js and Wrangler on the machine you deploy from |
| This machine | You want a personal Myco reached only from this machine | The Myco binary; no Node.js or container runtime |

**At beta, self-hosting on your own machine supports loopback access only.** Use Cloudflare for a shared address. VM hosting and exposing a local server are covered only in the [unsupported appendix](#unsupported-self-hosting).

Choose the address before setting up GitHub sign-in. The sign-in callback belongs to that address; changing it means configuring sign-in again and signing machines in again.

For guided setup, run one of these from a repository you want to connect:

```bash
myco setup --create cloudflare
myco setup --create local
```

Setup asks for the account and address before creating Cloudflare resources. For local hosting, it asks for a port and whether to start at login or wait for you to run `myco server run --target local` in another terminal. It guides GitHub registration, private owner linking and this machine's sign-in, then asks about a project and a runner. A runner is a separate choice; creating a server never starts agent work by itself.

Rerun the same command after an interruption. Progress comes from the Deployment and machine records; `setup.json` holds choices and consent fingerprints. Changed plans require fresh consent. `myco setup --status` reads local state; add `--check-remote` to check the server. Hosted owner linking is checked through your operator login during setup; status leaves that check pending. The standalone operations below remain available.

## On this machine

Run these in order, while the server is stopped:

```bash
myco server create --target local
myco server github-app --target local --url http://127.0.0.1:8787
myco server setup-owner --target local
myco server install --target local
```

`create` prepares storage and generates keys. `github-app` opens GitHub to register the dashboard's sign-in app; confirm there and return to the terminal. `setup-owner` prints a private account-link URL. `install` starts the server and runs it whenever you log in.

After the server starts, open the private link, sign in with GitHub, check the account and choose **Connect this account**, then **Open Projects**. The link expires after 15 minutes. Keep it private: whoever uses it can become the administrator.

If the link expires, stop the foreground server with Ctrl-C, or stop its installed service with `myco server uninstall --target local`. Rerun `myco server setup-owner --target local`, then start it again. The replacement link invalidates the previous one. Once an account is connected, owner setup refuses; use the existing sign-in and invitation flow instead.

The address is `http://127.0.0.1:8787`. If that port is taken, pass `--port <number>` to `myco server create --target local` and use that port in the sign-in URL too. Data lives in `~/.myco/server/local/`; service output goes to `~/.myco/logs/server.log`.

## On Cloudflare

Install Node.js and Wrangler on the machine you deploy from, and sign Wrangler in to your Cloudflare account:

```bash
npm install -g wrangler
wrangler login
wrangler whoami
```

Use the account id shown by `whoami`. Myco requires it explicitly so resources go into the account you choose.

```bash
myco server create --target cloudflare --account-id <account-id>
myco server github-app --target cloudflare --url <address-printed-by-create>
myco server setup-owner --target cloudflare
```

`create` provisions storage and deploys the server carried by your binary. Add `--dry-run` to preview the resources it would create or keep. Repeating a create keeps existing resources and keys and resumes unfinished provisioning.

For a domain you own in the same Cloudflare account, add `--url https://myco.example.com` to the create command. Otherwise use the printed `workers.dev` address. Make this choice before `github-app`; let that command choose its host-derived app name because GitHub App names are global.

Complete GitHub registration, then open the private link from `setup-owner` and choose **Connect this account**. The link expires after 15 minutes; rerunning setup replaces it. Hosted owner setup works through your Cloudflare login while the server keeps serving. It requires configured GitHub sign-in and refuses once an account is connected.

## Connect this machine, add a runner and invite people

From a repository you want to capture, sign this machine in using the chosen address:

```bash
myco setup --join <address>
```

Approve the printed code in a browser signed in to the dashboard. Setup guides project selection and agent configuration. Start a new coding-agent session afterward. See [Join a Myco](quickstart.md) for repository auto-join and connection checks.

Choose a machine to do Myco's own work, sign in to a supported coding agent on it, and register it explicitly:

```bash
myco runner register <address>
myco runner install --server <address>
myco runner doctor --server <address>
```

An owner or administrator approves the runner's device code. For a loopback Deployment, the runner must be on the same machine. Creating the server or joining a coding machine does not start a runner. Without one, sessions still capture and agent work waits in the queue. Follow [Runners](runners.md) for sign-in, capacity and updates.

In **People & machines**, choose **Invite a teammate** and share its one-time login command. To give that person dashboard sign-in, choose **Connect GitHub** for their entry and send the connection link.

The project switches **Context for sessions**, **Code map** and **Learning** are on by default. In **Settings** → **Myco’s work**, turn on **Work on a schedule** for automatic work; scheduling starts off. Connect a repository in **Project settings** for code-based work. Use **Run a task** under **Myco’s work** to start work manually, then check its result there.

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

## Back up and restore

Use the backup command for the target you run:

```bash
myco server backup --target local --to <backup-directory>
myco server backup --target cloudflare --to <backup-directory>
```

The command snapshots the database, copies its blobs and verifies every blob. Repeat the same command to resume an interrupted backup. Until it completes, the source retains objects the snapshot needs, so storage can grow. **Settings** → **Backups** also controls automatic backups.

Keep the recovery credentials named by the backup output in separate secure storage. The data artifact alone is insufficient. Recovery reads an independently held credentials file with the original wrapping key and sign-in credentials; for a local Deployment, the source file is `~/.myco/server/local/secrets.env`. Protect it separately from the backup directory.

Restore into a fresh Myco home and fresh resources. To replace a retired source, set `MYCO_HOME` to a new directory, then run the appropriate command:

```bash
myco server restore --target local --from <backup-directory> --secrets-from <credentials-file> --source-retired --yes
myco server restore --target cloudflare --from <backup-directory> --secrets-from <credentials-file> --account-id <account-id> --source-retired --yes
```

`--source-retired` confirms that the original serving instance has been retired. Replacement retains its identity and memberships; two addresses do not make those copies separate Mycos. If the source will remain serving, use `--fork` instead: it creates a separate Myco, keeps history and revokes copied credentials, invitations and active runs. The owner signs in again and reconnects machines.

With `--new-signin`, only the original wrapping key is required; configure GitHub sign-in afterward with `myco server github-app --target local --url <address>` or `myco server github-app --target cloudflare --url <address>`. Restore keeps its source and refuses an existing destination. For local recovery, start the restored server with `myco server install --target local`. Verify dashboard sign-in, projects, history, search and new capture before relying on the replacement.

## Update and recover an update

Update the operator machine's binary first, then deploy the server it carries:

```bash
myco update
myco server update --target local
```

For Cloudflare, use `myco server update --target cloudflare` instead. Updating this machine alone does not update the Deployment. See [Updating Myco](upgrade.md) for member and runner updates.

**Before a local storage-format change, make and verify a full backup and keep its recovery credentials.** An older binary refuses newer storage. Local storage has no D1 Time Travel; recover into a fresh directory with a compatible backup or apply a forward fix.

A Cloudflare update that advances an existing database's schema obtains a D1 Time Travel bookmark before migration. It saves the bookmark, schema versions, timestamp and previous Worker version in `~/.myco/server/cloudflare/record.json` under `schemaUpdates`. If it cannot obtain a valid bookmark, it refuses before changing remote resources. A code-only update needs no bookmark. Keep a full backup for disaster recovery too.

For a code rollback:

```bash
myco server rollback --target cloudflare
```

This rolls back the Worker, **not the database or blobs**. For a schema rollback, use the exact database restore command printed by the update while its bookmark remains within Time Travel retention, then return to the compatible Worker version:

```bash
myco server rollback --target cloudflare --account-id <account-id> --version <worker-version-before-update>
```

A database restore discards writes after its bookmark and does not restore R2 objects. Keep the restore output, including its undo bookmark. Choose full recovery into fresh resources when the database and blobs need to be recovered together.

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

For a reverse proxy, stop the local server before editing its record. `myco server status --target local` prints **Directory**; the settings file is **`server.json` inside that directory**, normally `~/.myco/server/local/server.json`. Preserve its other fields. Set `origin` to the public origin, `sourceFrom` to `proxy`, `trustedHeader` to the header your proxy overwrites with the caller's address, and `trustedHops` to the number of trusted proxies (at least 1). The proxy must prevent callers from forging that trusted header. Register GitHub sign-in for the public origin before starting again. Direct loopback access uses `sourceFrom: "socket"`.

### Plain server image

The plain server image runs the server and keeps its data on a mounted volume. It runs no coding agent. Publish its port on loopback and set `MYCO_BIND=all` so the published port reaches it inside the container. Set `MYCO_ORIGIN` to the address your members use. The image brings the mounted storage up to date before starting the server.

Search indexing runs inside the server, including behind a trusted reverse proxy. Agent work needs a separately registered runner, just as it does on a native server. For cloud execution, register a runner on a cloud VM and sign its coding agent in there.

The Compose lifecycle target and harness image are retired. `myco server create --target local` creates a native Deployment. If you already have one, `--target local` selects it even when an old Compose bundle is still held on disk. Keep that bundle and its data until you have chosen how to move them.
