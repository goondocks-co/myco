# Myco — Collective Agent Intelligence

Myco captures project memory in a local vault and serves it back through context injection, MCP tools, and skills. This file is intentionally small: keep durable rules here, and let Myco carry dynamic project intelligence.

## Use Myco First

- `AGENTS.md` is for stable project rules, not changing project history.
- Use Myco context, spores, sessions, and plans for recent work, prior decisions, and dynamic guidance.
- When a rule depends on current initiative state or recent architecture change, prefer Myco over adding more static prose here.

## Dogfooding

- We develop Myco using Myco. The project-local vault lives at `.myco/`.
- Session data from development sessions is real vault data. Avoid destructive vault operations unless you mean it.
- After changing hook or daemon code, run `make build` and then `myco-dev restart`. Hooks pick up new code on the next invocation; the daemon does not.
- In git worktrees, prefer not to restart the daemon. Shared vault capture continuity is more valuable than forcing daemon restarts during isolated testing.
- If a worktree must restart for debugging, run the local CLI entry (`node packages/myco/dist/src/cli.js restart`) from that worktree; avoid global `myco-dev restart` from worktrees.
- Use `make dev-link` only from the main checkout; it rewrites shared `~/.local/bin/myco-*` symlinks.
- In git worktrees, use `make dev-link-worktree`; it writes a worktree-local `.myco/runtime.command` directly to that worktree's compiled binary without changing shared symlinks. Hook capture still routes through the main checkout runtime so data collection stays attached to the main vault.
- `make dev-unlink` removes shared dev symlinks and `.myco/runtime.command`; `make dev-unlink-worktree` removes only the worktree runtime pin.

## Non-Goals

- Myco is not a general-purpose note-taking app or external web service.
- Myco is not a framework. Do not add plugin systems or abstractions for hypothetical consumers.
- Do not add mandatory cloud-service dependencies for core local intelligence flows.

## Core Invariants

- `AGENTS.md` is the canonical rules file. Agent-specific instruction files should stay thin and point back here.
- Hooks in `src/hooks/` must stay thin and delegate to the daemon. Do not put business logic or long-running processing in hook entry points.
- The daemon is the authority for event processing, session recording, spores, and digest work.
- Recurring daemon work must go through the PowerManager. Do not add ad hoc polling timers.
- Session ID is the durable key. Do not tie persistent state to hook lifecycle events.
- Write paths must be additive and idempotent. Do not overwrite or delete accumulated vault history casually.
- Maintain one canonical source of truth per concern. Derived files, stubs, and mirrors should stay thin and point back to it.
- License is **Apache 2.0** (relicensed from MIT on 2026-04-29). New files must carry the Apache header; do not introduce GPL- or AGPL-licensed dependencies.

## Global Install Architecture

Myco installs once at the per-user/global level for every symbiont; project-local files are an opt-in override, not the default.

- All symbionts install at the agent's global config location (e.g. `~/.claude/settings.json`, `~/.codex/config.toml`). Per-project `.agents/` folders are no longer required.
- Two global launchers — `~/.myco/launcher.cjs` (hooks) and `~/.myco/mcp-launcher.cjs` (MCP) — bridge every agent to the daemon. Project-local launchers override per-project when present.
- Settings-merge for shared agent config files is required: Myco's hook/MCP/skills entries are upserted; user-pre-existing keys (e.g. Codex `[features].hooks`) must be preserved across install/uninstall cycles. Use audit-tracked TOML writes for Codex; atomic writes for every other agent.
- Per-project overrides live in the dashboard's **Symbionts** page, not in CLI flags or hand-edited config.
- Capture buffer lives under `~/.myco/buffer/<grove>/`. Do not reintroduce `.agents/myco-buffer/`; the migration walker archives any residue.

## Actors and Boundaries

Three actors interact with Myco. Mixing them is the source of architectural drift.

- **Myco agent** — Myco's own LLM-powered intelligence harness (skill-survey, full-intelligence, plan generation, etc.). Does work users don't do. Has its own internal tool surface under `packages/myco/src/agent/tools/` — **not** the same as the MCP surface.
- **Symbiont** — coding agents like Claude Code, Cursor, opencode, Codex that integrate with Myco via hooks + the MCP bridge + installed skills. Symbionts **use Myco; they do not control it**.
- **User** — the human. Uses Myco, controls Myco, reviews Myco-agent-generated data, and administers the Myco agent.

The surface each actor touches is fixed:

| Surface | Whose | For |
|---|---|---|
| **MCP tools** (`packages/myco/src/tools/`) | Symbionts | Read project intelligence. No administrative ops. |
| **Skills** (`packages/myco/src/skills/`, generated) | Symbionts | Workflows; may instruct the symbiont to invoke the CLI. |
| **CLI** (`packages/myco/src/cli/`) | Users (primary) and Symbionts (via skills) | Bootstrap + admin. |
| **UI** (`packages/myco/ui/`) | Users | Primary interface for ongoing work. |
| **Agent harness tools** (`packages/myco/src/agent/tools/`) | Myco agent | Internal; not exposed via MCP. |

