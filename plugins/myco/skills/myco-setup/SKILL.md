---
name: myco-setup
description: >-
  Finish setting Myco up on this machine: install the binary, join a Deployment,
  connect repositories and verify capture. Also use for a 1.4 cutover, an optional
  runner, or leaving the wrong Deployment.
when_to_use: >-
  Use when no Myco context arrives at session start, sessions are not captured,
  tools lack a credential, or the user asks to install or connect Myco.
allowed-tools: Read, Bash, Grep, Glob
user-invocable: true
---

# Setting Myco up

After verifying the installed binary below, lead with `myco setup --join <address>` when joining an existing Myco. It guides sign-in, project selection and global agent setup; `myco setup --status` reports observed progress without changing it. Bare `myco setup` continues from observed Deployment, membership and runner state. It uses the current repository's connection or the default Myco when possible, asks which observed Myco to continue with when needed, and offers starting, joining or running work when no journey is known. Use `--change` to ask for choices again or `--create`, `--join` or `--runner` to choose explicitly. Setup handles new owners, joining, running work and moving 1.4 history. Creation supports Cloudflare and loopback access on this machine.

The plugin supplies skills and remote tools. Installing the binary adds session and plan capture, import and optional runner commands. A working plugin alone does not mean capture is installed.

## 1. Verify or install the binary

Before invoking any Myco command, read the installation's `install.json` (normally `~/.myco/install.json`, or under `MYCO_HOME`). Require a `bin` matching the executable you intend to run. For a curl install, require a 2.x `version` and a `binary_sha256` matching that file. For an npm install whose marker lacks those fields, read the installed `@goondocks/myco` and platform package metadata without executing either binary: require matching 2.x versions and a hash match between the platform package's binary and the marker's `bin`. This applies to commands on `PATH` and binaries outside it.

If the marker is missing, unreadable, older, or does not match, inspect files without executing the binary. Use the installer's preview and obtain consent before replacing 1.4 with `--replace-1.4`.

Once verified, run `myco version`; use the verified absolute `bin` path if it is outside `PATH`.

Before installing, explain the binary destination and global agent configuration changes and obtain the user's consent. On macOS and Linux:

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

On Windows x64, in PowerShell:

```powershell
irm https://myco.sh/install.ps1 | iex
```

The 2.0 Windows path is not yet verified. Windows on ARM has no supported build. A binary destination containing whitespace is refused; choose a path with no spaces rather than retrying unchanged.

## 2. Join a Deployment

Obtain the Myco address or the administrator's one-time invitation command. An invite link is optional when you already sign in to the dashboard; a new teammate needs an administrator's invitation and GitHub account connection first. From the repository to connect:

```bash
myco setup --join <address>
```

Open the printed approval page in a browser signed in to that dashboard, check the code and machine, and approve. An administrator invites a new teammate through **People & machines** → **Invite a teammate** and connects their dashboard account with **Connect GitHub**. Invitations and join codes expire and work once; a refusal needs a fresh invitation.

Setup resumes when rerun. `myco login <address>` is the manual sign-in and agent-setup path; login already provisions agents. Use `myco member provision --refresh` only when refreshing existing setup is needed. A bare host uses HTTPS; a loopback Deployment needs its full `http://127.0.0.1:8787` address.

For a new owner, run `myco setup --create cloudflare` or `myco setup --create local`. Setup chooses the address before GitHub registration, prints a private owner link, waits for linking and signs this machine in. Rerun after an interruption to resume from observed state. Local setup is loopback only; a foreground server runs in the user's separate terminal. Follow **myco-server-provisioning** or [Run your own Myco](https://myco.sh/self-hosting) for the standalone operations. Server commands select the sole existing Deployment, default to local on a fresh home and require an explicit `--target local` or `--target cloudflare` when both are held. A retained Compose installation also requires an explicit supported target.

## 3. Connect repositories

Git repositories under `~/Repos` auto-join the default Deployment on the first agent hook. An existing project with that Git remote is reused, otherwise one is created. Change **Folders it captures** under **My machines** for other parent folders.

For a repository elsewhere, run inside it:

```bash
myco member join
```

Choose an existing project or create one. `myco member join --project <id-or-name>` and `myco member join --new [name]` make that choice explicit. `myco member status` shows connected repositories and pending or refused joins. Only Git repositories capture.

