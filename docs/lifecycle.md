# Daemon Lifecycle

Myco runs a long-lived background daemon that captures session activity, processes it into knowledge, and serves context back to your agents. This page covers how the daemon manages itself, what gets captured, and what to do when things go sideways.

## Install and bootstrap

The daemon is installed as a per-user service the first time the npm package lands on a machine. It registers with launchd on macOS, systemd-user on Linux, or the equivalent on Windows. There is no per-project `myco init` step.

When the service starts:

1. **Find the registry.** The daemon reads `~/.myco/registry.json` to discover registered projects and Groves.
2. **Phantom mode if empty.** If no projects are registered yet, the daemon enters **phantom mode**: it binds to a temporary vault at `~/.myco/_unbound-bootstrap/`, serves the dashboard, and polls the registry every 5 seconds. Startup logs read `No project bound; polling registry from unbound bootstrap`.
3. **Auto-Grove-create on first hook.** The first time any agent fires a hook from a directory not in the registry, Myco creates the project record and binds it to the machine's default Grove automatically. A graceful supervisor restart picks up the new binding without losing buffered events.
4. **Bound state.** Once at least one project is bound, the daemon serves that Grove. Each Grove owns its own SQLite database under `~/.myco/groves/<id>/`. Startup logs read `Bound to vault: <path>`.

This means a fresh `npm install -g @goondocks/myco` produces a working daemon and dashboard before you've opened a single project. Capture begins on the first agent invocation.

## Variant-aware daemons

A machine can run multiple daemons at the same time — for example, a contributor's dogfood daemon alongside the released production daemon. Each daemon is pinned to a **variant** via `MYCO_SERVICE_VARIANT` (default: `service`).

Variant-aware rebind is strict:

- A daemon with `MYCO_SERVICE_VARIANT=service-dev` binds **only** to Groves whose `grove.toml` has `served_by = "service-dev"`.
- A daemon with `MYCO_SERVICE_VARIANT=service` binds **only** to Groves with `served_by = "service"`.
- There is no fall-through. The previous prod escape hatch (default Grove regardless of `served_by`) is closed.

This guarantees the two daemons never collide and never serve each other's Groves. Variant-pinned daemons that find no matching Grove also enter phantom mode rather than failing.

## Session capture

When you start a session in any configured agent (Claude Code, Cursor, Codex, Pi, etc.), the symbiont's hooks register the session with the daemon and begin capturing events:

- **User prompts** — every message you send the agent
- **Tool uses** — every file read, bash command, edit, or search the agent runs
- **Subagent activity** — when the agent delegates to a subagent, that work is recorded too
- **Assistant turns** — pulled from the agent's native transcript (not re-captured from the API)
- **Attachments** — images you paste into the conversation are extracted and saved under the Grove's `attachments/` directory

Capture is automatic and continuous. You never need to trigger it.

At session start, Myco injects context into the conversation: a project digest extract, relevant spores for the current git branch, and the session's metadata. That context is what lets your agent start productive immediately instead of asking questions.

On every prompt, Myco runs a semantic search against your prompt text and injects the top matching spores — so ongoing work benefits from prior learnings without the agent having to ask.

## Daemon state authority

All mutations to `~/.myco/service/daemon.json` (the running-state file: port, PID, bound vault, last-seen) go through a single `DaemonStateAuthority` capability. Every write is logged with reason, caller PID, and before/after PID. No code path bypasses it. This is the structural guarantee that the file accurately reflects the daemon's actual state — a recurring source of capture-loss incidents in earlier releases.

If you're investigating a capture issue, the daemon log records every state write. `~/.myco/service/daemon.json` should agree with `ps` and with the dashboard.

## Power management

The daemon adapts its background work rate to the developer's activity. Four states:

| State | Behavior | Trigger |
|-------|----------|---------|
| **active** | Fast polling, all background jobs run | Any HTTP request from a live session |
| **idle** | Slower polling, most jobs still run | No activity for 10 seconds |
| **sleep** | Rare polling, only maintenance jobs run | No activity for 60 seconds |
| **deep_sleep** | Timers stopped, no background work | No activity for 10 minutes |

Any request wakes the daemon back to active. This means the daemon gets out of the way when you step away from your machine, and it costs nothing on idle laptops.

## Where data lives

Myco data lives in two places: a per-user global tree and per-Grove databases.

### Per-user global

