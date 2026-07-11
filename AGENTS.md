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
- In git worktrees, use `make dev-link-worktree`; it builds the worktree binary and writes a worktree-local `.myco/runtime.command` pointing at it, without changing shared symlinks. Hooks, MCP, and CLI then route to the worktree build; capture still attaches to the main project vault via `git-common-dir`. See the `dogfood-worktree` skill for caveats (shared-vault schema hazard, vendor-asset build gotcha).
- `make dev-unlink` removes shared dev symlinks and `.myco/runtime.command`; `make dev-unlink-worktree` removes only the worktree runtime pin.

## Core Invariants

- `AGENTS.md` is the canonical rules file. Agent-specific instruction files should stay thin and point back here.
- Hooks in `src/hooks/` must stay thin and delegate to the daemon. Do not put business logic or long-running processing in hook entry points.
- The daemon is the authority for event processing, session recording, spores, and digest work.
- Recurring daemon work must go through the PowerManager. Do not add ad hoc polling timers.
- Session ID is the durable key. Do not tie persistent state to hook lifecycle events.
- Write paths must be additive and idempotent. Do not overwrite or delete accumulated vault history casually.
- Maintain one canonical source of truth per concern. Derived files, stubs, and mirrors should stay thin and point back to it.
- License is **Apache 2.0** (relicensed from MIT on 2026-04-29). New files must carry the Apache header; do not introduce GPL- or AGPL-licensed dependencies.

## Non-Negotiable Rules

- Think before coding. Surface assumptions and ambiguities instead of guessing.
- Verify before asserting state. Before claiming which project/grove/daemon/database something belongs to — or that two of them share state — run the command that proves it and report only what the output shows. A URL slug, an injected memory, or a helper run in isolation is a hypothesis, not proof; label it as such until checked.
- Never build a claim on an unverified claim. If a step was a guess, verify it before it becomes the premise for the next conclusion.
- Prefer extending existing patterns over one-off patches.
- Plans are guideposts, not scripts: reconcile a plan's code against the current code before writing, and when a step would duplicate an existing surface or fight an existing pattern, follow the plan's intent and the existing pattern — surface the deviation, do not transcribe literally into a violation. Reviewers MUST check pattern-fit and duplication, not just fidelity to the plan.
- Prefer established architectural patterns like Vertical Slice Architecture, CLEAN architecture, CQRS, Dependency Injection, etc. when they are appropriate.
- Keep code DRY. Extract helpers or shared patterns when they remove real duplication.
- Write idiomatic TypeScript. Reach for the language's own constructs — higher-order functions, generics, discriminated unions, type guards, `as const` — instead of hand-rolled imperative equivalents. A cross-cutting concern that recurs across call sites (a guard, gate, claim/ownership check, audit, retry) MUST be expressed ONCE as a reusable abstraction applied at the definition — a higher-order wrapper or a single chokepoint every caller funnels through — never as a check copied into each caller. A check duplicated across entry points is a bypass waiting to be added: the next entry point that forgets it silently defeats the rule.
- One implementation per operation across surfaces. UI, MCP/symbiont tools, and CLI MUST share the same underlying code path for the same operation; a user and a symbiont doing the same thing MUST get the same result. Divergent implementations for one operation are a bug.
- Never swallow errors. Do not turn a failure into an empty or default result (e.g. `return []` when a call fails); propagate or surface it. Silent failure hides real problems — cross-tenant rejections, auth failures, lost connectivity — behind "no data".
- Preserve clear domain ownership. Do not blur module boundaries without a reason. Callout and fix when you see this happening.
- Avoid magic literals for meaningful values. Use named constants or an existing shared pattern.
- Comments are behavioral labels, not narrative. A comment states what the code does now, or a constraint the code cannot show on its own (an external-system quirk, a non-obvious invariant, an ordering requirement). It MUST NOT carry history ("was X", "previously broke", "self-heals"), decision-rationale ("pattern, not a special case", "pulled out so it's testable"), counterfactuals ("without this, X breaks" — state the requirement instead: "X requires this"), or cross-references to PRs, plans, tasks, reviews, findings, spores, or dates. The *why* lives in the commit message. Test: a comment that only makes sense to someone who saw this change is a defect; a comment that reads correctly to someone who never saw it is a behavioral label. Reviewers MUST reject any comment that narrates history, decision, or process.
- Prefer explicit configuration and user choice over heuristic detection when both are viable.
- Prototype generated content before building its plumbing. For any feature whose deliverable is generated content (a wiki, docs, reports, summaries, prompts), milestone 1 MUST be a cheap disposable prototype of the content itself — real sample output judged by a human. No format library, harness task, UI, or plan work for the feature until the content passes that judgment.
- When in doubt, ask whether the rule belongs here or should live in Myco context instead.
- Test critical paths, not edge cases, tests to prevent regressions, not to verify correctness.

## Quality Gates

