# Actors and Boundaries

> **TL;DR.** Myco has three actors — the Myco agent (internal harness), Symbionts (coding agents like Claude Code), and Users (humans). Each touches a specific surface. Mixing them is the source of architectural drift. The short form lives in [`AGENTS.md`](../../AGENTS.md#actors-and-boundaries); this is the long-form reference.

## The three actors

### Myco agent

Myco's own LLM-powered intelligence harness. Runs tasks the user does not run directly:

- `skill-survey` — scans sessions, identifies candidate skills
- `full-intelligence` — generates plans, distills patterns
- `canopy-describe` — produces per-file summaries for code intelligence

The Myco agent **does work users don't do** — that's its whole reason for existing. It's getting more powerful over time. It can do many things a user can do, but its primary domain is editorial work on the project's intelligence graph (spores, plans, sessions, skills, canopy entries).

Its tool surface lives at `packages/myco/src/agent/tools/`. **This is not the MCP surface.** It is internal to the harness and exists to give the agent the affordances it needs to do its work.

### Symbiont

Coding agents like Claude Code, Cursor, opencode, Codex. Symbionts integrate with Myco via three channels:

1. **Hooks** — capture session events (prompts, tool calls, responses) into the vault
2. **MCP bridge** — read project intelligence via the tools surface
3. **Installed skills** — workflows that instruct the symbiont on when to call the CLI, when to consult Myco, when to write spores, etc.

Symbionts **use Myco; they do not control it.** A symbiont:

- Reads project intelligence to inform its own work
- Saves observations (spores) that the Myco agent later distills
- Follows skill instructions, including "when you need X, run `myco <cmd>`"

A symbiont does **not**:

- Restart the daemon
- Trigger Myco's own updates
- Drive backups, restores, or database maintenance
- Manage skill candidate state (that's the Myco agent's domain via the skill-survey pipeline)

### User

The human. Uses Myco, controls Myco, reviews Myco-agent-generated data, and administers the Myco agent. Has three primary surfaces (UI is primary, CLI for bootstrap/power use, and an indirect surface via skills installed into their symbionts).

## The surface map

| Surface | Path | Audience | Allowed operations |
|---|---|---|---|
| **MCP tools** | `packages/myco/src/tools/` | Symbionts | Read + editorial (spores, plans). No admin. |
| **Skills** | `packages/myco/skills/` (built-in) + vault-generated | Symbionts | Workflow guidance; may instruct symbiont to invoke CLI. |
| **CLI** | `packages/myco/src/cli/` | Users (primary), Symbionts (via skills only) | Full surface: read, write, admin, lifecycle. |
| **UI** | `packages/myco/ui/` | Users | Primary interface — everything users do day-to-day. |
| **Agent harness tools** | `packages/myco/src/agent/tools/` | Myco agent | Internal harness affordances for editorial work. |
| **Daemon HTTP API** | `packages/myco/src/daemon/api/` | All of the above, indirectly | Source of truth for the runtime; each higher surface is a façade over a subset. |

## Why the boundaries matter

When the boundaries blur, three failure modes appear:

1. **Symbionts get capabilities they shouldn't have.** Granting a symbiont an `admin_restart` tool means any drift in that symbiont's planning loop can cycle the user's daemon mid-work. This is the bug Bucket F created and Bucket K reversed.
2. **The Myco agent's internal tool surface bloats with symbiont-facing concerns.** This makes the harness harder to reason about and slows tool dispatch in editorial work.
3. **Users lose a clear mental model.** "Why does the agent restart on its own?" "Why did Cursor try to apply an update?" Boundary violations confuse users about what each actor is for.

## The "agent-native parity" misread

A common third-party principle — *"any action a user can take, an agent can also take"* — is stated without scope. Applied literally to Myco, it produces the same mistake: every UI button gets an MCP tool, including admin surfaces that have no business on the MCP wire.

The correct scope: agent-native parity applies to **the agent's editorial domain**. Symbionts get parity with users for **reading project intelligence**, not for **controlling the runtime**. The Myco agent gets parity with users for **work users delegate to it** (skill survey, plan generation), not for **everything users can do** (restart the daemon, change channels).

## When in doubt

Before adding a new MCP tool, ask:

1. Is the consumer a Symbiont or the Myco agent?
2. Is the operation read/editorial, or administrative?
3. If administrative — does a Skill already exist that instructs the Symbiont to run the corresponding CLI command? If yes, that's the right shape. If not, write the Skill, don't add the tool.

Before adding a new agent harness tool, ask:

1. Is this an affordance Myco's intelligence work genuinely needs?
2. Would exposing this to Symbionts be safe? If yes, consider whether the same code can live in `tools/` instead of `agent/tools/`. If no, keep it private to the harness.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the canonical project rules, including the short form of this doc
- [`docs/agent-tools.md`](../agent-tools.md) — the public MCP tool reference
- `tests/mcp/tool-definitions.test.ts` — anti-drift checks that lock the MCP surface
- `tests/mcp/surface-discipline.test.ts` — structural test that MCP handlers don't import admin primitives
