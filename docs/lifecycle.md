# Local Service Lifecycle

Myco runs a local background service that captures session activity, processes it into knowledge, and serves context back to your agents. This page covers how the service behaves, what gets captured, and what to do when something needs attention.

## Install and bootstrap

The service is installed for the current user the first time the Myco native binary lands on a machine — the installer downloads it to `~/.myco/bin` (`%LOCALAPPDATA%\Myco\bin` on Windows) and registers a managed per-user service (launchd on macOS, systemd on Linux, Task Scheduler on Windows). No Node runtime is required. The supported path is macOS, with Linux and Windows in beta. On Windows, only x64 is supported — Windows on ARM (which runs the x64 build under emulation) is not supported.

When the service starts:

1. **Creates your default Grove** if it does not exist yet.
2. **Connects supported coding agents** so Myco can capture sessions and serve context.
3. **Registers projects automatically** when a supported agent starts working in a real git repo.

This means a fresh install produces a working service, default Grove, and dashboard before you've opened a single project. Capture begins the first time an agent works in a registered git repo.

## Contributor dogfood services

A machine can run a development Myco service alongside the released production service. This is mainly for contributors dogfooding unreleased builds while keeping their production Grove separate.

Production and development services only serve the Groves assigned to them, so upgrading the public package does not disturb a contributor's dogfood Grove, and a development restart does not take over production data.

## Session capture

When you start a session in any configured agent (Claude Code, Cursor, Codex, Cline, Pi, etc.), Myco registers the session and begins capturing events:

- **User prompts** — every message you send the agent
- **Tool uses** — every file read, bash command, edit, or search the agent runs
- **Subagent activity** — when the agent delegates to a subagent, that work is recorded too
- **Assistant turns** — pulled from the agent's native transcript (not re-captured from the API)
- **Attachments** — images you paste into the conversation are extracted and saved under the Grove's `attachments/` directory

Capture is automatic and continuous. You never need to trigger it.

At session start, Myco adds context to the conversation when intelligence providers are configured: a project briefing, relevant spores for the current git branch, and the session's metadata. That context helps your agent start productively without taking over the agent's own memory or workflow.

On prompts, Myco can run a semantic search against your prompt text and add the top matching spores — so ongoing work benefits from prior learnings without the agent having to ask.

## Service status

Use `myco stats` or the dashboard to check whether Myco is running, which sessions are active, and which Grove is being served. If you're investigating a capture issue, `myco logs` shows recent service activity.

## Power management

The service adapts its background work rate to developer activity. It works quickly while sessions are active, slows down when the project is idle, and wakes back up when new work arrives.

## Where data lives

Myco data lives in two places: a per-user global directory and per-Grove databases.

### Per-user global

| Path | Purpose |
|------|---------|
| `~/.myco/groves/registry.yaml` | Default Grove pointer and cross-Grove registry metadata |
| `~/.myco/launcher.cjs` | Myco-owned agent connection entrypoint |
| `~/.myco/mcp-launcher.cjs` | Myco-owned MCP entrypoint |
| `~/.myco/buffer/` | Temporary capture buffer |
| `~/.myco/service/` | Local service state |
| `~/.myco/groves/<id>/` | Per-Grove databases and state |

### Per Grove

| Path | Purpose |
|------|---------|
| `myco.db` | Sessions, batches, activities, spores, entities, lineage edges, plans, artifacts, skills, FTS indexes |
| `vectors.db` | Semantic search embeddings |
| `grove.toml` | Grove identity |
| `registry/projects.toml` | Projects registered in this Grove |
| `logs/daemon.log` | Service logs |
| `attachments/` | Images extracted from session transcripts |
| `backups/` | Default Grove-scoped backup directory |

### Per project (optional)

A project's `.myco/` directory carries project-local override files only — project settings, local secrets, and optional project identity files committed through the dashboard's Symbionts page. The capture buffer no longer lives here.

`myco.db` and `vectors.db` are local state that rebuilds from session captures. Myco manages its own `.gitignore` entries automatically.

## Context injection

Three context-routing points each serve a different purpose:

**Session start** — Project understanding. At the start of each session, Myco adds the digest extract or a recent-context fallback, plus the session ID and current git branch.

**Per prompt** — Targeted intelligence. On prompts you submit, Myco can run semantic search against your prompt text and add the top matching spores. Each result includes its spore ID so the agent can follow up with `myco_spores` op `"get"` for more detail.

**Pre-read** — Codebase awareness. Canopy adds file anatomy before reads so the agent can decide whether it needs the full file.

## Degraded mode

If the service is unreachable for any reason (crash, upgrade in progress, network hiccup), Myco degrades gracefully:

