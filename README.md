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

**For agents** — MCP tools let any agent runtime search, recall, and build on your team's accumulated knowledge.
```
myco_search("how did we handle auth?")  → semantically matched sessions, decisions, and linked context
myco_recall("migration plan")           → full decision history with session lineage
myco_remember(observation)              → persist a discovery for the team
myco_context(tier: 3000)                → pre-computed project understanding, instantly available
```

**For humans** — open the vault in Obsidian and browse the intelligence graph visually. Sessions link to plans, plans link to decisions, decisions link to spores. It's all Markdown with backlinks — your team's connected knowledge, navigable and searchable.

**For teams** — the vault is a Git-friendly directory of Markdown files. Share it through your existing Git workflow.

## How it works

### Capture

A background daemon reads your agent's conversation transcript after each turn — the full dialogue including prompts, AI responses, tool calls, and screenshots. Observations called **spores** (decisions, gotchas, discoveries, trade-offs, bug fixes) are extracted automatically via a local LLM and written as linked vault notes.

### Curate

As a project evolves, older observations become stale. Myco automatically detects and supersedes outdated spores when new ones are created — using vector similarity to find candidates and an LLM to judge which are truly replaced vs. merely related. Superseded spores are preserved with lineage metadata (never deleted), but filtered from search results and digest synthesis. Run `myco curate` for vault-wide cleanup, or let it happen automatically on every spore write.

### Digest

A **continuous reasoning engine** runs inside the daemon, periodically synthesizing all accumulated knowledge into tiered context extracts. These pre-computed summaries give agents an instant, rich understanding of the project at session start — no searching required. Four tiers serve different needs: executive briefing (1.5K tokens), team standup (3K), deep onboarding (5K), and institutional knowledge (10K). Run `myco digest --tier 3000` to reprocess a specific tier from scratch, or `myco digest --full` for a complete rebuild.

### Index

Every note is indexed for both keyword search (SQLite FTS5) and semantic search (vector embeddings via Ollama or LM Studio). The index is fully rebuildable from the Markdown source of truth.

### Serve

An MCP server exposes the vault to any agent runtime. The digest extract is injected at session start for immediate context, and relevant spores are injected per-prompt for targeted intelligence. Agents build on your team's accumulated knowledge without being told to.

### Connect

Sessions link to plans. Plans link to decisions. Decisions link to spores. Obsidian backlinks and metadata create a navigable graph of your team's institutional knowledge. Open the vault in [Obsidian](https://obsidian.md) to browse it visually, or let agents traverse it via MCP tools.

### Multi-agent

Myco reads conversation transcripts from Claude Code, Cursor, and any agent that writes JSONL transcripts. Screenshots shared during sessions are extracted and embedded as Obsidian image attachments. A plugin adapter registry makes adding new agents straightforward.

## Contributing

Contributions welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and the [Lifecycle docs](docs/lifecycle.md) for architecture details. Please open an issue to discuss before submitting a PR.

## License

MIT
