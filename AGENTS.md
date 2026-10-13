# Myco — Collective Agent Intelligence

Myco captures project memory and serves it back through context injection, MCP tools, and skills. This file is intentionally small: keep durable rules here, and let Myco carry dynamic project intelligence.

## Use Myco First

- `AGENTS.md` is for stable project rules, not changing project history.
- Use Myco context, spores, sessions, and plans for recent work, prior decisions, and dynamic guidance.
- When a rule depends on current initiative state or recent architecture change, prefer Myco over adding more static prose here.
- Before interpreting runtime ownership, read the [canonical architecture and feature ledger](docs/architecture/myco-2.0.md). The Deployment owns storage, MCP, event processing and the dashboard; the member owns capture and delivery. Verify the active entry point and its routing before labeling a module as the implementation of a surface. Existing managed skills and module documentation may describe the local runtime.

## Dogfooding

- We develop Myco using Myco. The member sends project capture to its Deployment.
- Development sessions are real Project history. Preserve capture spools and Deployment data.
- After changing hooks or member code, run `make build` and smoke-test the compiled binary with an isolated home. From the main checkout, `make dev-deploy` refreshes the shared dogfood binary; its hooks load that binary on their next invocation. In a worktree, use the isolated runtime pin described below.
- A native Deployment or registered runner keeps its running executable until its own process is restarted. Restart only the isolated process under test; preserve shared capture continuity.
- Use `make dev-link` only from the main checkout; it rewrites shared `~/.local/bin/myco-*` symlinks.
- In git worktrees, use `make dev-link-worktree`; it builds the worktree binary and writes a worktree-local `.myco/runtime.command` pointing at it, without changing shared symlinks. Hooks and CLI route to the worktree build; MCP is served by the Deployment; member routing still resolves the project root via `git-common-dir`. See the `dogfood-worktree` skill for caveats (explicit member home, vendor-asset build requirements).
- `make dev-unlink` removes shared dev symlinks and `.myco/runtime.command`; `make dev-unlink-worktree` removes only the worktree runtime pin.
- `make worktree-sweep` retires worktrees and branches whose PR has merged. Run it whenever; it holds anything it cannot prove is finished. To preserve a worktree whose PR merged but whose build output is still evidence, put a `.worktree-keep` file in it.

## Core Invariants

- `AGENTS.md` is the canonical rules file. Agent-specific instruction files should stay thin and point back here.
- Hooks in `src/hooks/` must stay thin and delegate to the member seam (`src/member/`): build the envelope, append it to the spool, drain under the hook's own budget. Do not put business logic or long-running processing in hook entry points. The hooks+member import closure is gated (`tests/meta/member-seam-boundary.test.ts`): no daemon, grove, vault, db, host, or installer code behind a hook.
- The Deployment is the authority for event processing, sessions, spores and agent work. Agent work runs only on registered runners.
- Recurring Deployment work goes through the server wake tick, and every job and scheduled task it runs is declared in one registry (`packages/myco-server/src/core/jobs.ts`); the member binary registers no timers. Do not add ad hoc polling timers on either side. A dispatch limit queues the run; a per-day ceiling refuses it and the next wake decides again.
- Session ID is the durable key. Do not tie persistent state to hook lifecycle events.
- Write paths must be additive and idempotent. Do not overwrite or delete accumulated vault history casually.
- Maintain one canonical source of truth per concern. Derived files, stubs, and mirrors should stay thin and point back to it.
- License is **Apache 2.0** (relicensed from MIT on 2026-04-29), applied repo-wide via `LICENSE` + `NOTICE` (© Goondocks Consulting LLC). Per-file headers are optional and not enforced. Do not introduce GPL- or AGPL-licensed dependencies.

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
- Use `make build-only` when you need the distributable build or when dogfooding member or server changes.
- For code changes, add or update tests when behavior changes.

## Global Install Architecture

Myco installs once at the per-user/global level for every symbiont. The member installer leaves project-local configuration alone.