**Non-rules** (these are violations to push back on):
- Symbionts do **not** drive admin ops (restart, update, restore, backup). Add no MCP tool that does.
- The Myco agent does **not** share a tool surface with Symbionts. If the harness needs a capability, add it under `agent/tools/`, not `tools/`.
- "Agent-native parity" is scoped to the agent's editorial work — not a license to mirror every UI button as an MCP tool.

Full discussion: [`docs/architecture/actors-and-boundaries.md`](docs/architecture/actors-and-boundaries.md).

## Grove Primitives

Myco's data layer is multi-tenant. A **Grove** is a per-machine collection of projects served by a single global daemon, each with its own SQLite database. The following invariants are non-negotiable for new daemon code:

- `GroveProjectId` is a branded string. Never derive a project_id from a filesystem path, the cwd, or string concatenation. Always thread through the branded ID supplied by the request context or migration plan.
- One global daemon serves many Groves, and each Grove owns its own SQLite DB. Do not assume the daemon is single-project. Code that opens a database must resolve the path through the request context, not from `vaultDir` alone.
- Reads must pass a `ProjectScope` (the discriminated union over Grove/project tenancy). API handlers, query helpers, and tools take `ProjectScope` so the right database, project_id, and machine_id are bound for the call.
- Config is a three-tier scoped system: **machine** (`~/.myco/config.yaml`), **grove** (`~/.myco/groves/<id>/config.yaml`), **project** (`<project>/.myco/myco.yaml`), and **personal** (`<project>/.myco/local.yaml`) overlays merge in that order. Use the `safe-config-updates` skill when adding a new configurable field — it covers scope assignment, Zod schema extension, and the `ScopedField` UI wiring.
- Project registration is automatic on first agent hook. The default Grove for the daemon's variant is ensured by `runGlobalBootstrap()` at first start; hooks fired from a git project then call `ensureProjectRegistered()` which auto-registers the project into the default Grove. New code paths must not silently materialize a project-local vault from cwd — registration goes through `isSafeProjectRoot()` (git-repo gate) and never invents a project from a bare cwd. Project-local override requires explicit opt-in (`myco init --project <path>`). The bare `myco init` form is gone.
- All `~/.myco/service/daemon.json` mutations go through `DaemonStateAuthority`. Do not call `writeOrTouchDaemonState` directly; the capability is the only sanctioned write path and logs reason, caller PID, and before/after PID for every change.
- Variant-aware rebind is strict. `MYCO_SERVICE_VARIANT=service-dev` daemons bind only to Groves with `served_by="service-dev"`; `MYCO_SERVICE_VARIANT=service` daemons bind only to `served_by="service"`. No fall-through; do not add a default-Grove escape hatch.
- Power state is per-project. Scheduled work iterates Grove scopes; do not collapse multiple projects into one power loop or assume a single PowerManager owns all projects.
- After changing daemon code, run `make build` and then `myco-dev restart`. Restart is per-machine (one daemon serves all Groves), not per-project.

## Working Style

- Think before coding. Surface assumptions and ambiguities instead of guessing.
- Prefer the smallest correct change.
- Make surgical edits. Do not refactor adjacent code without a concrete need.
- Match the existing style of the code you touch.
- Prefer extending existing patterns over one-off patches.
- Keep code DRY. Extract helpers or shared patterns when they remove real duplication.
- Preserve clear domain ownership. Do not blur module boundaries without a reason.
- Avoid magic literals for meaningful values. Use named constants or an existing shared pattern.
- Keep comments lean. Add comments only when they clarify non-obvious code; DO NOT use comments to preserve task history, decisions, PR context, or conversational state.
- Prefer explicit configuration and user choice over heuristic detection when both are viable.
- When in doubt, ask whether the rule belongs here or should live in Myco context instead.

## Quality Gates

- For local test loops, target the smallest relevant scope first: `npm test -- <test-file-or-dir>` or `npm run test:debug -- <test-file-or-dir>`. Do not repeatedly pipe the full `npm test` suite through `grep` just to find one failure.
- Before finishing a feature, run `make build`.
- Before finishing a feature, smoke-test the changed behavior.
- When changing an installed, generated, or user-facing surface, verify it through the real command or runtime path, not only through unit tests.
- Before committing, run `make check`.
- Use `make build` when you need the distributable build or when dogfooding hook or daemon changes.
- For code changes, add or update tests when behavior changes.

## Update Safety

- Migrations and updates should preserve user state when possible. Prefer additive or idempotent reconciliation over destructive rewrites.

## Project Conventions

- Use `@myco/*` path aliases for imports from `src/*`.
- Mirror source tests at `tests/<module>.test.ts`.


<!-- myco:managed:start -->
## Myco Managed Guidance

- When `capture.ignore_plan_dirs_in_git` is enabled, custom directories in `capture.plan_dirs` may be intentionally gitignored after capture into Myco.
- Do not force-add files from intentionally gitignored custom plan directories unless the user explicitly asks.
- When orienting in this codebase — finding a feature, locating files relevant to a change, or understanding an unfamiliar subsystem — use Myco first: call `node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'` as the project-resolved CLI path, or `myco_cortex({"op":"canopy_map"})` via MCP when the host exposes Myco tools cleanly, before falling back to Glob/Grep.
<!-- myco:managed:end -->
