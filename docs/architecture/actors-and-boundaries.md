# Actors and Boundaries

> **TL;DR.** Myco has three actors — the Myco agent (internal harness), Symbionts (coding agents like Claude Code), and Users (humans). Each touches a specific surface. Mixing them is the source of architectural drift. The short form lives in [`AGENTS.md`](../../AGENTS.md#actors-and-boundaries); this is the long-form reference.

## The three actors

### Myco agent

Myco's own intelligence runs on registered runners. The Deployment builds each task's prompt and checks its result:

- `extract-curate` — learns from captured sessions
- `vault-seed` — learns from a connected repository
- `title-summary` — titles and summarizes sessions
- `canopy-map` — maps the project's code

Its editorial work produces project intelligence. Its tools come from the run-scoped MCP surface in `packages/myco-server/src/mcp/run-surface.ts`. Each task declares its allowed tools in `packages/myco-server/src/core/task-catalogue.ts`; the MCP entry point enforces that set. Those credentials do not use the member tool surface.

### Symbiont

Coding agents like Claude Code, Cursor, opencode, Codex. Symbionts integrate with Myco via three channels:

1. **Hooks** — send capture through the member spool to the Deployment
2. **Deployment MCP** — read project intelligence and record spores and plans
3. **Installed skills** — workflows that instruct the symbiont on when to call the CLI, when to consult Myco, when to write spores, etc.

Symbionts **use Myco; they do not control it.** A symbiont:

- Reads project intelligence to inform its own work
- Saves observations (spores) that the Myco agent later distills
- Follows skill instructions, including "when you need X, run `myco <cmd>`"

A symbiont does **not**:

- Restart the Deployment
- Trigger Myco's own updates
- Drive backups, restores, or database maintenance
- Use a run's private tools or credentials

### User

The human. Uses Myco, controls Myco, reviews Myco-agent-generated data, and administers the Myco agent. Has three primary surfaces (UI is primary, CLI for bootstrap/power use, and an indirect surface via skills installed into their symbionts).

## The surface map

| Surface | Path | Audience | Allowed operations |
|---|---|---|---|
| **MCP tools** | `packages/myco-server/src/mcp/` | Symbionts | Read + editorial (spores, plans). No admin. |
| **Skills** | `packages/myco/skills/` (built-in) | Symbionts | Workflow guidance; may instruct symbiont to invoke CLI. |
| **CLI** | `packages/myco/src/cli/` | Users (primary), Symbionts (via skills only) | Full surface: read, write, admin, lifecycle. |
| **UI** | `packages/myco-server/ui/` | Users | Primary interface — everything users do day-to-day. |
| **Run tools** | `packages/myco-server/src/mcp/run-surface.ts` | Myco agent | Task-declared tools for bounded editorial work, attributed to the run. |
| **Deployment HTTP API** | `packages/myco-server/src/routes.ts` + `pipeline.ts` | Users and authenticated machines | Shared server operations behind the native and Cloudflare front doors. |

## Why the boundaries matter

When the boundaries blur, three failure modes appear:

1. **Symbionts get capabilities they shouldn't have.** Granting a symbiont an `admin_restart` tool means any drift in that symbiont's planning loop can interrupt the user's Deployment mid-work.
2. **The Myco agent's internal tool surface bloats with symbiont-facing concerns.** This makes the harness harder to reason about and slows tool dispatch in editorial work.
3. **Users lose a clear mental model.** "Why does the agent restart on its own?" "Why did Cursor try to apply an update?" Boundary violations confuse users about what each actor is for.

## The "agent-native parity" misread

A common third-party principle — *"any action a user can take, an agent can also take"* — is stated without scope. Applied literally to Myco, it produces the same mistake: every UI button gets an MCP tool, including admin surfaces that have no business on the MCP wire.

The correct scope: agent-native parity applies to **the agent's editorial domain**. Symbionts get parity with users for **reading project intelligence**, not for **controlling the runtime**. The Myco agent gets parity with users for **work users delegate to it** (learning from sessions, mapping code), not for **everything users can do** (restart the Deployment, change channels).

## When in doubt

Before adding a new MCP tool, ask:

1. Is the consumer a Symbiont or the Myco agent?
2. Is the operation read/editorial, or administrative?
3. If administrative — does a Skill already exist that instructs the Symbiont to run the corresponding CLI command? If yes, that's the right shape. If not, write the Skill, don't add the tool.

Before adding a run tool, identify the task that needs it, add it to that task's declared allowed tools and keep run-only tools off the member surface. When member and run tools perform the same editorial operation, share its underlying implementation.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the canonical project rules, including the short form of this doc
- [`docs/agent-tools.md`](../agent-tools.md) — the public MCP tool reference
- `tests/mcp/surface-discipline.test.ts` — structural test that MCP handlers don't import admin primitives