- All symbionts install at the agent's global config location (e.g. `~/.claude/settings.json`, `~/.codex/config.toml`). Per-project `.agents/` folders are no longer required.
- Hooks invoke the `myco` binary directly by absolute path, written by the installer; `launcher.cjs` and `myco-run.cjs` are gone. A harness the Deployment parses wires only the retained set — session start, turn end (`Stop`/`SessionEnd`), prompt submit for injection, subagent start — and writes no turn row; see `docs/architecture/myco-2.0.md` §3.4. MCP is remote HTTP served by the Deployment; there is no local launcher or bridge process.
- Settings-merge for shared agent config files is required: Myco's hook/MCP/skills entries are upserted; user-pre-existing keys (e.g. Codex `[features].hooks`) must be preserved across install/uninstall cycles. Use audit-tracked TOML writes for Codex; atomic writes for every other agent.
- Provisioning manages global agent configuration. Existing project overrides are reported read-only and remain the user's responsibility.
- Capture spools live under `<MYCO_HOME>/member/spool/d-<deployment-key>/<project-id>/` and belong to `MemberSpool`.

## Actors and Boundaries

Three actors interact with Myco. Mixing them is the source of architectural drift.

- **Myco agent** — Myco's own intelligence runs, driven on a worker: four outcomes (`extract-curate`, `vault-seed`, `title-summary`, `canopy-map`), each one prompt the Deployment builds with declared close evidence (`packages/myco-server/src/core/task-catalogue.ts`, `run-postconditions.ts`). Does work users don't do. Its tools come from the run-scoped MCP surface: a run-scoped credential whose allowlist is the task's declared tools, enforced at the MCP chokepoint — **not** the member's tool set.
- **Symbiont** — coding agents like Claude Code, Cursor, opencode, Codex that integrate with Myco via hooks + Deployment MCP + installed skills. Symbionts **use Myco; they do not control it**.
- **User** — the human. Uses Myco, controls Myco, reviews Myco-agent-generated data, and administers the Myco agent.

The surface each actor touches is fixed:

| Surface | Whose | For |
|---|---|---|
| **MCP tools** (`packages/myco-server/src/mcp/` declares and serves) | Symbionts | Read project intelligence and record spores and plans. No administrative ops. |
| **Skills** (`packages/myco/skills/` built-in + vault-generated) | Symbionts | Workflows; may instruct the symbiont to invoke the CLI. |
| **CLI** (`packages/myco/src/cli/`) | Users (primary) and Symbionts (via skills) | Bootstrap + admin. |
| **UI** (`packages/myco-server/ui/`) | Users | Primary interface for ongoing work. |
| **Run tools** (`packages/myco-server/src/mcp/run-surface.ts`) | Myco agent | A run's allowlist from `TASK_TOOLS` in the task catalogue; writes attributed to the run. Two sets: the catalogued tools where a run's work is a member's work, and run-only tools (`mcp/run-definitions.ts`) for the run's own bounded reads, state and cursor — never in `SERVED_TOOLS`, never on the member side. A run's prompt and its instructions file are the Deployment's (`core/task-inputs.ts`); the retired local executor is absent from the binary; `tests/meta/no-1-4-reach.test.ts` pins that boundary. |

**Non-rules** (these are violations to push back on):
- Symbionts do **not** drive admin ops (restart, update, restore, backup). Add no MCP tool that does.
- The Myco agent does **not** share a tool surface with Symbionts. If a run needs a capability, add it to the run-scoped MCP surface and to the task definition's allowlist, not to the member tool set.
- "Agent-native parity" is scoped to the agent's editorial work — not a license to mirror every UI button as an MCP tool.
- Seeding writes spores to Myco, never project rules to `AGENTS.md`. User-requested rule authoring and maintenance go through the `myco-rules` skill.

Full discussion: [`docs/architecture/actors-and-boundaries.md`](docs/architecture/actors-and-boundaries.md).

## Deployment and Member State

- The Deployment is multi-tenant. Bind every read and write to the authenticated Project scope; derive no persistent Project identity from cwd or a filesystem path.
- Native and Cloudflare front doors share the same server core. Native storage is SQLite and local blobs; Cloudflare storage is D1, R2 and Vectorize.
- The member home holds memberships, routing, capture spools and machine settings. The member binary opens no local vault and runs no daemon or recurring job.
- Deployment settings use the admitted settings writer in `packages/myco-server/src/core/settings.ts`; machine settings use `packages/myco/src/member/machine-settings.ts`. Use the `myco-settings` skill for settings work.
- Capture goes through the member seam into an immutable Project destination, then the Deployment processes it. Agent work is dispatched only to registered runners.
- Cutover and `import --legacy` retain read-only legacy vault readers and the frozen v76 schema fixture. They preserve source history and refuse ambiguous destinations.
- A 2.0 install manages what 2.0 owns and leaves unmanaged repository files and settings for their owner to review.

## Capabilities (single writers for shared state)