- `SessionStart` — context routing falls back to local data when available
- Prompt, tool, and stop events are buffered locally
- `SessionEnd` — no-op

The next time the service starts, it reconciles buffered events and you lose nothing. Buffer files are cleaned up automatically after 24 hours.

## Service management

You typically don't need to manage the service yourself — it starts at login, stays running in the background, and adapts its work rate to your activity. But these commands are available:

```bash
myco stats          # Is it running? Which sessions are active?
myco doctor         # Health check: data, providers, agents, service, dashboard
myco doctor --fix   # Auto-repair fixable issues
myco logs           # Tail service logs
myco restart        # Manual restart (rarely needed)
myco remove         # Uninstall: remove Myco's contributions from every agent's global config
myco remove --purge # Additionally remove ~/.myco/ itself
```

### Start at login or at boot

By default the service starts **at login**, as your user. On macOS and Linux you can instead run it **at boot** — useful for a machine that hosts a team or serves external agent access and should come back after a reboot without anyone logging in:

```yaml
# machine config (~/.myco/config.yaml)
daemon:
  service_scope: boot   # 'login' (default) or 'boot'
```

Then run `myco service install` from a shell that can elevate — realizing a boot-scoped service generally needs administrator rights (on Linux, running it as your own user uses `loginctl enable-linger` instead), which is also why this setting is machine-scoped config and deliberately **not** a dashboard toggle (a switch the dashboard couldn't act on without elevation would be a lie). `myco doctor` reports when the installed service doesn't match the configured scope.

On **Windows**, the service always runs at login via Task Scheduler; boot scope isn't supported there, and a `service_scope: boot` setting is reported by `myco doctor` but not realized.

Hosting a team works at either scope, but the order is easier one way round: set the host up from the Team page first, then switch to boot. On macOS, once the service starts at boot, starting or stopping hosting moves to the terminal (`myco host enable` / `myco host disable`) — see [Team Host](team-host.md#hosting-from-the-command-line).

## Updates

Myco runs as a single native binary and one local service serving every Grove on the machine. It keeps itself up to date:

### How to update

- **Automatically** — the service self-updates from your release channel in the background while it's idle. Nothing to run.
- **From the Settings page** — the **Upgrade** section shows the running version and, when a new version is available, an **Upgrade & Restart** button. Click it to apply the update and restart Myco immediately.
- **From the command line (advanced)** — `myco upgrade` (with `--channel stable|beta`) applies an update for scripted use. The dashboard is the primary interface; the CLI is for bootstrap and advanced use.

All three paths end at the same state: the installed Myco binary is at the new version, and the next restart updates your local service and connected agents.

Hosting a team and joining one are part of the main binary — the dashboard's Team page and the `myco host`, `myco join`, and `myco attach` commands alike — and they upgrade automatically with the rest of Myco. See [Team Host](team-host.md). If your team shares a host, update the host machine first, then members.

See [Upgrading Myco](upgrade.md) for the full upgrade walkthrough.

### Stable and Beta channels

The Upgrade section of the Settings page has a **Stable**/**Beta** toggle that controls which release line this machine follows. This machine runs one managed Myco binary at `~/.myco/bin/myco`, and switching channels swaps that same binary in place — Beta installs the latest prerelease, Stable steps back to the latest stable release.

**Switching to Beta.** Click **Beta**. Myco installs the latest beta release and uses it for the dashboard, agent connections, and intelligence pipeline across every Grove on the machine.

**Reverting to Stable.** Click **Revert to Stable & Restart**. Myco steps the binary back to the latest stable release and restarts the service. You return to the same Stable version a fresh install would give you — with one guard: if a Beta release updated your data's storage format beyond what the Stable release can read, the revert is refused with a message naming the versions involved, because the older binary would refuse to start. See [Rollback](upgrade.md#rollback) for what to do in that case.

## Configuration

The most common settings, with defaults:

```yaml
version: 3

embedding:
  provider: ollama              # ollama | openai-compatible | openrouter | openai
  model: bge-m3

daemon:
  log_level: info               # debug | info | warn | error

capture:
  transcript_paths: []          # additional transcript search paths

agent:
  scheduled_tasks_enabled: true
  event_tasks_enabled: true
  provider:
    type: anthropic             # anthropic | ollama | lmstudio
    model: claude-sonnet-4-6
```

Config is a scoped system: **machine** (`~/.myco/config.yaml`), **Grove** (`~/.myco/groves/<id>/config.yaml`), **project** (`<project>/.myco/myco.yaml`), and **personal** (`<project>/.myco/local.yaml`) overlays merge in that order. Use the dashboard's Settings page; per-field scope is shown inline.

See [Intelligence Pipeline](agent-harness.md) for the full `agent:` configuration reference, including per-task and per-phase provider overrides.
