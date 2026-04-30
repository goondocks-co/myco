# Agent Tools

Myco exposes two sets of MCP tools and a few slash-command skills that your agents can use. The local MCP server runs inside your daemon and serves your coding agent. The [Cloud MCP server](cloud-mcp.md) runs on the Cloudflare Worker and serves cloud agents. Both speak [Model Context Protocol](https://modelcontextprotocol.io) and discover their tools automatically.

## Automatic context injection

Before any tool is called, Myco injects context at two points automatically:

- **Session start** — the digest extract is injected, giving the agent a pre-computed understanding of the project before it asks a single question
- **Per prompt** — relevant spores are retrieved via vector search and injected, providing targeted context for the current task

See the [Lifecycle docs](lifecycle.md) for more on how this works.

## Local MCP tools

7 tools exposed through the local daemon over stdio or Streamable HTTP. Available to any agent Myco has been installed into. When the project is connected to a Myco Collective, 4 additional `collective_*` tools are also registered. The canonical list lives in `packages/myco/src/tools/definitions.ts`.

### Search & Cortex

| Tool | Purpose |
|------|---------|
| `myco_search` | Semantic + keyword search across sessions, spores, plans, skills, and Canopy file summaries. Results include stable IDs and `retrieve` hints pointing to the owning entity tool. |
| `myco_cortex` | Cortex project intelligence: digest (`op=digest`), generated instructions, Canopy map (`op=canopy_map`), and Canopy entries returned by search (`op=canopy_entry`). |

### Entity tools

| Tool | Purpose |
|------|---------|
| `myco_plans` | List, retrieve, save, or delete plans using `op=list|get|save|delete`. |
| `myco_sessions` | List or retrieve session history using `op=list|get`. |
| `myco_skills` | List, inspect, or read auto-generated skills with their full lineage. |
| `myco_spores` | List, retrieve, save, supersede, or consolidate spores using `op=list|get|save|supersede|consolidate`. |
| `myco_agent` | Read agent run history using `op=runs|run` — token budget, cost, reasoning level, and per-run details. |

## Cloud MCP tools

A separate, read-only tool surface for cloud agents (Anthropic Managed Agents, N8N, OpenAI Workflows, etc.). Six tools follow the same search-then-entity access pattern as local MCP while limiting operations to synced team reads. See the [Cloud MCP docs](cloud-mcp.md) for the full reference and setup.

## Slash-command skills

Myco ships two slash command skills that provide guided workflows. Type the command in your agent's prompt to activate. Beyond these, Myco **auto-generates project-specific skills** from your vault knowledge — see the [Skills docs](skills.md) for the full curation lifecycle.

| Command | Purpose |
|---------|---------|
| `/myco` | The primary skill for ongoing work. Use when making design decisions, debugging non-obvious issues, encountering gotchas, or needing context about prior work. Provides guidance on when and how to use each MCP tool. |
| `/myco-rules` | Keep `AGENTS.md` minimal, durable, and canonical across agents. |
