# Myco Quick Start

Myco is the nervous system for AI-assisted software teams. It captures session knowledge — events, observations, decisions, trade-offs, codebase context, and learned workflows — into a local Grove vault and routes the right context back to the coding agents, subagents, and agent teams you already use.

Myco does not replace an agent's reasoning, native memory, tools, or workflow. It augments those systems with shared project knowledge, semantic codebase awareness, and workflows that compound across sessions and teammates.

## Requirements

- **A supported OS** — macOS (arm64/x64), Linux (x64/arm64), or Windows (x64). Myco ships as a self-contained native binary, so **no Node runtime is required to run it**. macOS is the supported path, with **Linux and Windows in beta**. On Windows, only **x64** is supported — Windows on ARM (which runs the x64 build under emulation) is not supported.
- **At least one supported coding agent** — Claude Code, Cursor, Codex, Cline, Copilot, Google Antigravity, Devin Desktop, OpenCode, or Pi
- **Node 22+** is only needed for the optional npm install path.

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

On Windows x64 (PowerShell, beta):
```powershell
irm https://myco.sh/install.ps1 | iex
```

The installer downloads the native binary to `~/.myco/bin` (`%LOCALAPPDATA%\Myco\bin` on Windows), starts the managed local service, and connects supported coding agents — no Node runtime required.

If you already have Node, you can install with npm instead. This is a thin bootstrap that converges to the same native binary:
```bash
npm install -g @goondocks/myco
```

## Upgrade Existing Installs

Myco keeps itself up to date **automatically** — the local service self-updates from the release channel in the background while it's idle. You can also trigger an upgrade from the **Upgrade** section of the dashboard's **Settings** page. There is nothing to run by hand and no `npm update` step.

For advanced or scripted use, the `myco upgrade` CLI (with `--channel stable|beta`) is available, but the automatic and dashboard paths are the normal way to stay current.

## That's it — ready by default

Once Myco is installed, the local service starts automatically. On first boot it creates a **default Grove** to hold your captured sessions, then connects detected coding agents to Myco. The first time you use a supported agent from a real git repo, Myco auto-registers that project into your default Grove. The dashboard is available immediately — you can configure intelligence providers, create additional Groves, or move projects between Groves before your first captured session.

New agent installed later? Myco detects it automatically, or you can re-detect from the dashboard's Symbionts page.

To share a project with teammates, commit the `.myco/project.toml` file — Myco creates it automatically and tracks it in git. It carries the project's identity, so when a teammate clones the repo their sessions land in the same project. Everything else under `.myco/` is per-machine and stays out of git.

Myco captures inside **git repositories only** — a project is a git repo. Work in a non-git folder isn't recorded; open a git repo (or run `git init`) to start capturing.

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
- **After the session**: Myco extracts spores, generates summaries, and links them to your sessions and plans
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
- **Manage** Groves, projects, archive/unarchive, project capability toggles, and destructive delete with confirmation
- **Run operations** like intelligence agent runs, index rebuilds, and manual digest cycles
- **Monitor** service health, background activity, and system stats
- **View logs** in real-time with level filtering

The Settings page shows where each setting applies. Changes take effect automatically, and the dashboard prompts for a restart only when one is required.

See [Grove Management](groves.md) for the guide to Groves, project movement, capture-only projects, and capability toggles.

## MCP tools

Myco exposes a set of MCP tools to your coding agent — search, recall, remember, browse sessions and plans, and inspect skills. Agents discover them automatically through MCP.

See [Agent Tools](agent-tools.md) for the full reference.

## Skills

Myco **auto-generates project-specific skills** from accumulated vault knowledge — repeatable workflows that teach every connected agent how to work in your codebase. As the intelligence pipeline processes sessions, it identifies procedural patterns with cross-session evidence and surfaces them as candidates. You approve what becomes canon in the Skills dashboard; Myco generates and validates the skill, and when you **Publish** it, the SKILL.md file lands in your project for every agent to load. Skills evolve automatically as your code does.

Myco also ships a built-in `myco` skill that activates automatically during ongoing work (design decisions, debugging, vault hygiene), plus three slash-command skills:

| Command | What it does |
|---------|-------------|
| `/myco-rules` | Keep `AGENTS.md` minimal, durable, and canonical across agents |
| `/myco-okf` | Create and maintain an OKF-conformant project wiki from your Myco intelligence |
| `/myco-handoff` | Hand work off between sessions with plans and context intact |

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

Myco is installed as a per-user service and starts at login. Linux and Windows service support is in beta (Windows is x64-only). If it fails:

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

Most users only need `@goondocks/myco`. Team Host operator commands (`myco host enable`, `myco join`, `myco attach`) are already part of that package — see the [Team Host guide](team-host.md) for running a team server or joining one.
