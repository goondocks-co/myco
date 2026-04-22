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
- `make dev-link` creates `myco-dev` and `myco-run` symlinks and writes `.myco/runtime.command`.
- `make dev-unlink` removes those symlinks and `.myco/runtime.command`.

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
<!-- myco:managed:end -->