- For local test loops, target the smallest relevant scope first: `npm test -- <test-file-or-dir>` or `npm run test:debug -- <test-file-or-dir>`. Do not repeatedly pipe the full `npm test` suite through `grep` just to find one failure.
- Before finishing a feature, run `make build` (it runs the checks too — no need to run `make check` separately).
- Before finishing a feature, smoke-test the changed behavior.
- When changing an installed, generated, or user-facing surface, verify it through the real command or runtime path, not only through unit tests.
- Use `make build-only` when you need the distributable build or when dogfooding hook or daemon changes.
- For code changes, add or update tests when behavior changes.

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
- Project registration is automatic on first agent hook. The default Grove for the daemon's variant is ensured by `runGlobalBootstrap()` at first start; hooks fired from a git project then call `ensureProjectRegistered()` which auto-registers the project into the default Grove. New code paths must not silently materialize a project-local vault from cwd — registration goes through `isSafeProjectRoot()` (git-repo gate) and never invents a project from a bare cwd. Project-local commit (writing `<projectRoot>/.myco/project.toml` for portable Grove identity, plus optional launcher/binary overrides) is UI-driven through the dashboard's Symbionts page. The `myco init` CLI command — both bare and `--project` forms — is removed; the CLI is install/diagnostic/uninstall only.
- Shared state goes through capabilities — see [Capabilities](#capabilities-single-writers-for-shared-state) below. `daemon.json`, `<projectRoot>/.myco/`, `myco.yaml`, and symbiont agent config each have exactly one sanctioned writer; bypassing produces silent drift.
- Home-ownership is strict. A daemon running under `MYCO_HOME` owns exactly the Groves under `<MYCO_HOME>/groves/`. There is no `served_by` field and no `MYCO_SERVICE_VARIANT`; cross-home access is refused as `foreign_grove` at every seam (request context, tool-call pivot, assertOwnedGrove). No fall-through; do not add a default-Grove escape hatch that bypasses the home-scoped ownership check.
- Power state is per-project. Scheduled work iterates Grove scopes; do not collapse multiple projects into one power loop or assume a single PowerManager owns all projects.
- After changing daemon code, run `make build` and then `myco-dev restart`. Restart is per-machine (one daemon serves all Groves), not per-project.

## Capabilities (single writers for shared state)

Every shared resource below has exactly one sanctioned writer. Adding a second entry point that bypasses the capability is Myco's dominant historical bug class — silent drift between writers produced repeated bugs in gitignore coverage, missing companion files, and schema bypass. When the resource you're writing appears here, route through its capability. MUST NOT call the lower-level primitives directly from new code.

| Resource | Capability |
|---|---|
| `~/.myco/service/daemon.json` | `DaemonStateAuthority` (`packages/myco/src/daemon/daemon-state-authority.ts`) — logs reason, caller PID, before/after PID for every change. |
| `<projectRoot>/.myco/` + `<projectRoot>/.agents/myco-*.cjs` | `ProjectVault` (`packages/myco/src/vault/project-vault.ts`) — pairs every manifest write with `project.local.toml` + `.gitignore`; refuses cross-identity overwrites; sweeps retired launchers on remove. |
| `myco.yaml` (every tier) | `updateConfig()` / `saveConfig()` (`packages/myco/src/config/loader.ts`) — runs Zod validation; see also the `safe-config-updates` skill. |
| Symbiont agent config (`.claude/`, `.codex/`, etc.) | `SymbiontInstaller` (`packages/myco/src/symbionts/installer.ts`) — manages hooks, MCP entries, and per-agent skill symlinks. |

**Meta-rule (single writers).** When new shared state emerges — a file written by more than one caller, an invariant maintained by convention across helpers, a multi-file coordination contract — add a capability that owns it BEFORE adding the second writer. Discipline-by-convention is a bug class, not an architecture. Every row in the table above started as duplication-by-discipline that produced regressions until the capability was added.

**Meta-rule (structural invariants).** A capability is not done when it compiles; it is done when there is no callable sequence that can violate its invariants. Invariants encoded as *procedure* (call A, then B, then C in this order) are fragile — an exception in B can skip C, an empty input can skip the loop, a future maintainer can reorder the body. Encode invariants *structurally*:
- Wrap per-state-class writes in a helper that runs the invariant guard FIRST (e.g. `_writePerMachineFile(fn)` calls `_ensureGitignore()` before invoking `fn`).
- Compute responses from a FRESH read of the resource, not by piggy-backing the response on the last write's return value (an empty batch must still return the live state).
- When refactoring a function that had defensive try/catch or validation, audit each removed line for the question *"what input or filesystem state was this defending against?"* — the answer is almost always load-bearing, not cleanup.
- Pin externally observable behavior with contract-diff regression tests: every (input → status, error code, response shape) tuple the old code honored must survive the refactor. Happy-path tests catch zero of these regressions

## Update Safety

- Migrations and updates should preserve user state when possible. Prefer additive or idempotent reconciliation over destructive rewrites.

## Project Conventions

- Use `@myco/*` path aliases for imports from `src/*`.
- Mirror source tests at `tests/<module>.test.ts`.
- `db/migrations.ts` contains an intentional NUL byte (a collision-safe map-key delimiter); binary-skipping search tools (`grep -I` default, ripgrep default) silently miss matches there — pass `-a`/`--text`, or use the Read tool.

<!-- myco:managed:start -->
## Myco Managed Guidance

- When `capture.ignore_plan_dirs_in_git` is enabled, custom directories in `capture.plan_dirs` may be intentionally gitignored after capture into Myco.
- Do not force-add files from intentionally gitignored custom plan directories unless the user explicitly asks.
- When orienting in this codebase — finding a feature, locating files relevant to a change, or understanding an unfamiliar subsystem — use Myco first: call `myco tool call myco_cortex --json --input '{"op":"canopy_map"}'` as the CLI path, or `myco_cortex({"op":"canopy_map"})` via MCP when the host exposes Myco tools cleanly, before falling back to Glob/Grep.
<!-- myco:managed:end -->
