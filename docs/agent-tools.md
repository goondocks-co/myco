# Agent Tools

Myco exposes two sets of MCP tools and a few slash-command skills that your agents can use. The local MCP server runs inside your daemon and serves your coding agent. The [Cloud MCP server](cloud-mcp.md) runs on the Cloudflare Worker and serves cloud agents. Both speak [Model Context Protocol](https://modelcontextprotocol.io) and discover their tools automatically.

## Automatic context injection

Before any tool is called, Myco injects context at two points automatically:

- **Session start** — the digest extract is injected, giving the agent a pre-computed understanding of the project before it asks a single question
- **Per prompt** — relevant spores are retrieved via vector search and injected, providing targeted context for the current task

See the [Lifecycle docs](lifecycle.md) for more on how this works.

## Local MCP tools

13 tools exposed through the local daemon over stdio. Available to any agent Myco has been installed into.

### Search & recall

| Tool | Purpose |
|------|---------|
| `myco_search` | Semantic + keyword search across sessions, spores, and plans. Accepts an optional type filter. |
| `myco_recall` | Context retrieval based on git branch and files. Returns relevant spores, session history, and plan progress for the current work. |
| `myco_context` | On-demand digest extract at a specific token tier (1500, 5000, or 10000). |

### Knowledge capture

| Tool | Purpose |
|------|---------|
| `myco_remember` | Save an observation as a spore. Types: `gotcha`, `decision`, `discovery`, `trade_off`, `bug_fix`. |
| `myco_save_plan` | Persist a plan directly to a session. Pass `source_path` when the plan is also written to disk; use `plan_key` for non-file-backed plans. |
| `myco_supersede` | Mark an older spore as replaced by a newer one. Lineage is preserved; the old spore is hidden from search. |
| `myco_consolidate` | Merge related spores into a single wisdom note. |

### Browsing

| Tool | Purpose |
|------|---------|
| `myco_sessions` | Browse session history with filters for branch, user, or date range. |
| `myco_plans` | List active plans and their progress, or read a specific plan. |
| `myco_graph` | Traverse graph edges in either direction, with configurable depth. |
| `myco_team` | See teammate activity, filtered by files or plan. |

### Skills

| Tool | Purpose |
|------|---------|
| `myco_skills` | List, inspect, or read auto-generated skills with their full lineage. |
| `myco_skill_candidates` | Browse the skill candidate approval queue. Also supports approve/dismiss actions. |

## Cloud MCP tools

A separate, read-only tool surface for cloud agents (Anthropic Managed Agents, N8N, OpenAI Workflows, etc.). Seven tools reshaped for cloud agent use cases rather than mirroring the local surface. See the [Cloud MCP docs](cloud-mcp.md) for the full reference and setup.

## Slash-command skills

Myco ships two slash command skills that provide guided workflows. Type the command in your agent's prompt to activate. Beyond these, Myco **auto-generates project-specific skills** from your vault knowledge — see the [Skills docs](skills.md) for the full curation lifecycle.

| Command | Purpose |
|---------|---------|
| `/myco` | The primary skill for ongoing work. Use when making design decisions, debugging non-obvious issues, encountering gotchas, or needing context about prior work. Provides guidance on when and how to use each MCP tool. |
| `/myco-rules` | Keep `AGENTS.md` minimal, durable, and canonical across agents. |
