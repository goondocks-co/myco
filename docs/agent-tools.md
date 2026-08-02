# Agent Tools

Myco exposes MCP tools and slash-command skills that your agents can use without leaving their native workflows. Local tools serve coding agents on your machine, and the [external MCP endpoint](team-host.md#external-read-only-mcp) serves agents that aren't Myco members from a Team Host's team storage. Both speak [Model Context Protocol](https://modelcontextprotocol.io) and discover their tools automatically.

## Automatic context injection

Before any tool is called, Myco can route context at three points automatically:

- **Session start** — a Cortex project briefing gives the agent a pre-computed understanding of the project before it asks a single question
- **Per prompt** — relevant spores are retrieved via vector search, providing targeted context for the current task
- **Pre-Read** — [Canopy](canopy.md) provides per-file anatomy so the agent can decide whether to follow through with a full read

These context routes augment the agent's native memory and tools. Myco does not replace the agent's reasoning or workflow. See the [Lifecycle docs](lifecycle.md) for more on how this works.

## Local MCP tools

Seven local tools are available to any symbiont Myco has connected.

The MCP surface is intentionally limited to **read and editorial** operations — symbionts use Myco's project intelligence; they do not administer Myco. Administrative operations such as restart, update, backup, restore, and maintenance live in the **CLI** and **UI**. See [Actors and Boundaries](architecture/actors-and-boundaries.md).

Every vault-scoped tool accepts optional `grove_id` and `project_id` fields so agents can work with the same Grove/project selection model shown in the dashboard.

### Search & Cortex

| Tool | Purpose |
|------|---------|
| `myco_search` | Semantic + keyword search across sessions, spores, plans, skills, and Canopy file summaries. Results include stable IDs and `retrieve` hints pointing to the owning entity tool. |
| `myco_cortex` | Cortex project intelligence: digest (`op=digest`), generated instructions, Canopy map (`op=canopy_map`), Canopy entries (`op=canopy_entry`), pending notifications (`op=notifications`), per-Grove maintenance summary (`op=maintenance_summary`), and cross-Grove project activity (`op=projects_activity`). |

### Entity tools

| Tool | Purpose |
|------|---------|
| `myco_plans` | List, retrieve, save, or delete plans using `op=list|get|save|delete`. |
| `myco_sessions` | List or retrieve session history using `op=list|get`. |
| `myco_skills` | List, inspect, or read auto-generated skills with their full lineage. |
| `myco_spores` | List, retrieve, save, supersede, or consolidate spores using `op=list|get|save|supersede|consolidate`. |
| `myco_agent` | Read agent run history using `op=runs|run` — token budget, cost, reasoning level, and per-run details. |

## External MCP tools

A separate, read-only tool surface for agents that aren't Myco members — managed agents, automation platforms, anything that speaks MCP over HTTPS. Six tools follow the same search-then-entity access pattern as local MCP while limiting operations to reads against a Team Host's team storage. See the [Team Host docs](team-host.md#external-read-only-mcp) for the full reference and setup.

## Slash-command skills

Myco ships a built-in `myco` skill — the primary skill for ongoing work (design decisions, debugging non-obvious issues, gotchas, context about prior work; it guides when and how to use each MCP tool) — which agents activate automatically rather than via a slash command. Alongside it, three slash-command skills provide guided workflows; type the command in your agent's prompt to activate. Beyond these, Myco **auto-generates project-specific skills** from your vault knowledge — see the [Skills docs](skills.md) for the full curation lifecycle.

| Command | Purpose |
|---------|---------|
| `/myco-rules` | Keep `AGENTS.md` minimal, durable, and canonical across agents. |
| `/myco-okf` | Create and maintain an OKF-conformant project wiki — a portable, git-committed markdown knowledge base synthesized from your project's Myco intelligence — directly in the repo, no daemon feature required. |
| `/myco-handoff` | Hand work off between sessions — package plans, context, and skills for the next session to receive. |
