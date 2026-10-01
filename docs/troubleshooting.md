# Troubleshooting

Start with two commands, run from a project this machine has connected:

```bash
myco doctor
myco member status
```

`myco doctor` checks, in order:

- the membership;
- whether the Deployment answers and serves its tools;
- the credential and its renewal;
- anything waiting to be delivered;
- which of your agents capture;
- each agent's Myco MCP entry;
- the worker.

A failing row names what to do and makes the command exit non-zero. `myco member status` shows the same membership in detail: when the credential expires, how many events are waiting per session, the last one the Deployment acknowledged, and any capture that found no membership. `myco member export` prints the same facts as one JSON document that carries no token and no captured content, which is the thing to attach to a bug report.

Below are the messages people meet most, what each means, and what to do.

## Installing

### "No Myco 2.x release found"

> No Myco 2.x release found: Myco 2.0 has not been released yet, so there is nothing to install.

The installer only ever installs Myco 2. It found no 2.x release on GitHub, so it installed nothing. If Myco 1.4 is on the machine, it keeps working as it is. Watch the [releases page](https://github.com/goondocks-co/myco/releases).

### "Myco 1.4 is on this machine … Nothing was installed"

The installer found a 1.4 binary where 2.0 goes, or 1.4 vaults that no cutover has moved. Installing 2.0 takes 1.4's place, and 1.4 stops capturing from that moment, so the installer waits until you ask. Follow [Upgrading from 1.4](upgrade-from-v1.md): install with `--replace-1.4`, then sign in and run the cutover straight away.

### Windows

The PowerShell installer (`install.ps1`) installs Myco 1.4. There is no Myco 2.0 for Windows yet.

> **Coming in beta.1:** Myco 2.0 on Windows ([#1550](https://github.com/goondocks-co/myco/issues/1550)).

## Signing in

### "this machine already belongs to a member"

> this machine already belongs to a member of <url> (identity_claimed)

A machine belongs to one member of a Deployment. Every Myco home on it signs in as the same machine, unless that home holds a `machine_id` file of its own. The machine stays that member's even after the member is removed, and nothing moves a machine to another member.

To sign this machine in again, ask a Deployment administrator for a link **for your existing member**, not a new one. On the dashboard that is **People & machines** → **Add a machine**, with **For** set to you. Run `myco login <link>` with the link it gives. An invitation for a new member is refused on this machine.

### The invitation is refused

`myco login` prints the reason and a code:

| Code | What it means |
|---|---|
| `enrollment_used` | The link was already used. Each link works once. |
| `enrollment_expired` | The link expired. A link lasts an hour or a day, as the administrator chose. |
| `enrollment_revoked` | An administrator withdrew it. |
| `enrollment_unknown` | The Deployment does not know this link; check you copied all of it. |
| `unreachable` | The Deployment did not answer at the link's address. |

For every one of these, ask for a fresh link. A link that is not a link at all is refused before anything is sent, with messages such as "a join link path must be /join" or "that link carries no invitation". A link must be `https`, or `http` only to this machine's own loopback address.

### "No project yet"

> No project yet — connect your first one with `myco member join`

You are signed in, but no repository on this machine is connected, so nothing is captured yet. Run `myco member join` in each repository you work in. It asks which project the repository is, or creates one with `--new`.

## Capturing

### "no registry entry for <folder> — no capture"

> [myco] member: no registry entry for <folder> — run `myco member join <server-url> --project <id>`; no capture

Your agents' Myco hooks run in every folder, and this folder is not connected to a project. Nothing from it is captured. Connected folders are unaffected.

To capture here, run `myco member join` in the repository. Your agents' earlier sessions there are brought in when it connects, as far back as the Deployment allows, and `myco import` reaches further.

> **Coming in beta.1:** repositories under `~/Repos` will connect on their own, and a repository that cannot will be listed on **Today** ([#1547](https://github.com/goondocks-co/myco/issues/1547)).

### An agent captures nothing

Run `myco doctor` from the project. If it reports that no agent on this machine captures, provision the one you use:

```bash
myco member provision claude-code
```

See [Agents](agents.md) for the agents that capture and their names.

## The 1.4 daemon

### "is a Myco 2.0 member home"

> <home> is a Myco 2.0 member home, so the Myco 1.4 local daemon does not run here.

This home belongs to a Deployment, so the 1.4 local service never runs in it, and commands that need that service refuse. Your agents reach the Deployment instead. To call a tool by hand, use `myco tool call <tool> --credential registry`. To give an agent its hooks and MCP entry, use `myco member provision <agent>`.

### "holds Myco 1.4 vaults that no cutover has moved"

The 2.0 binary found 1.4 vaults in a home that has not been moved to 2.0, so it does not start a daemon there or open them. Keep 1.4 serving that home, or move it with [Upgrading from 1.4](upgrade-from-v1.md).

## Upgrading from 1.4

### The cutover stops before it starts

`myco cutover --dry-run` and `myco cutover` check everything first. If something the cutover would change belongs to another installation, they stop before changing anything and list each problem:

| It says | What to do |
|---|---|
| this machine is not signed in to a Deployment | Run `myco login <invite link>` first. |
| this machine belongs to several Deployments | Name one with `--server <url>`. |
| `<home>` holds your agents' settings, and it is not a 1.4 home being cut over | Another Myco home manages your agents. Run the cutover from that home, or remove it if nothing uses it. |
| this machine is pinned to `<home>` | A `runtime.home` pin sends capture to another home. Run the cutover under that home (`MYCO_HOME=<home>`), or remove the pin if nothing uses it. |
| no folder a 1.4 project names is here to connect | None of your 1.4 projects' folders exist on this machine. Bring the history alone with `myco import --legacy <1.4 home>`. |
| every session was captured under another machine id | Run the cutover on the machine that captured them. |
| `<file>` runs `myco daemon` but names no home | Remove that service file if it is 1.4's, then run again. |
| `<file>` starts a 1.4 daemon at boot | Remove it as an administrator, as the message shows, then run again. |
| `<file>` holds a Myco entry but could not be read | Fix or move that file, then run again. |
| `<file>` holds an entry of another installation | Another Myco home registered that agent entry. Remove it if nothing uses it, then run again. |

A cutover that stopped partway through is safe to run again. It finishes what is left and imports nothing twice.

## Starting work

### "You've started this task … today"

A member who is not an administrator can start each task from **Myco's work** four times in a rolling day, across every project. The message says when you can start it again. An administrator has no daily limit, and can raise the number for a task; see [Configuration](configuration.md#starting-work-by-hand).

### "… is switched off for this project"

The task needs a switch the project does not have on: **Learning** for learning, **Code map** for the map. An administrator turns it on in the project's **Project settings**.

## Workers

### "no worker: this membership is not an administrator's"

Only an administrator's machine runs work for a Deployment, so a member's machine installs no worker. Nothing is wrong; the Deployment's work runs on an administrator's machine.

### "no harness a worker offers is logged in"

A worker runs the Deployment's work through a coding agent on its machine (Claude Code, Codex, OpenCode, Cursor or Antigravity). Sign in to one of them on that machine, then run `myco worker status`.
