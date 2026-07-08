---
type: Overview
title: "Myco: Overview"
description: What Myco is, how the Bun/TypeScript monorepo is laid out, and the three-actor model (Myco agent, symbiont, user) that governs every surface in the codebase.
timestamp: '2026-07-08T15:52:42.326Z'
---

Myco is the nervous system for AI-assisted software teams. It runs alongside the coding agents a developer already uses (Claude Code, Cursor, Codex, Cline, and others), captures what happens across coding sessions, turns that raw activity into durable project knowledge, and routes the right context back to agents and teammates. It is not another coding agent — it is the shared memory, signal layer, and coordination system underneath the agents already in use.

Memory in Myco is treated as living material rather than a static log. Individual observations (`spores`) can become obsolete as code changes, repeated observations consolidate into higher-order `wisdom`, and workflows that recur across sessions can be promoted into reviewed skills. The [Vault Intelligence](/subsystems/vault-intelligence.md) page covers that knowledge model in depth; this page is the map of the codebase that produces and serves it.

# Monorepo layout

Myco is a Bun/TypeScript monorepo under `packages/`. The package names (from each `package.json`) show the shape of the system:

- **`packages/myco`** (`@goondocks/myco`) — the core product. This is where the daemon, CLI, MCP tool surface, hooks, agent harness, and dashboard UI all live as subdirectories of one package (`src/entries/cli.ts` is the primary Node entry point; `src/cli/` holds CLI command implementations; `src/daemon/`, `src/agent/`, `src/tools/`, `src/hooks/`, `src/vault/`, `src/okf/`, and `src/config/` hold the daemon-side subsystems described on the architecture and subsystem pages linked below). `packages/myco/ui/` (`@goondocks/myco-ui`) is the local dashboard's frontend package, built separately from the daemon it talks to.
- **`packages/myco-darwin-arm64`, `myco-darwin-x64`, `myco-linux-arm64`, `myco-linux-x64`, `myco-windows-x64`** — per-platform native binary packages. Myco ships as a self-contained binary (no Node runtime required for end users); these packages carry the compiled artifact for each OS/arch combination that the installer and `npm install -g @goondocks/myco` bootstrap converge on.
- **`packages/myco-shared`** (`@goondocks/myco-shared`) — small internal helpers (process inspection, port discovery, browser launch, JSON parsing) shared across the other packages purely to satisfy the workspace dependency graph, not a product surface of its own.
- **`packages/myco-team`** (`@goondocks/myco-team`) — the operator CLI (`src/cli.ts`) plus a `worker/` subpackage (`@goondocks/myco-worker`) that is the Cloudflare Worker deployed by `myco-team create`. This is the optional Team Sync path: one operator provisions the Worker, teammates join from the dashboard with nothing extra installed.
- **`packages/myco-collective`** (`@goondocks/myco-collective`) — the optional cross-project admin layer: a `worker/` Cloudflare Worker (`worker/src/index.ts` initializes schema, auth, and token rotation) and a `ui/` package (`@goondocks/myco-collective-ui`) for the Collective's own admin UI, distinct from the per-project dashboard in `packages/myco/ui`.
- **`packages/myco-deploy`** (`@goondocks/myco-deploy`) — deployment utility package for release/publish tooling.

The [Team Sync](/subsystems/team-sync.md) page covers how `myco-team`'s worker and D1 schema turn a local Grove into a synced team knowledge base; the OKF Publishing page covers `packages/myco/src/okf/`, the module that generated the bundle you are reading now.

# The three-actor model

`AGENTS.md` names Myco's central architectural discipline: three actors interact with the system, each with a fixed surface, and mixing them is the source of architectural drift.

