# Myco Quick Start

Myco is a collective agent intelligence plugin that captures session knowledge — events, observations, decisions, trade-offs — into a SQLite-backed intelligence graph and serves it back via MCP tools. Install it, run `myco init` to bootstrap your project, then configure providers in the dashboard when you're ready.

## Requirements

- **Node.js 22+**
- **At least one supported coding agent** — Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI, Windsurf, or OpenCode

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

## Set Up Your Project

```bash
cd your-project
myco init
```

`myco init` is a fast bootstrap. It:

1. **Detects coding agents** — finds Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI, Windsurf, or OpenCode and lets you pick which to register
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

## MCP Tools

Myco exposes 12 tools to your coding agent via MCP:

| Tool | What it does |
|------|-------------|
| `myco_search` | Semantic + keyword search across spores, sessions, and plans |
| `myco_recall` | Retrieve relevant spores for the current git branch and files |
| `myco_context` | Fetch a digest extract at a specific token tier |
| `myco_remember` | Capture a new observation (gotcha, decision, discovery, trade-off, bug-fix) |
| `myco_supersede` | Mark a spore as replaced by a newer one |
| `myco_consolidate` | Merge related spores into a wisdom note |
| `myco_sessions` | Browse session history with filters |
| `myco_plans` | List and read active plans |
| `myco_graph` | Traverse knowledge graph connections |
| `myco_team` | View team member activity |
| `myco_skills` | List and inspect auto-generated skills and their lineage |
| `myco_skill_candidates` | Browse the skill candidate approval queue |

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
