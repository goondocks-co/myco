# Agent Tools

Myco provides two categories of tools: **MCP tools** that agents call programmatically, and **skills** that users invoke via slash commands. Both are available automatically when Myco is installed.

## Automatic Context Injection

Before any tool is called, Myco injects context at two points automatically:

- **Session start** (`SessionStart` hook) — the digest extract is injected, giving the agent a pre-computed understanding of the project before it asks a single question.
- **Per-prompt** (`UserPromptSubmit` hook) — relevant spores are retrieved via vector search and injected, providing targeted context for the current task.

See the [Lifecycle docs](lifecycle.md) for the full event flow.

## MCP Tools

12 tools exposed via the [Model Context Protocol](https://modelcontextprotocol.io) to any compatible agent runtime. Agents discover them automatically through MCP.

### Search & Recall

| Tool | Purpose |
|------|---------|
| `myco_search` | Semantic + keyword search across sessions, spores, and plans. Accepts a query string and optional type filter (`spore`, `session`, `plan`). |
| `myco_recall` | Context retrieval based on git branch and files. Returns relevant spores, session history, and plan progress for the current work. |
| `myco_context` | On-demand digest extract at a specific token tier (1500, 3000, 5000, or 10000). |

### Knowledge Capture

| Tool | Purpose |
|------|---------|
| `myco_remember` | Save an observation as a spore. Types: `gotcha`, `decision`, `discovery`, `trade_off`, `bug_fix`. |
| `myco_supersede` | Mark an older spore as replaced by a newer one. The old spore is preserved with lineage metadata but filtered from search and digest. |
| `myco_consolidate` | Merge related spores into a single wisdom note. Source spores are marked superseded with bidirectional links. |

### Browsing & Navigation

| Tool | Purpose |
|------|---------|
| `myco_sessions` | Browse session history with filters: branch, plan, user, or date range. |
| `myco_plans` | List active plans and their progress, or read a specific plan by ID. |
| `myco_graph` | Traverse connections via graph edges in either direction, with configurable depth. |
| `myco_team` | See teammate activity, filtered by files or plan. |

### Skills

| Tool | Purpose |
|------|---------|
| `myco_skills` | List, inspect, or read auto-generated skills with their full lineage history. Filter by status (active, retired) or managed_by field. |
| `myco_skill_candidates` | Browse skill candidates in the approval queue. Also supports approve/dismiss actions for workflow automation. |

## Skills (Slash Commands)

Myco ships with three slash command skills that provide guided workflows. Type the command in your agent's prompt to activate. Beyond these, Myco **auto-generates project-specific skills** from your vault knowledge — see the [Skills docs](skills.md) for the full curation lifecycle.

| Command | Purpose |
|---------|---------|
| `/myco` | The primary skill for ongoing work. Use when making design decisions, debugging non-obvious issues, encountering gotchas, or needing context about prior work. Provides guidance on when and how to use each MCP tool, and patterns for vault hygiene (superseding stale spores, consolidating related observations). |
| `/myco-curate` | Trigger the Myco intelligence agent to process unprocessed session data, extract observations, and maintain the vault knowledge graph. |
| `/myco-rules` | Create, audit, or improve project rules files (CLAUDE.md, AGENTS.md). Helps write specific, enforceable rules that agents actually follow. Also triggered when Myco detects recurring patterns that should become project rules. |