Every shared resource below has exactly one sanctioned writer. Adding a second entry point that bypasses the capability is Myco's dominant historical bug class — silent drift between writers produced repeated bugs in gitignore coverage, missing companion files, and schema bypass. When the resource you're writing appears here, route through its capability. MUST NOT call the lower-level primitives directly from new code.

| Resource | Capability |
|---|---|
| Hosted operator record and deployment staging | `withCloudflareOperation` (`packages/myco/src/server/cloudflare-operation.ts`) — holds one lease across provisioning, restore, deploy and nested record/staging writes. |
| Deployment settings | `packages/myco-server/src/core/settings.ts` — admits each leaf, authorizes, validates, persists with its actor and re-arms affected schedules. |
| Machine settings | `packages/myco/src/member/machine-settings.ts` — owns validated member settings persistence. |
| Symbiont agent config (`.claude/`, `.codex/`, etc.) | `SymbiontInstaller` (`packages/myco/src/symbionts/installer.ts`) — manages hooks, MCP entries and audited harness settings; `symbionts/member-skill-links.ts` owns global member skill links. |
| Worker attempt directories and harness process ownership | `runner/run-directory.ts` — allocates a private attempt manifest before credentials, records process launches, and disposes or recovers only directories with no live owner. |
| Runner update journal, binary handoff and guardian service | `runner/update.ts` + `runner/update-helper.ts` — serialize checks and replacement, admit verified releases only between runs, and retain rollback ownership until authenticated health. |
| Native Deployment volume, configuration and credentials | `LocalVolume` (`packages/myco/src/server/local-volume.ts`) — holds an exclusive lease for lifecycle mutations and the entire serving lifetime; native recovery publishes only into a fresh directory. |
| Member capture loss counts (`<MYCO_HOME>/member/spool/d-<deployment-key>/<project-id>/capture-losses.json`) | `CaptureLossLedger` (`packages/myco/src/member/capture-loss.ts`) — serializes bounded loss accounting; session receipts queue dispositions through `recordSessionLoss()`. |
| `<MYCO_HOME>/member/spool/d-<deployment-key>/<project-id>/` | `MemberSpool` (`packages/myco/src/member/spool.ts`) — validates the immutable destination before capture and delivery; legacy adoption goes through `member/spool-migration.ts`. |
| Member plugin transcript destination and Project adoption metadata | `member/transcript-routing.ts` — `memberTranscriptRoutingKey()` names transcript and claim namespaces; `adoptPendingTranscript()` assigns pending bytes to one Project. |

**Meta-rule (single writers).** When new shared state emerges — a file written by more than one caller, an invariant maintained by convention across helpers, a multi-file coordination contract — add a capability that owns it BEFORE adding the second writer. Discipline-by-convention is a bug class, not an architecture. Every row in the table above started as duplication-by-discipline that produced regressions until the capability was added.

**Meta-rule (structural invariants).** A capability is not done when it compiles; it is done when there is no callable sequence that can violate its invariants. Invariants encoded as *procedure* (call A, then B, then C in this order) are fragile — an exception in B can skip C, an empty input can skip the loop, a future maintainer can reorder the body. Encode invariants *structurally*:
- Wrap per-state-class writes in a helper that runs the invariant guard FIRST (e.g. `_writePerMachineFile(fn)` calls `_ensureGitignore()` before invoking `fn`).
- Compute responses from a FRESH read of the resource, not by piggy-backing the response on the last write's return value (an empty batch must still return the live state).
- When refactoring a function that had defensive try/catch or validation, audit each removed line for the question *"what input or filesystem state was this defending against?"* — the answer is almost always load-bearing, not cleanup.
- Pin externally observable behavior with contract-diff regression tests: every (input → status, error code, response shape) tuple the old code honored must survive the refactor. Happy-path tests catch zero of these regressions

## Update Safety

- Migrations and updates should preserve user state when possible. Prefer additive or idempotent reconciliation over destructive rewrites.

## Project Conventions

- **External agents** (Copilot code review, other non-members holding an access key): read with `myco_search`, and record what you found with `myco_spores` `op: "save"` citing the pull request you reviewed as `provenance_kind: "pr"` — see [docs/external-agents.md](docs/external-agents.md).
- Use `@myco/*` path aliases for imports from `src/*`.
- Mirror source tests at `tests/<module>.test.ts`.

<!-- myco:managed:start -->
## Myco Managed Guidance

- Myco tools take a `project` argument; pass this repo's git remote (or the project id from session-start context) — writes without it are refused.
<!-- myco:managed:end -->
