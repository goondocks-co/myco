# Daemon Lifecycle

Myco runs a long-lived background daemon that captures session activity, processes it into knowledge, and serves context back to your agents. This page covers what gets captured, how the daemon manages itself, and what to do when things go sideways.

## Session capture

When you start a session in any configured agent (Claude Code, Cursor, Codex, Pi, etc.), the symbiont's hooks register the session with the daemon and begin capturing events:

- **User prompts** — every message you send the agent
- **Tool uses** — every file read, bash command, edit, or search the agent runs
- **Subagent activity** — when the agent delegates to a subagent, that work is recorded too
- **Assistant turns** — pulled from the agent's native transcript (not re-captured from the API)
- **Attachments** — images you paste into the conversation are extracted and saved to `attachments/`

Capture is automatic and continuous. You never need to trigger it.

At session start, Myco injects context into the conversation: a project digest extract, relevant spores for the current git branch, and the session's metadata. That context is what lets your agent start productive immediately instead of asking questions.

On every prompt, Myco runs a semantic search against your prompt text and injects the top matching spores — so ongoing work benefits from prior learnings without the agent having to ask.

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

Everything Myco captures lives in your project's `.myco/` directory:

| Path | Purpose |
|------|---------|
| `myco.db` | Sessions, batches, activities, spores, entities, graph edges, plans, artifacts, skills, FTS indexes |
| `vectors.db` | Semantic search embeddings |
| `myco.yaml` | Vault configuration (providers, schedules, etc.) |
| `secrets.env` | API keys (gitignored) |
| `logs/daemon.log` | Structured daemon logs (JSONL) |
| `attachments/` | Images extracted from session transcripts |
| `buffer/` | Per-session event buffers (ephemeral) |
| `tasks/` | User-defined agent task YAMLs (optional) |

`myco.db` and `vectors.db` should be **not** committed to git — they're local state that rebuilds from session captures. Myco's own `.gitignore` entries are added automatically by `myco init`.

## Context injection

Two injection points, each with a different purpose:

**Session start** — Project understanding. At the start of each session, Myco injects the digest extract (or a fallback built from recent sessions and active spores if no digest exists yet). Total budget is around 1200 tokens, plus the session ID and current git branch.

**Per prompt** — Targeted intelligence. On every prompt you submit, Myco runs a semantic search against your prompt text and injects the top matching spores. Each result includes its spore ID so the agent can follow up with `myco_recall` for more detail. Very short prompts skip this to avoid noise.

## Degraded mode

If the daemon is unreachable for any reason (crash, upgrade in progress, network hiccup), hooks degrade gracefully:

- `SessionStart` — context injection falls back to a local DB query, no digest or semantic search
- `UserPromptSubmit` — events buffered to disk (JSONL files in `buffer/`), no context injection for that prompt
- `PostToolUse` and `Stop` — events buffered to disk
- `SessionEnd` — no-op

The next time the daemon starts, it reconciles the buffered events and you lose nothing. Buffer files are cleaned up automatically after 24 hours.

## Daemon management

You typically don't need to manage the daemon yourself — it spawns automatically on session start and shuts down after a grace period with no active sessions. But these commands are available:

```bash
myco stats          # Is it running? On what port? Active sessions?
myco doctor         # Health check: vault, DB, providers, agents, daemon
myco doctor --fix   # Auto-repair fixable issues
myco logs           # Tail daemon logs
myco restart        # Manual restart (rarely needed)
```

## Updates

Myco installs a single global npm package, but a single machine may run one daemon per project. When a new version is available, you only need to update once — other projects catch up on their own.

### How to update

- **From the Operations page** — when a new version is available, an **Update & Restart** button appears. Click it to install the new package and restart that daemon.
- **From the command line** — `npm update -g @goondocks/myco` installs the new version directly.

Both paths end at the same state: the globally installed Myco package is at the new version.

If you also installed one of the optional standalone operator CLIs, the Operations page detects and applies those package updates alongside `@goondocks/myco`. Manual npm updates are still available, but they are no longer the normal path once those packages are installed:

- `npm update -g @goondocks/myco-team`
- `npm update -g @goondocks/myco-collective`

Users who are only consuming Myco locally don't need those extra packages. Team operators install `@goondocks/myco-team` for provisioning and worker administration; Collective operators install `@goondocks/myco-collective`.

### What other projects do

Other projects on the same machine discover the new version the next time you open their dashboard. They restart themselves, refresh their local hooks and symbiont registration if anything needs to change, and post a notification to their Operations page so you know what happened. You don't need to run `myco restart` or `myco update` manually in each project.

If you want a daemon to pick up changes immediately rather than waiting for the next dashboard visit, `myco restart` still works and is instant.

### Stable and Beta channels

The Operations page has a **Stable**/**Beta** toggle that controls which release line this project follows. Channel selection is per-project — switching one project to Beta does not affect your other projects or your machine-global `myco` install.

**Switching to Beta.** Click **Beta**. Myco installs the latest beta release into the project's vault at `.myco/runtime/` and uses that version for the dashboard, hooks, and agent pipeline. Your other projects continue running whatever version they're on.

**Reverting to Stable.** Click **Revert to Stable & Restart**. Myco removes the project's local Beta install, ensures the machine-global install is at the latest stable version, and restarts the daemon. The project returns to the same Stable version a fresh `npm update -g @goondocks/myco` would give you.

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

See [Intelligence Pipeline](agent-harness.md) for the full `agent:` configuration reference, including per-task and per-phase provider overrides.
