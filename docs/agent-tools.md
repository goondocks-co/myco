# Agent tools

Myco gives your coding agents tools for reading project knowledge and recording what they learn. The tools are served by your Myco at `/mcp`; connected agents discover them automatically. Hosted reviewers use a project access key on the same endpoint; see [External agents](external-agents.md).

## Context without a tool call

Project instructions arrive at session start. Relevant spores and plans return with each prompt. The project's **Context for sessions** switch is on by default. Tools let an agent search deeper, revisit a session or save a discovery during its work.

## The seven tools

| Tool | Operations | What it is for |
|---|---|---|
| `myco_search` | Search | Find sessions, spores, plans, skills, prompts and responses. Results carry stable IDs and retrieval hints. |
| `myco_cortex` | `instructions`, `canopy_map`, `projects_activity` | Read standing guidance and the project ID, read the repository's code map, or see project activity. |
| `myco_plans` | `list`, `get`, `save` | Read and maintain plans. |
| `myco_sessions` | `list`, `get` | Revisit captured sessions. |
| `myco_skills` | `list`, `get` | Find the skills shipped with Myco and where their bodies are installed. |
| `myco_spores` | `list`, `get`, `save`, `supersede`, `consolidate`, `obsolete` | Record durable knowledge and retire or replace stale findings. |
| `myco_agent` | `runs`, `run` | Read Myco's task run history and details. |

These tools read and edit project intelligence. Administration belongs in the dashboard and CLI. See [Actors & boundaries](architecture/actors-and-boundaries.md).

### Name the project

Every tool accepts `project`: the project ID or the repository's Git remote. Pass it on every call. A read without it may use the connection's default project; a write without it is refused. Use `myco_cortex` with `op: "instructions"` to learn the project ID.

Search first, then fetch the result in full using its retrieval hint. When recording a spore, pass the current `session_id` when known. To supersede one, supply both `old_spore_id` and the existing replacement's `new_spore_id`. Retire a finding with no replacement using `obsolete` and a reason.

```json
{
  "op": "save",
  "project": "<project-id>",
  "type": "discovery",
  "content": "What we learned, where it applies, and why it matters.",
  "agent_line": "When working on this area, follow this guidance in the named file."
}
```

A 2.0 Deployment does not serve plan deletion or the `myco_cortex` operations `digest`, `canopy_entry`, `notifications` and `maintenance_summary`. The code map is one map per project.

## Shipped skills

The `myco` skill guides ongoing work: when to search, what to read and how to record durable findings. Agents activate it when relevant. The other eight shipped skills are user-invocable; clients that support slash commands expose these names:

| Command | Purpose |
|---|---|
| `/myco-setup` | Install the binary and connect this machine to Myco. |
| `/myco-settings` | Read or change Deployment settings. |
| `/myco-handoff` | Carry a working intention into another session. |
| `/myco-okf` | Build and maintain a project wiki in the repository. |
| `/myco-rules` | Keep project rules small, durable and canonical. |
| `/myco-outcome-tasks` | Author and debug Myco's own tasks. |
| `/myco-server-provisioning` | Provision and maintain a Myco server. |
| `/myco-server-debugging` | Diagnose server refusals and failures. |

Myco 2.0 ships these skills; it does not generate project-specific skills. See [Agents](agents.md) for their installation locations.
