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

Myco exposes these tools to your coding agent via MCP:

| Tool | What it does |
|------|-------------|
| `myco_recall` | Retrieve relevant spores for the current context |
| `myco_remember` | Capture a new observation or decision |
| `myco_search` | Search by keyword or semantic similarity |
| `myco_sessions` | List recent sessions with summaries |
| `myco_graph` | Traverse connections in the knowledge graph |
| `myco_plans` | List and read plan documents |
| `myco_team` | View team member activity |

## Skills

| Command | What it does |
|---------|-------------|
| `/myco-rules` | Audit or improve project rules files |

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
