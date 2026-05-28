# Myco Quick Start

Myco is the nervous system for AI-assisted software teams. It captures session knowledge — events, observations, decisions, trade-offs, codebase context, and learned workflows — into a local Grove vault and routes the right context back to the coding agents, subagents, and agent teams you already use.

Myco does not replace an agent's reasoning, native memory, tools, or workflow. It augments those systems with shared project knowledge, semantic codebase awareness, and workflows that compound across sessions and teammates.

## Requirements

- **Node.js 22+**
- **At least one supported coding agent** — Claude Code, Cursor, Codex, Copilot, Google Antigravity, Windsurf, OpenCode, or Pi
- **macOS** for the supported 1.0 path. Linux and Windows packages are available for early testing, but they are experimental.

Provider configuration is **optional** at install time. Myco captures sessions and provides full-text search immediately. To enable spores, digests, semantic search, Canopy summaries, and skill lifecycle features, configure intelligence and embedding providers in the dashboard after install.

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
myco open
```

On Windows (PowerShell, experimental):
```powershell
irm https://myco.sh/install.ps1 | iex
```

Or install manually with npm:
```bash
npm install -g @goondocks/myco
```

## Upgrade Existing Installs

Existing users upgrade the main product the same way:

```bash
npm update -g @goondocks/myco
```

That updates the local CLI, service, dashboard, agent connections, and built-in intelligence pipeline. If you later install one of the standalone operator CLIs, the Operations page will detect and apply updates for those installed Myco packages too. You do not need to install extra packages unless you want one of the standalone operator CLIs:

- `@goondocks/myco-team` for direct team-worker administration commands
- `@goondocks/myco-collective` for cross-project Collective administration

## That's it — ready by default

Once Myco is installed, the local service starts automatically. On first boot it creates a **default Grove** to hold your captured sessions, then connects detected coding agents to Myco. The first time you use a supported agent from a real git repo, Myco auto-registers that project into your default Grove. The dashboard is available immediately — you can configure intelligence providers, create additional Groves, or move projects between Groves before your first captured session.

New agent installed later? Myco detects it automatically, or you can re-detect from the dashboard's Symbionts page.

If you want a project's Myco identity committed to the repo for teammates, open the dashboard's **Symbionts page** and use **Commit Myco config to this repo**.

Session capture starts immediately and you get full-text search out of the box. To enable the deeper intelligence features, configure an agent provider in the dashboard's **Myco Agent** section.

### Configure Providers in the Dashboard

Open the dashboard to the Settings page. Two cards are at the top:

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

Doctor warns rather than errors when provider config is absent, because capture and full-text search are useful before intelligence providers are configured.

## What Happens Next

Once installed, Myco works automatically:

- **Session start**: Myco adds a project briefing when intelligence providers are configured
- **During the session**: Activity (prompts, tool calls, responses) is captured in the vault
- **After the session**: Myco extracts spores, generates summaries, and maintains the knowledge graph
- **Over time**: Repeated lessons become wisdom, stale knowledge can be superseded, and approved skills evolve with the code

You don't need to drive the loop manually. Myco captures knowledge in the background and augments your agents without taking over their native memory or workflows.

## Dashboard

Myco includes a local web dashboard for configuration and operations management. After the service starts, open it with:

```bash
myco open
```

You can also open the dashboard directly at [http://localhost:20915/](http://localhost:20915/). If your local install reports a different service URL, `myco open` will open the right one.

The dashboard lets you:

- **Configure** intelligence providers, per-task model assignments, and embedding settings
- **Manage** Groves, projects, archive/unarchive, and destructive delete with confirmation
- **Run operations** like intelligence agent runs, index rebuilds, and manual digest cycles
- **Monitor** service health, background activity, and system stats
- **View logs** in real-time with level filtering

The Settings page shows where each setting applies. Changes take effect automatically, and the dashboard prompts for a restart only when one is required.

## MCP tools

Myco exposes a set of MCP tools to your coding agent — search, recall, remember, browse sessions and plans, traverse the knowledge graph, and inspect skills. Agents discover them automatically through MCP.

See [Agent Tools](agent-tools.md) for the full reference.

## Skills

Myco **auto-generates project-specific skills** from accumulated vault knowledge — repeatable workflows that teach every connected agent how to work in your codebase. As the intelligence pipeline processes sessions, it identifies procedural patterns with cross-session evidence and surfaces them as candidates. You approve what becomes canon in the Skills dashboard, and Myco writes validated SKILL.md files to `.agents/skills/`. Skills evolve automatically as your code does.

Myco also ships two slash-command skills out of the box:

| Command | What it does |
|---------|-------------|
| `/myco` | Guidance on using Myco during ongoing work — design decisions, debugging, vault hygiene |
| `/myco-rules` | Keep `AGENTS.md` minimal, durable, and canonical across agents |

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

### Service not starting

Myco is installed as a per-user service and starts at login. Linux and Windows service support is experimental. If it fails:

```bash
myco restart    # Manual restart
myco stats      # Check status
myco logs       # Tail the service log
```

If Myco is running but no projects are registered yet, start work with a supported agent from any git-tracked project. Myco auto-registers that project into your default Grove and capture starts immediately.

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

## Uninstall

```bash
myco remove           # remove Myco's contributions from every agent's global config
myco remove --purge   # additionally remove ~/.myco/ itself
```

`myco remove` preserves user-pre-existing keys in shared agent config files (for example, a `[features].hooks` entry you added to `~/.codex/config.toml` yourself).

## Optional Operator CLIs

Most users only need `@goondocks/myco`. Install the extra CLIs only when you want their dedicated operator surfaces.

### Standalone team CLI

```bash
npm install -g @goondocks/myco-team
```

Use it for:

- `myco-team install` — provision team sync
- `myco-team upgrade` — redeploy the worker
- `myco-team status` — show worker info and credentials
- `myco-team rotate-tokens` — rotate API key and/or MCP token
- `myco-team reindex-vectors` — rebuild the Vectorize index
- `myco-team destroy` — tear down all Cloudflare resources

### Collective CLI

```bash
npm install -g @goondocks/myco-collective
```

Use it to create and manage a [Myco Collective](collective.md).
