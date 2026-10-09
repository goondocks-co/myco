---
name: myco-setup
description: >-
  Finish setting Myco up on this machine. The plugin alone gives you skills and
  the Myco tools; the binary adds session capture, plan capture, import and the
  optional runner. This skill checks what is present, installs the binary with the user's
  consent, signs in or redeems a join code, wires the agent's hooks and verifies
  the result — and names the outcome plainly when an install cannot proceed.
when_to_use: >-
  Use when no Myco context arrives at session start, when this project's
  sessions are not being recorded, when a Myco tool call is refused for want of
  a credential, or when the user says "set up Myco", "install Myco", "connect me
  to our Myco deployment" or "why isn't my work being captured".
allowed-tools: Read, Bash, Grep, Glob
user-invocable: true
---

# Setting Myco up

Two things can be installed, and they are independent.

| Installed | You get |
|---|---|
| The plugin | the skills, and the Myco tools over your deployment's URL |
| The binary as well | session capture, plan capture, import, and optional runner commands |

If the tools answer but nothing is being captured, the plugin is installed and the binary is not. That is a working configuration. This skill is for when the user wants the second half.

**Ask before installing anything.** This writes to the user's machine and to their agent's configuration. Say what will be installed and where, then wait.

## 1. Is the binary already here?

```bash
myco version
```

If that answers, skip to step 3. If the command is not found, the binary may still be installed but off `PATH` — try `~/.myco/bin/myco version` on macOS or Linux, and `%LOCALAPPDATA%\Myco\bin\myco.exe version` on Windows.

## 2. Install it

macOS and Linux:

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://myco.sh/install.ps1 | iex
```

**Two installs cannot succeed, and both fail for a reason no retry changes:**

- **Windows on ARM.** The installer refuses and exits. There is no supported build; a different machine or an x64 host is the only path. Do not suggest workarounds.
- **A destination path containing a space.** Hooks are spawned as a direct argument vector for several agents, so a binary path with whitespace in it breaks them. The installer refuses rather than writing hooks that would fail later. The fix is a path with no spaces: the defaults, `~/.myco/bin` and `%LOCALAPPDATA%\Myco\bin`, already satisfy this, so it only appears when a custom install directory or a pinned runtime path was chosen.

## 3. Connect to a deployment

The user needs an invite link from whoever runs their deployment.

```bash
myco login <url>
```

In a sandbox or a continuous-integration job there is no interactive step: the same string is placed in the environment as a join code and redeemed on the first agent session.

A join code and an invite link are single-use and expire. If one is refused, the answer is a fresh link from an administrator, not a retry.

## 4. Wire the agent up

```bash
myco member provision --refresh
```

This refreshes the member's hooks, remote MCP registration and managed skills. It works without fetching a release and is safe to repeat. To update the binary within its recorded channel and then refresh setup, run `myco update` (`myco upgrade` is an alias). Installed runners hand off the update only between runs; combined member and runner homes finish agent refresh with an interactive `myco update` after the handoff.

## 5. Optional: the owner opts a machine into agent work

Developer laptops run no agent work by default. Login, member join, provision and server startup configure no executor. Capture and runner execution are independent.

Continue here only when the machine's owner explicitly asks to make it a runner for this Deployment. Otherwise skip to verification. Name the Deployment and machine in the request; a membership is not runner enrollment.

```bash
myco runner register <host>
myco runner install --server <url>
```

The owner or an administrator approves registration on the Deployment's device page. Installation then starts this enrolled runner's per-user service. It offers supported agents already signed in on that machine. Verify with `myco runner doctor --server <url>`.

Existing legacy worker services remain until explicitly retired in their owning home. `myco worker status` lists them and prints the exact retirement command. Preserve active work; stopping a legacy service leaves membership and capture unchanged.

## 6. Verify

```bash
myco doctor
```

This checks the wiring, the credential, and whether the deployment answers from this machine. Read what it reports rather than assuming success — it is the only step that tells you the whole path works.

Then start a new agent session. Myco context should arrive at session start; if it does, capture is running.

## About the key the plugin uses

The plugin authenticates with a per-project access key, and three things follow that are worth telling the user before they are surprised by them:

- **It is bound to one project.** Working across several repositories means configuring the plugin once per project.
- **It expires.** Ninety days by default, and the deployment's administrator can set anything up to a year. When it lapses, tool calls stop being answered and the fix is a new key pasted into the plugin's configuration.
- **Only an administrator can mint one.** It comes from the deployment's dashboard. The plugin cannot request one for itself, so a user without a key needs a person, not a command.

Installing the binary replaces that key with a credential of the user's own, which is the other reason to finish setup.
