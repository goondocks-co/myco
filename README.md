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
# Add the Myco marketplace and install
claude plugin marketplace add goondocks-co/myco
claude plugin install myco@myco-plugins
```

Then initialize in your project:
```
> /myco-setup
```

The agent sets up your vault, configures intelligence, and starts capturing. Works with Claude Code and Cursor out of the box.

## What is Myco?

Myco captures everything your AI agents do — sessions, decisions, plans, discoveries — and connects them into a searchable intelligence graph stored as an [Obsidian](https://obsidian.md) vault. Named after [mycorrhizal networks](https://en.wikipedia.org/wiki/Mycorrhizal_network), the underground fungal systems that connect trees in a forest, Myco is the invisible network linking your agents and team members, sharing intelligence beneath the surface.

**For agents** — [12 MCP tools and 3 skills](docs/agent-tools.md) let any agent search, recall, and build on accumulated knowledge. A digest extract is injected at session start, and relevant spores are injected after each user prompt — agents get context automatically without being told to search.

**For humans** — open the vault in [Obsidian](https://obsidian.md) to browse the intelligence graph visually, or use the local web dashboard to manage configuration, run operations, and monitor system health. Everything is Markdown with backlinks — your team's connected knowledge, navigable and searchable.

**For teams** — the vault is a Git-friendly directory of Markdown files. Share it through your existing Git workflow.

## How it works

### Capture

A background daemon reads your agent's conversation transcript after each turn — the full dialogue including prompts, AI responses, tool calls, and screenshots. Observations called **spores** (decisions, gotchas, discoveries, trade-offs, bug fixes) are extracted automatically via a local LLM and written as linked vault notes.

### Curate

As a project evolves, older observations become stale. Myco automatically detects and supersedes outdated spores when new ones are created — using vector similarity to find candidates and an LLM to judge which are truly replaced vs. merely related. Related spores are automatically consolidated into comprehensive wisdom notes during each digest cycle, compressing scattered observations into denser, higher-quality knowledge. Superseded spores are preserved with lineage metadata (never deleted), but filtered from search results and digest synthesis. Run vault-wide curation from the dashboard, or let it happen automatically.

### Digest

A **continuous reasoning engine** runs inside the daemon, periodically synthesizing all accumulated knowledge into tiered context extracts. Before each digest cycle, an optional consolidation pre-pass compresses related spores into wisdom notes, ensuring the digest operates on clean, dense substrate. The pre-computed extracts give agents an instant, rich understanding of the project at session start — no searching required. Four tiers serve different needs: executive briefing (1.5K tokens), team standup (3K), deep onboarding (5K), and institutional knowledge (10K). Trigger digest cycles and manage tiers from the dashboard.

### Index

Every note is indexed for both keyword search (SQLite FTS5) and semantic search (vector embeddings via Ollama or LM Studio). The index is fully rebuildable from the Markdown source of truth.

### Serve

An MCP server exposes 12 tools to any agent runtime. Two automatic injection points ensure agents always have relevant context:

- **Session start** — the digest extract is injected via the `SessionStart` hook, giving the agent a pre-computed understanding of the project before it asks a single question.
- **Per-prompt** — after each user prompt, relevant spores are retrieved via vector search and injected via the `UserPromptSubmit` hook, providing targeted intelligence for the task at hand.

Agents build on your team's accumulated knowledge without being told to. See the [Lifecycle docs](docs/lifecycle.md) for the full event flow.

### Connect

Sessions link to plans. Plans link to decisions. Decisions link to spores. Obsidian backlinks and metadata create a navigable graph of your team's institutional knowledge. Open the vault in [Obsidian](https://obsidian.md) to browse it visually, or let agents traverse it via MCP tools.

### Dashboard

A local web dashboard at `http://localhost:<port>/` provides configuration management and operational triggers — no CLI or YAML editing needed. Manage intelligence providers, run curation and digest cycles, monitor daemon health, and view live logs. The daemon writes a `_portal.md` to your vault with the URL, so you can find it from Obsidian.

### Multi-agent

Myco reads conversation transcripts from Claude Code, Cursor, and any agent that writes JSONL transcripts. Screenshots shared during sessions are extracted and embedded as Obsidian image attachments. A plugin adapter registry makes adding new agents straightforward.

## Contributing

Contributions welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and the [Lifecycle docs](docs/lifecycle.md) for architecture details. Please open an issue to discuss before submitting a PR.

## License

MIT
