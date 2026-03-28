<p align="center">
  <img src="assets/hero-wide.svg" alt="Myco" width="100%">
</p>

<p align="center">
  <strong>The intelligence layer for your projects and team</strong>
</p>

<p align="center">
  <a href="https://github.com/goondocks-co/myco/actions/workflows/ci.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/goondocks-co/myco/actions/workflows/publish.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/publish.yml/badge.svg" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@goondocks/myco"><img src="https://img.shields.io/npm/v/@goondocks/myco?label=npm&color=22c55e" alt="npm"></a>
  <a href="https://github.com/goondocks-co/myco/blob/main/LICENSE"><img src="https://img.shields.io/github/license/goondocks-co/myco?color=22c55e" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-22c55e" alt="Node 22+">
  <img src="https://img.shields.io/badge/symbionts-Claude%20Code%20%7C%20Cursor%20%7C%20VS%20Code-22c55e" alt="Claude Code | Cursor | VS Code">
</p>

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Then initialize in your project:
```bash
cd your-project
myco init
```

The wizard detects your coding agents, sets up intelligence and embedding providers, and starts capturing. Works with Claude Code and Cursor out of the box.

## What is Myco?

Myco is the intelligence layer beneath your projects. Named after [mycorrhizal networks](https://en.wikipedia.org/wiki/Mycorrhizal_network) — the underground fungal systems that connect trees in a forest — Myco captures what happens across your coding sessions and connects it into a living knowledge graph, sharing intelligence between agents and team members beneath the surface.

Every coding session produces knowledge: decisions made, gotchas discovered, trade-offs weighed, bugs fixed. Without Myco, that knowledge dies when the session ends. With Myco, it's captured as **spores** — discrete observations that persist, connect, and compound over time.

**For agents** — [MCP tools and skills](docs/agent-tools.md) let any agent search, recall, and build on accumulated knowledge. A digest extract is injected at session start and relevant spores surface after each prompt — agents get context without being told to search.

**For humans** — a local [dashboard](#dashboard) provides configuration, operational triggers, and monitoring. Manage providers, run intelligence cycles, and view live logs.

**For teams** — [team sync](docs/team-sync.md) shares accumulated knowledge across machines through a Cloudflare Worker. Every teammate's agent gets access to the team's collective intelligence — spores, session context, and the knowledge graph — through the same search tools they already use.

## How it works

### Capture

Myco hooks into your agent's lifecycle — session starts, prompts, tool calls, stops — and records activity in the vault's SQLite database. A background daemon parses the agent's conversation transcript to capture the full dialogue, including AI responses and any screenshots shared during the session.

### Intelligence

The Myco agent is a multi-phase reasoning pipeline that runs in the background, processing captured data through a dependency graph of tasks. Phases are organized into **waves** — groups that execute in parallel — computed via topological sort from a DAG of dependencies.

The full intelligence pipeline flows through five waves:

```
read-state → extract + summarize → consolidate + graph → digest → report
```

Each phase runs with scoped tools, a turn budget, isolated provider config, and results from prior phases as context. The agent extracts **spores** (observations like decisions, gotchas, discoveries, trade-offs, bug fixes), generates session summaries, links entities in the knowledge graph, and synthesizes digest extracts — all automatically.

**Consolidation** is where individual observations become institutional knowledge. When the agent finds 3+ semantically similar spores, it synthesizes them into a **wisdom** spore — a higher-order observation that captures the pattern across sessions. Source spores are preserved with lineage metadata, and the wisdom spore becomes the canonical reference going forward.

**Provider flexibility** — every task and phase can use a different LLM provider. Run title generation on a fast local model via Ollama, extraction on Claude, and consolidation on a larger local model via LM Studio. Configure globally or per-task in `myco.yaml`, or use the [dashboard](#dashboard) to manage assignments visually.

Seven built-in tasks cover the full lifecycle, from lightweight `title-summary` to the complete `full-intelligence` pipeline. See the [Lifecycle docs](docs/lifecycle.md) for the full architecture.

### Digest

The digest system synthesizes accumulated knowledge into tiered **extracts** — pre-computed context at different depths:

| Tier | Purpose |
|------|---------|
| **1,500 tokens** | Executive briefing — what this project is, what's active, what to avoid |
| **5,000 tokens** | Deep onboarding — trade-offs, patterns, team dynamics |
| **10,000 tokens** | Institutional knowledge — full thread history and design tensions |

The digest runs on an adaptive **metabolism**: active when new substrate (undigested data) arrives, slowing through cooling phases, and entering dormancy when the project goes quiet. New sessions reactivate it.

### Search

Every record is indexed for both keyword search (FTS5) and semantic similarity (vector embeddings). Embedding providers are pluggable — use [Ollama](https://ollama.com) locally, or [OpenRouter](https://openrouter.ai) / [OpenAI](https://platform.openai.com) in the cloud. The index is fully rebuildable from the database.

### Context injection

Two automatic injection points ensure agents always have relevant intelligence:

- **Session start** — the digest extract gives the agent pre-computed project understanding before it asks a single question.
- **Per-prompt** — after each user prompt, relevant spores are retrieved via semantic search, providing targeted context for the task at hand.

Agents don't need to search explicitly — Myco surfaces what's relevant.

### Dashboard

A local web dashboard provides configuration and operations management. Manage intelligence providers and per-task model assignments, trigger agent and digest cycles, monitor daemon health, and view live logs.

### Symbionts

Myco integrates with coding agents through **symbiont** adapters — named for the mycorrhizal symbiotic relationship between fungi and their host trees. Each adapter handles transcript discovery, conversation parsing, image extraction, and plugin registration for its host agent.

| Symbiont | Status |
|----------|--------|
| [Claude Code](https://claude.ai/code) | Supported |
| [Cursor](https://cursor.com) | Supported |
| VS Code (Copilot) | Agent manifest available |

Adding a new symbiont is declarative — define a YAML manifest in `src/symbionts/manifests/` and implement the transcript parser.

### Team sync

Share knowledge across machines and team members with one command:

```bash
myco team init    # Provisions Cloudflare D1 + Vectorize + Worker
```

Share the output URL and API key with teammates — they connect from the Team page in the dashboard. Once connected, knowledge syncs automatically: new spores, session summaries, plans, and graph edges push to the team store in the background. Search queries fan out to both local and cloud databases, merging results by relevance score.

Local databases remain the source of truth. The cloud store is a queryable mirror — no data is pulled back down. Each record carries a machine identity for attribution.

Runs on the Cloudflare free tier. See the [Team Sync docs](docs/team-sync.md) for the full guide.

### Backup & restore

Local SQL dump backups run automatically during daemon idle periods. Configure a custom backup directory (network share, git repo) from the Operations page. Restore with content-hash deduplication — never overwrites existing records.

## Health check

```bash
myco doctor
```

Verifies vault config, database, intelligence provider, embedding provider, symbiont registration, and daemon status. Use `--fix` to auto-repair fixable issues.

## Contributing

Contributions welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and the [Lifecycle docs](docs/lifecycle.md) for architecture details. Please open an issue to discuss before submitting a PR.

## License

MIT