| Path | Purpose |
|------|---------|
| `~/.myco/registry.json` | Projects and Groves the daemon knows about |
| `~/.myco/launcher.cjs` | Global hook launcher (every symbiont's hooks call this) |
| `~/.myco/mcp-launcher.cjs` | Global MCP launcher |
| `~/.myco/buffer/` | Per-Grove capture buffers (ephemeral; archives legacy `.agents/myco-buffer/`) |
| `~/.myco/service/daemon.json` | Running daemon state (PID, port, bound vault) |
| `~/.myco/groves/<id>/` | Per-Grove databases and state |
| `~/.myco/_unbound-bootstrap/` | Phantom-mode vault when no projects are registered |

### Per Grove

| Path | Purpose |
|------|---------|
| `myco.db` | Sessions, batches, activities, spores, entities, graph edges, plans, artifacts, skills, FTS indexes |
| `vectors.db` | Semantic search embeddings |
| `grove.toml` | Grove identity, `served_by` (variant binding) |
| `logs/daemon.log` | Structured daemon logs (JSONL) |
| `attachments/` | Images extracted from session transcripts |

### Per project (optional)

A project's `.myco/` directory carries project-local override files only — `myco.yaml` for project-scoped config, `secrets.env` for API keys, and (rarely) project-local launchers if you opted in with `myco init --project <path>`. The capture buffer no longer lives here.

`myco.db` and `vectors.db` are local state that rebuilds from session captures. Myco manages its own `.gitignore` entries automatically.

## Context injection

Two injection points, each with a different purpose:

**Session start** — Project understanding. At the start of each session, Myco injects the digest extract (or a fallback built from recent sessions and active spores if no digest exists yet). Total budget is around 1200 tokens, plus the session ID and current git branch. Cortex injection fires only once per session start, gated on the agent's `invocationNum === 0`.

**Per prompt** — Targeted intelligence. On every prompt you submit, Myco runs a semantic search against your prompt text and injects the top matching spores. Each result includes its spore ID so the agent can follow up with `myco_spores` op `"get"` for more detail. Very short prompts skip this to avoid noise.

All three injection sources (Cortex, Spores, Canopy) route through a single `recordInjectionActivity()` helper with UNIQUE-index dedup, so a per-prompt spore that overlaps with the digest doesn't double-inject.

## Degraded mode

If the daemon is unreachable for any reason (crash, upgrade in progress, network hiccup), hooks degrade gracefully:

- `SessionStart` — context injection falls back to a local DB query, no digest or semantic search
- `UserPromptSubmit` — events buffered to disk (JSONL files under `~/.myco/buffer/<grove>/`), no context injection for that prompt
- `PostToolUse` and `Stop` — events buffered to disk
- `SessionEnd` — no-op

The next time the daemon starts, it reconciles the buffered events and you lose nothing. Buffer files are cleaned up automatically after 24 hours.

## Daemon management

You typically don't need to manage the daemon yourself — the per-user service starts at login, stays running in the background, and adapts its work rate to your activity. But these commands are available:

```bash
myco stats          # Is it running? On what port? Active sessions?
myco doctor         # Health check: vault, DB, providers, agents, service, daemon
myco doctor --fix   # Auto-repair fixable issues
myco logs           # Tail daemon logs
myco restart        # Manual restart (rarely needed)
myco remove         # Uninstall: remove Myco's contributions from every agent's global config
myco remove --purge # Additionally remove ~/.myco/ itself
```

## Updates

Myco installs a single global npm package and runs a single per-user daemon serving every Grove on the machine. To upgrade:

### How to update

- **From the Operations page** — when a new version is available, an **Update & Restart** button appears. Click it to install the new package and restart the daemon.
- **From the command line** — `npm install -g @goondocks/myco@latest` installs the new version. Run `myco restart` to make it take effect immediately, otherwise it picks up on the next restart.

Both paths end at the same state: the globally installed Myco package is at the new version, and the daemon's next restart runs the migration walker and reconciles every symbiont's global config.

If you also installed one of the optional standalone operator CLIs, the Operations page detects and applies those package updates alongside `@goondocks/myco`. Manual npm updates are still available, but they are no longer the normal path once those packages are installed:

- `npm update -g @goondocks/myco-team`
- `npm update -g @goondocks/myco-collective`

See [Upgrading Myco](upgrade.md) for the full upgrade walkthrough.

### Stable and Beta channels

The Operations page has a **Stable**/**Beta** toggle that controls which release line this project follows. Channel selection is per-project — switching one project to Beta does not affect your other projects or your machine-global `myco` install.

**Switching to Beta.** Click **Beta**. Myco installs the latest beta release into the project's vault at `.myco/runtime/` and uses that version for the dashboard, hooks, and agent pipeline. Your other projects continue running whatever version they're on.

**Reverting to Stable.** Click **Revert to Stable & Restart**. Myco removes the project's local Beta install, ensures the machine-global install is at the latest stable version, and restarts the daemon. The project returns to the same Stable version a fresh `npm install -g @goondocks/myco` would give you.

**Machine-wide Beta preferences.** Any existing machine-wide Beta preference applies to each project by default. Click **Stable** on any project's Operations page to opt that project out.

## Configuration

The most common settings, with defaults:

```yaml
version: 3

embedding:
  provider: ollama              # ollama | openai-compatible | openrouter | openai
  model: bge-m3

daemon:
  port: null                    # null = auto-assign
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

Config is a three-tier scoped system: **machine** (`~/.myco/config.yaml`), **grove** (`~/.myco/groves/<id>/config.yaml`), **project** (`<project>/.myco/myco.yaml`), and **personal** (`<project>/.myco/local.yaml`) overlays merge in that order. Use the dashboard's Settings page; per-field scope is shown inline.

See [Intelligence Pipeline](agent-harness.md) for the full `agent:` configuration reference, including per-task and per-phase provider overrides.
