# Myco Quick Start

Myco is a collective agent intelligence plugin that captures session knowledge — events, observations, decisions, trade-offs — into a SQLite-backed intelligence graph and serves it back via MCP tools. Install it, run `myco init` to bootstrap your project, then configure providers in the dashboard when you're ready.

## Requirements

- **Node.js 22+**
- **At least one supported coding agent** — Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI, Windsurf, OpenCode, or Pi

Provider configuration (Myco Agent and embedding) is **optional** at install time — Myco works in data-collection mode out of the box, with full-text search over captured sessions. To enable the intelligence pipeline (spores, digest, skill lifecycle), configure providers in the dashboard after init.

When you're ready to enable intelligence features, you'll need:

- **Myco Agent provider** (one of):
  - **Anthropic** — uses your existing Claude Code subscription or `ANTHROPIC_API_KEY`
  - [Ollama](https://ollama.com) — local models for extraction, summarization, and analysis
  - [LM Studio](https://lmstudio.ai) — local models via OpenAI-compatible API
- **Embedding provider** (one of):
  - [Ollama](https://ollama.com) with `bge-m3` model (local, free, recommended)
  - [OpenAI-compatible](https://platform.openai.com) endpoint

## Install

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

On Windows (PowerShell):
```powershell
irm https://myco.sh/install.ps1 | iex
```

Or install manually:
```bash
npm install -g @goondocks/myco
```

## Upgrade Existing Installs

Existing users upgrade the main product the same way:

```bash
npm update -g @goondocks/myco
```

That updates the local CLI, daemon, hooks, dashboard, and the built-in team-sync workflow. If you later install one of the standalone operator CLIs, the Operations page will detect and apply updates for those installed Myco packages too. You do not need to install extra packages unless you want one of the standalone operator CLIs:

- `@goondocks/myco-team` for direct team-worker administration commands
- `@goondocks/myco-collective` for cross-project Collective administration

## Set Up Your Project

```bash
cd your-project
myco init
```

`myco init` is a fast bootstrap. It:

1. **Detects coding agents** — finds Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI, Windsurf, OpenCode, or Pi and lets you pick which to register
2. **Installs hooks, MCP entries, and skills** for each selected agent
3. **Starts the daemon** in the background
4. **Opens the dashboard** to the Settings page so you can configure providers when ready

The Myco Agent pipeline is **off by default** after init. Session capture starts immediately and you get full-text search out of the box. To enable the intelligence pipeline (spore extraction, digest, skill lifecycle), configure an agent provider in the dashboard's **Myco Agent** section — that enables the scheduled and event-driven task toggles automatically.

### Configure Providers in the Dashboard

After init, the dashboard opens to the Settings page. Two cards are at the top:

- **Myco Agent** — pick Anthropic, Ollama, or LM Studio. The dropdown lists detected models. Click **Save** to enable the intelligence pipeline.
- **Embedding** — pick Ollama or an OpenAI-compatible endpoint. Embedding models are filtered automatically.

Each section saves independently. You can enable just one (e.g. embedding-only for semantic search) or both.

### Pull Ollama Models (if using Ollama)

```bash
ollama pull bge-m3                  # for embeddings
ollama pull granite4:small-h        # for the agent (any LLM works)
```

### Health Check

After setup, verify everything is connected:

```bash
myco doctor
```

Doctor warns (rather than errors) when provider config is absent — data-collection mode is a valid post-init state.

## What Happens Next

Once installed and initialized, Myco works automatically:

- **Session start**: Myco injects a digest extract and relevant spores into the conversation
- **During the session**: Activity (prompts, tool calls, responses) is captured in the vault
- **Per-turn**: The daemon processes events and tracks session activity
- **After the session**: The intelligence agent extracts spores, generates summaries, and maintains the knowledge graph

You don't need to do anything — Myco captures knowledge in the background.

## Dashboard

Myco includes a local web dashboard for configuration and operations management. After the daemon starts, check the URL with:

```bash
myco stats
```

The dashboard lets you:

- **Configure** intelligence providers, per-task model assignments, and embedding settings
- **Run operations** like intelligence agent runs, index rebuilds, and manual digest cycles
- **Monitor** daemon health, power state, and system stats
- **View logs** in real-time with level filtering

All settings are saved to `myco.yaml` and take effect after a daemon restart (the dashboard handles this automatically).

## MCP tools

Myco exposes a set of MCP tools to your coding agent — search, recall, remember, browse sessions and plans, traverse the knowledge graph, and inspect skills. Agents discover them automatically through MCP.

See [Agent Tools](agent-tools.md) for the full reference.

## Skills

Myco **auto-generates project-specific skills** from accumulated vault knowledge — repeatable workflows that teach every agent how to work in your codebase. As the intelligence pipeline processes sessions, it identifies procedural patterns with cross-session evidence and surfaces them as candidates. You approve what becomes canon in the Skills dashboard, and Myco writes validated SKILL.md files to `.agents/skills/`. Skills evolve automatically as your code does.

Myco also ships three slash-command skills out of the box:

| Command | What it does |
|---------|-------------|
| `/myco` | Guidance on using Myco during ongoing work — design decisions, debugging, vault hygiene |
| `/myco-curate` | Manually trigger the intelligence agent to process unprocessed sessions |
| `/myco-rules` | Audit or improve project rules files (CLAUDE.md, AGENTS.md) |

See the [Skills docs](skills.md) for the full auto-curation lifecycle.

## Troubleshooting

### Something not working?

Run the health check:

```bash
myco doctor
```

To auto-repair fixable issues:

```bash
myco doctor --fix
```

### Daemon not starting

The daemon spawns automatically on session start. If it fails:

```bash
myco restart    # Manual restart
myco stats      # Check status
```

### No observations being captured

Verify your intelligence provider is configured and reachable:

```bash
myco doctor
```

For local providers, ensure they're running:

```bash
# For Ollama
curl http://localhost:11434/api/tags

# For LM Studio
curl http://localhost:1234/v1/models
```

## Optional Operator CLIs

Most users only need `@goondocks/myco`. Install the extra CLIs only when you want their dedicated operator surfaces.

### Standalone team CLI

```bash
npm install -g @goondocks/myco-team
```

Use it for:

- `myco-team install` — provision team sync (same as `myco team init`)
- `myco-team upgrade` — redeploy the worker
- `myco-team status` — show worker info and credentials
- `myco-team rotate-tokens` — rotate API key and/or MCP token
- `myco-team destroy` — tear down all Cloudflare resources

### Collective CLI

```bash
npm install -g @goondocks/myco-collective
```

Use it to create and manage a [Myco Collective](collective.md).
