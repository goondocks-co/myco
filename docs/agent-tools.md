# Agent tools

Every agent connected to a Deployment reaches the project's knowledge through [Model Context Protocol](https://modelcontextprotocol.io) tools. `myco member provision <agent>` gives an agent its Myco MCP entry, which points at the Deployment's `/mcp` address. When the agent connects, it asks `myco` for the sign-in details, so no token is written into the agent's config. See [Agents](agents.md).

The tools read and curate knowledge. They do not administer Myco: settings, members and backups live in the dashboard and the `myco server` commands.

## The tools

| Tool | What it does |
|---|---|
| `myco_search` | Searches the project's sessions, spores, plans, skills, prompts and responses. Each result says which tool fetches it in full. |
| `myco_sessions` | Lists past sessions and reads one. |
| `myco_plans` | Lists, reads and saves plans. |
| `myco_spores` | Lists, reads and saves spores, and marks one replaced by a newer one, merged with others, or no longer true. |
| `myco_cortex` | The project's instructions and id, the repository map (`op: "canopy_map"`), and recent activity across projects. |
| `myco_skills` | Lists the skills that ship with Myco and what each is for. |
| `myco_agent` | Reads the history of Myco's own runs. |

A read with no `project` uses the caller's project. A write must name its `project` and is refused otherwise.

Some operations are not offered by a Deployment and answer `not_served`:

- `myco_cortex` ops `digest`, `canopy_entry`, `notifications` and `maintenance_summary`;
- `myco_plans` op `delete`.

## Agents that are not members

A hosted code reviewer or an automation platform has no Myco session and signs in as no one. An administrator can give it an access key for one project. It can then search and read that project and record spores of its own. See [External agents](external-agents.md).

The Myco plugin in your agent's plugin marketplace uses the same kind of key. It carries the skills and the tools and needs no binary. Paste in your Deployment's address and an access key, and the tools answer. Nothing is captured until the machine is also [signed in](quickstart.md).

## Skills

Myco's skills ship with the plugin:

- the `myco` skill, which tells an agent when to reach for each tool;
- `/myco-rules`, to keep `AGENTS.md` short and durable;
- `/myco-handoff`, to hand work to another session;
- `/myco-okf`, to keep a project wiki in the repository.