| Actor | What it is | Surface |
|---|---|---|
| **Myco agent** | Myco's own LLM-powered intelligence harness — skill-survey, full-intelligence, plan generation, OKF synthesis (the kind of run producing this page). Does work users don't do. | `packages/myco/src/agent/tools/` — an internal tool surface, **not** the MCP surface. |
| **Symbiont** | Coding agents (Claude Code, Cursor, opencode, Codex, …) that integrate with Myco via hooks + the MCP bridge + installed skills. Symbionts *use* Myco; they do not control it. | MCP tools (`packages/myco/src/tools/`) for read-only project intelligence, plus generated skills (`packages/myco/src/skills/`). |
| **User** | The human. Uses Myco, controls it, reviews agent-generated data, and administers the system. | CLI (`packages/myco/src/cli/`) for bootstrap/admin, and the UI (`packages/myco/ui/`) as the primary interface for ongoing work. |

The non-rules that follow from this table are enforced, not aspirational: symbionts do not drive admin operations (restart, update, restore, backup) — no MCP tool exists for those — and the Myco agent does not share a tool surface with symbionts. A decision spore from the v0.27.11 quality pass records this being tightened in practice: three MCP tools (`myco_maintenance`, `myco_update`, `myco_skill_candidates`) that had crossed the symbiont/admin boundary were removed and the surface was structurally enforced rather than left to convention. The full discussion lives in `docs/architecture/actors-and-boundaries.md`.

This separation is why the daemon, not agent hooks, holds authority for intelligence work — hooks stay thin and delegate. See [Runtime & Daemon Authority](/architecture/runtime-and-daemon.md) for how that authority is structured, and Session Capture Flow for how a symbiont's hook events become the prompt batches and activities that the Myco agent's own harness — described on Myco's Own Agent Harness — later turns into spores.

# How the pieces fit together

Reading top to bottom, one coding session's data moves through the system roughly like this:

1. A symbiont (say, Claude Code) fires hooks during a session; `packages/myco/src/hooks/` forwards those events to the daemon rather than processing them inline.
2. The daemon lands raw session data — prompt batches and activities — into a per-project Grove SQLite database.
3. Myco's own agent harness runs background intelligence tasks against that raw data: extracting spores, generating summaries, building Canopy's per-file code index (see [Canopy](/subsystems/canopy.md)), consolidating repeated observations into wisdom, and refreshing digest tiers (see [Vault Intelligence](/subsystems/vault-intelligence.md)).
4. That knowledge is routed back out: session-start briefings and per-prompt spore retrieval for symbionts, the dashboard UI for users, and — when Team Sync is configured — an outbox to the `myco-team` Cloudflare Worker so other machines and the Cloud MCP server can see it too.
5. Recurring procedural patterns can be promoted through the skill lifecycle (see [Skill Lifecycle](/subsystems/skill-lifecycle.md)) into `SKILL.md` files every connected symbiont can follow.

Each of those steps is documented in more depth on its own page; this overview exists so a new reader can place any single detail page in the whole before diving in.

# Citations

[1] `README.md` — product description, package/feature overview, install and upgrade flow
[2] `AGENTS.md` — core invariants, actors-and-boundaries table, capabilities table, Grove primitives
[3] `packages/myco/package.json`, `packages/myco/ui/package.json`, `packages/myco-darwin-arm64/package.json`, `packages/myco-darwin-x64/package.json`, `packages/myco-linux-arm64/package.json`, `packages/myco-linux-x64/package.json`, `packages/myco-windows-x64/package.json`, `packages/myco-shared/package.json`, `packages/myco-team/package.json`, `packages/myco-team/worker/package.json`, `packages/myco-collective/package.json`, `packages/myco-collective/worker/package.json`, `packages/myco-collective/ui/package.json`, `packages/myco-deploy/package.json` — monorepo package names and roles
[4] Canopy summaries: `packages/myco/src/entries/cli.ts`, `packages/myco/src/cli/shared.ts`, `packages/myco-shared/src/index.ts`, `packages/myco-team/src/cli.ts`, `packages/myco-collective/worker/src/index.ts`, `docs/architecture/actors-and-boundaries.md`
[5] Spore `id-hash-4d9654b19a80717d` — "MCP Tool Surface Actor Boundary: 3 Admin Tools Removed, Surface Structurally Enforced" (decision, session `cfde2eeb`)
