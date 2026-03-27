<p align="center">
  <img src="assets/hero-wide.svg" alt="Myco" width="100%">
</p>

<p align="center">
  <strong>The connected intelligence layer for agents and AI-assisted teams</strong>
</p>

<p align="center">
  <a href="https://github.com/goondocks-co/myco/actions/workflows/ci.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/goondocks-co/myco/actions/workflows/publish.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/publish.yml/badge.svg" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@goondocks/myco"><img src="https://img.shields.io/npm/v/@goondocks/myco?label=npm&color=22c55e" alt="npm"></a>
  <a href="https://github.com/goondocks-co/myco/blob/main/LICENSE"><img src="https://img.shields.io/github/license/goondocks-co/myco?color=22c55e" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-22c55e" alt="Node 22+">
  <img src="https://img.shields.io/badge/agents-Claude%20%7C%20Cursor%20%7C%20VS%20Code-22c55e" alt="Claude | Cursor | VS Code">
</p>

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Then initialize in your project:
```bash
cd your-project
myco init
```

The wizard guides you through provider setup, detects your coding agents, and starts capturing. Works with Claude Code and Cursor out of the box.

## What is Myco?

Myco captures everything your AI agents do — sessions, decisions, plans, discoveries — and connects them into a searchable intelligence graph backed by SQLite. Named after [mycorrhizal networks](https://en.wikipedia.org/wiki/Mycorrhizal_network), the underground fungal systems that connect trees in a forest, Myco is the invisible network linking your agents and team members, sharing intelligence beneath the surface.

**For agents** — [MCP tools and skills](docs/agent-tools.md) let any agent search, recall, and build on accumulated knowledge. A digest extract is injected at session start, and relevant spores are injected after each user prompt — agents get context automatically without being told to search.

**For humans** — a local web dashboard provides configuration management, operational triggers, and system monitoring. Manage intelligence providers, run agent and digest cycles, and view live logs.

**For teams** — the `.myco/` directory lives in your project root. Share configuration through your existing Git workflow.

## How it works

### Capture

Plugin hooks record prompts, AI responses, tool calls, and screenshots from your agent's conversation transcript. A background daemon extracts observations called **spores** (decisions, gotchas, discoveries, trade-offs, bug fixes) and stores them in the database alongside full session records.

### Intelligence

The Myco agent runs in the background, reasoning about captured data in phases. It extracts Spores (observations), generates session summaries, and looks for patterns and deeper learnings which turn into long-term wisdom, along with building a connected knowledge graph — all automatically.

### Digest

A continuous reasoning engine synthesizes accumulated knowledge into tiered context extracts. Four tiers serve different needs: executive briefing (1.5K tokens), team standup (3K), deep onboarding (5K), and institutional knowledge (10K). These pre-computed extracts give agents instant, rich project understanding at session start — no searching required.

### Index

Every record is indexed for both keyword search (SQLite FTS5) and semantic search (vector embeddings via Ollama, OpenRouter, or OpenAI). The index is fully rebuildable from the database.

### Serve

An MCP server exposes tools to any agent runtime. Two automatic injection points ensure agents always have relevant context:

- **Session start** — the digest extract is injected via the `SessionStart` hook, giving the agent a pre-computed understanding of the project before it asks a single question.
- **Per-prompt** — after each user prompt, relevant spores are retrieved via vector search and injected via the `UserPromptSubmit` hook, providing targeted intelligence for the task at hand.

### Dashboard

A local web dashboard at `http://localhost:<port>/` provides configuration management and operational triggers. Manage intelligence providers and per-task model assignments, run agent and digest cycles, monitor daemon health, and view live logs.

### Multi-agent

Myco reads conversation transcripts from Claude Code, Cursor, and any agent that writes JSONL transcripts. Screenshots shared during sessions are extracted and stored as attachments. A plugin adapter registry makes adding new agents straightforward.

## Health Check

```bash
myco doctor
```

Verifies vault config, database, intelligence provider, embedding provider, agent registration, and daemon status. Use `--fix` to auto-repair fixable issues.

## Contributing

Contributions welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and the [Lifecycle docs](docs/lifecycle.md) for architecture details. Please open an issue to discuss before submitting a PR.

## License

MIT