Start a new coding-agent session after setup. Confirm its session appears on **Today**; context alone does not prove the server recorded the session.

## 4. Move a 1.4 installation

Choose a Deployment and keep a backup of the old home before replacing its binary. Replacement stops old hooks capturing until sign-in and cutover finish.

```bash
curl -fsSL https://myco.sh/install.sh | sh -s -- --dry-run --replace-1.4
curl -fsSL https://myco.sh/install.sh | sh -s -- --replace-1.4
myco setup --cutover
```

Setup guides the move, previews changes and resumes after interruption. Use `--no-cutover` to leave the move pending. Repeat `--route <projectId>=<url>` to choose project destinations and `--skip <projectId>` to leave chosen history and spools in place.

For the manual path, sign in to the chosen Deployment and preview:

```bash
myco login <address>
myco cutover --dry-run
```

Review every destination and proposed agent and service change before `myco cutover`. For several Deployments, sign in to each first. Use `--route <id>=<url>` for an explicit project destination, `--skip <id>` to leave history and spool in place, and, on the manual cutover command, `--map <old-dir>=<repo-root>` for transcripts from old directories. Preview with the same options you will apply. An unresolved or conflicting route needs a decision, not a guessed default.

Cutover preserves original vaults, verifies copies and records history and transcript progress separately in `~/.myco/member/cutover.json`. Changed agent settings are backed up under `~/.myco/backups/cutover-<stamp>/`; its `restore.md` describes how to undo those changes. Keep those backups. If earlier copies on other Deployments are reported, review them there before using `myco cutover --dismiss-earlier-copies` to acknowledge the reported copies locally. This contacts no Deployment and deletes no history; new or changed copies are reported again. Run it separately from the move or preview, with only `--legacy-home` if needed. A partial import remains unfinished; fix the named problem and rerun. It reports old extra plan folders; add wanted folders under **My machines** → **Extra plan folders**. Verify imported history and a new captured session before retiring old data. See [Moving from 1.4](https://myco.sh/upgrade#upgrading-from-myco-14) for fallback routing and additional homes.

## 5. Optional: enroll a runner

Capture, login and server startup do not enroll an executor. Continue only when the owner has chosen this machine to run this Deployment's agent work.

The following choice appears when the machine has no existing Myco setup.

On an always-on machine, run `myco setup` and choose **Run Myco's work**. On an already configured machine, use `--runner <address>` to choose runner enrollment explicitly. Sign in to a supported coding agent there under the service account. For a known Myco address:

```bash
myco setup --runner <address>
myco runner doctor --server <address>
```

An owner or administrator approves the printed device code. Check contact and agent sign-in on **Runners**. Registered runners use their own machine's sign-ins; server-held provider credentials do not sign them in.

**Context for sessions**, **Code map** and **Learning** default on per project. Enable **Work on a schedule** in **Settings** for automatic work. **Runs of one task at once** defaults to 2 across projects; a large initial history has a separate first-extraction ramp. See [Runners](https://myco.sh/runners).

Existing legacy worker services stay until explicitly retired. `myco worker status` prints the retirement command. Let active work finish first; retiring a worker preserves capture and membership.

## 6. Verify or leave

```bash
myco doctor
myco setup --status
myco member status
```

Read the results for credential, agent wiring, queued delivery, runner state and server reachability. Confirm a new session on Today and, when a runner is configured, a completed task under **Myco’s work**.

For the wrong Deployment, use `myco logout <address>`: it revokes this machine's member credential and removes local connections while preserving captured data and runner registrations. Logout reconciles each agent independently. If any agent configuration cannot be updated, it reports partial completion and the file problem; fix that problem and rerun the same logout command, including after the membership was removed. Do not treat a partial result as complete. If unreachable, `myco logout <address> --local-only` removes only local connections; an administrator must revoke the server credential.

Member machines update on demand with `myco update`. Installed runners update between runs; a combined member and runner home may need an interactive `myco update` or `myco member provision --refresh` after handoff to finish agent refresh.

## Plugin access keys

A plugin-only access key is project-bound and expires (90 days by default, at most a year). An administrator creates it in the dashboard; an expired key needs replacement. Installing the binary and signing in uses the user's own credential instead.
