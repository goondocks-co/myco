# Myco Quick Start

Myco is a collective agent intelligence plugin that captures session knowledge — events, observations, decisions, trade-offs — into a SQLite-backed intelligence graph and serves it back via MCP tools. Install it, run `myco init` to configure your project, and start building institutional memory.

## Requirements

- **Node.js 22+**
- **Embedding provider** (one of):
  - [Ollama](https://ollama.com) with `bge-m3` model (local, free, recommended)
  - [OpenRouter](https://openrouter.ai) API key (cloud)
  - [OpenAI](https://platform.openai.com) API key (cloud)
- **Intelligence provider** (one of):
  - Cloud (Claude) — uses your existing Claude Code subscription or Anthropic API key
  - [Ollama](https://ollama.com) — local models for extraction, summarization, and analysis
  - [LM Studio](https://lmstudio.ai) — local models via OpenAI-compatible API

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

Run the interactive setup wizard:

```bash
cd your-project
myco init
```

This guides you through:

1. **Intelligence provider** — Cloud (Claude), Ollama, or LM Studio for agent tasks
2. **Embedding provider** — Ollama (local), OpenRouter, OpenAI, or skip
3. **Model selection** — picks from available models with recommended defaults
4. **Agent detection** — finds Claude Code, Cursor, and registers the plugin

### Pull Ollama Models (if using local embeddings)

```bash
ollama pull bge-m3
```

### Health Check

After setup, verify everything is connected:

```bash
myco doctor
```

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
