---
name: myco
description: Use when making design decisions, debugging non-obvious issues, encountering gotchas, wondering why code is structured a certain way, or when you need context about prior work on the same feature or component. Myco captures the reasoning, trade-offs, and lessons behind the codebase — things the code itself doesn't show. Also use when the user mentions vault, spores, sessions, team knowledge, institutional memory, or prior decisions.
---

# Myco — Collective Agent Intelligence

The codebase shows you **what** exists. Myco shows you **why** it exists — why this approach was chosen over alternatives, what broke along the way, what's non-obvious. When you're wondering *why* something is the way it is, or *whether* something was already tried, Myco has the answers.

## When to Use Myco

Use Myco tools proactively in these situations — don't wait to be asked:

- **Before making a design decision** — search for prior reasoning on the same component. Someone may have already evaluated the approach you're considering, or documented why an alternative was rejected.
- **When debugging a non-obvious issue** — search for the error message, component name, or symptom. A prior session may have hit the same problem and documented the root cause.
- **When wondering why code is structured a certain way** — decisions and trade-offs behind the architecture are captured as spores.
- **When continuing work on a feature** — check session history and plan progress for context on what's been done and what's pending.
- **After discovering a gotcha, making a key decision, or fixing a tricky bug** — save it so future sessions benefit from the knowledge.
- **When starting work on a branch** — context is injected automatically at session start, but you can call `myco_search` and then follow each result's `retrieve` hint for deeper context.

## What's Automatic

Myco works in the background without explicit tool calls:

- **Session start**: relevant context is injected based on your git branch and active plans
- **During the session**: tool calls, prompts, and responses are buffered as events
- **Session stop**: the daemon extracts spores, writes session records, detects parent sessions, and captures artifacts
- **Lineage**: parent-child session relationships are detected automatically (clear context, same branch, semantic similarity)

Use the CLI tool surface below for going deeper than the automatic context injection provides. MCP exposes the same tools when the host supports Myco cleanly; if MCP is missing, flaky, or unavailable, prefer the CLI JSON path before reaching for direct database access.

## Setup

If the vault isn't configured, run `myco init` in the project directory for guided first-time setup.

For reconfiguration, status checks, and ongoing management, use the CLI commands and tool surfaces documented below. For detailed vault health checks, see `references/vault-status.md`.

## CLI Tool Reference

The stable portable path is the project-resolved CLI launcher. In an initialized project, prefer `node .agents/myco-cli.cjs` because it reads `.myco/runtime.command` in project scope and therefore works with dogfood aliases, worktree-local runtimes, and renamed binaries. The sibling `.agents/myco-run.cjs` launcher is reserved for capture hooks and may intentionally route git worktrees through the main checkout runtime so session data lands in the main vault. If the CLI launcher is not present, use host MCP tools when available, then fall back to `myco-run` or `myco` only when the command is known to be on PATH for this project.

Project-resolved CLI:

```bash
node .agents/myco-cli.cjs tool list --json
node .agents/myco-cli.cjs tool call <tool-name> --json --input '<json>'
node .agents/myco-cli.cjs tool call <tool-name> --json --input @payload.json
```

Successful calls return `{ "ok": true, "tool": "<name>", "result": ... }`; failures return `{ "ok": false, "tool": "<name>", "error": { "code": "...", "message": "..." } }`.

The local Myco tool surface registers 7 core tools. When the project is connected to a Myco Collective, 4 additional `collective_*` tools are also available. Tools are defined in `packages/myco/src/tools/definitions.ts` — that file is the source of truth. MCP registers the same names when available.

Use direct SQLite reads only as an expert, read-only fallback for complex analysis that cannot be answered through the project-resolved CLI or MCP.

## Myco Development Worktrees

When developing Myco itself inside a git worktree, do not run `make dev-link`. That target rewrites shared `~/.local/bin/myco-*` symlinks and can redirect other active agents to the worktree binary.

Use the worktree-scoped pattern instead:

```bash
make dev-link-worktree
```

This builds the worktree binary and writes the worktree's `.myco/runtime.command` directly to `packages/myco/vendor/<target>/myco`. That file is local runtime state and is not inherited when a worktree is created, so run the command from each worktree that needs project-scoped CLI/tool testing.

Runtime scopes stay separate:

- `.agents/myco-run.cjs` is the capture launcher for hooks; in git worktrees it can resolve through the main checkout runtime so session capture stays attached to the main vault.
- `.agents/myco-cli.cjs` is the project launcher for CLI/tool calls; in git worktrees it prefers the worktree-local `.myco/runtime.command`, then falls back to the main checkout pin.

Remove only the worktree pin with `make dev-unlink-worktree`. Use `make dev-unlink` only when intentionally removing the shared dev symlinks from the main checkout.

### myco_cortex — Get Cortex intelligence

Retrieve Cortex-produced project intelligence: the pre-computed project digest, generated instructions, Canopy map, or a specific Canopy file summary.

```json
{ "op": "digest", "tier": 5000 }
```

CLI:

```bash
node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"digest","tier":5000}'
```

Tiers: `1500` (executive briefing), `5000` (default), `10000` (comprehensive). Prefer this over `myco_search` for broad project orientation; use `myco_search` when you need specific prior decisions or bug fixes.

Canopy map:

```bash
node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'
```

Canopy entry returned by search:

```json
{ "op": "canopy_entry", "id": "/project:path/to/file.ts" }
```

### myco_search — Find knowledge across the vault

Search across sessions, plans, spores, skills, and Canopy file summaries.

```json
{ "query": "why did we choose JWT over session cookies", "type": "spore", "limit": 5 }
```

CLI:

```bash
node .agents/myco-cli.cjs tool call myco_search --json --input '{"query":"why did we choose JWT over session cookies","type":"spore","limit":5}'
```

**When to use**: searching for prior decisions, debugging context, understanding rationale, or finding source files by what they do. The `type` filter narrows results — use `"spore"` for decisions/gotchas, `"session"` for session history, `"plan"` for plans, `"skill"` for skills, `"canopy"` for file summaries, or omit for all. Each result includes a stable `id` and, when the entity is retrievable, a `retrieve` object with the exact tool input to fetch it.

### myco_spores — Manage durable spores

List, retrieve, save, supersede, or consolidate durable observations.

```json
{ "op": "get", "id": "decision-abc123" }
```

```json
{ "op": "list", "status": "active", "observation_type": "decision", "limit": 10 }
```

#### Save an observation

Store a noteworthy observation for future sessions. Only save things that aren't obvious from reading the code.

```json
{ "op": "save", "content": "better-sqlite3 WASM build fails on Node 22 ARM — must use native build", "type": "gotcha", "tags": ["sqlite", "build"] }
```

**Observation types:** `gotcha`, `bug_fix`, `decision`, `discovery`, `trade_off`, `cross-cutting`.

**What makes a good observation:**
- Specific: file names, function names, actual error messages, concrete values
- Non-obvious: wouldn't be clear from just reading the code
- Valuable: a teammate encountering the same situation would benefit
- Durable: not specific to a transient state or one-off debugging session

**Bad**: "the auth system is complex"
**Good**: "bcrypt.compare() silently returns false (not an error) on hash format mismatch — spent 2h debugging; the hash column was VARCHAR(50) but bcrypt outputs 60 chars"

Session association is derived by the daemon; the MCP client does not pass it.

### myco_plans — Manage plans

List plans, retrieve a single plan's full content by ID, save a plan, or delete one.

```json
{ "op": "list", "status": "active" }
```

```json
{ "op": "get", "id": "plan-feature-x" }
```

Save a plan directly to the current Myco session when you generated or materially revised it in the conversation:

```json
{ "op": "save", "session_id": "sess-123", "content": "# Primary Plan", "plan_key": "primary" }
```

```json
{ "op": "save", "session_id": "sess-123", "content": "# Plan", "source_path": "docs/plans/feature-x.md" }
```

If the plan is also being written to disk, pass that same `source_path` so direct persistence and file capture reconcile to one logical plan. Use `plan_key` only for plans that do not have a durable file path.

### myco_sessions — Browse session history

Query past sessions with filters.

```json
{ "op": "list", "branch": "feature/auth", "limit": 5 }
```

```json
{ "op": "get", "id": "session-abc123" }
```

Filter by `plan`, `branch`, `user`, or `since` (ISO timestamp).

#### Supersede a spore

When a newer observation makes an older one obsolete, supersede it. The old spore stays in the vault (data is never deleted) but is marked `status: superseded`.

```json
{ "op": "supersede", "old_spore_id": "decision-abc123", "new_spore_id": "decision-def456", "reason": "Migrated from bcrypt to argon2" }
```

**When to use**: a decision was reversed, a gotcha was fixed, a discovery turned out to be wrong, or the codebase changed and an observation no longer applies.

#### Consolidate spores into wisdom

Merge 2+ related spores into a single wisdom note. The daemon inserts the new spore, then marks each source `superseded` and writes a `resolution_events` row (action=`consolidate`) linking it to the new wisdom spore. The source content stays in the vault — nothing is deleted.

```json
{
  "op": "consolidate",
  "source_spore_ids": ["gotcha-aaa111", "gotcha-bbb222", "gotcha-ccc333"],
  "consolidated_content": "# SQLite Operational Gotchas\n\n1. WAL mode requires shared memory...\n2. Single writer lock...\n3. FTS5 tokenization...",
  "observation_type": "gotcha",
  "tags": ["sqlite", "infrastructure"],
  "reason": "Three related SQLite gotchas merged into one reference"
}
```

**When to use**: multiple spores share a root cause, describe the same pattern from different angles, or would be more useful as a single comprehensive reference. Prefer this over manually running `myco_spores` op `"supersede"` repeatedly.

For detailed patterns on when and how to consolidate, read `references/wisdom.md`.

### myco_skills — Inspect skills in the vault

List skills generated by Myco, filter by status, or look up a specific skill by ID or name.

```json
{ "op": "list", "status": "active" }
```

```json
{ "op": "get", "id": "install-and-initialize-myco" }
```

### myco_agent — Inspect agent run history

List recent agent runs with runtime, provider, model, token, and cost fields, or fetch a specific run by id to see its phases and write intents.

```json
{ "op": "runs", "limit": 20 }
```

```json
{ "op": "run", "id": "run-abc123" }
```

### Collective tools (only when connected)

The following tools appear only when the project is connected to a Myco Collective — they are conditionally registered by the shared tools dispatcher based on the team status.

#### collective_projects — List projects in the collective

```json
{}
```

#### collective_project — Get metadata for one project

```json
{ "project": "myco-main", "include_digest": false }
```

#### collective_search — Search across collective projects

Results include project attribution.

```json
{ "query": "authentication approach", "project": "myco-main", "limit": 5 }
```

#### collective_settings — View active collective setting overrides

```json
{}
```

## Wisdom — Keeping the Vault Clean

Spores are injected into every prompt via the `UserPromptSubmit` hook. Each injected spore includes its ID (e.g., `[decision-abc123]`). When you see an injected spore that contradicts what you just did or know to be outdated, **supersede it immediately** — don't wait to be asked. This is how the vault stays accurate.

**Proactive superseding during normal work:**

- You just changed how the stop hook works → an injected spore says it works the old way → `myco_spores` op `"supersede"` with the old ID and a new `myco_spores` op `"save"` capturing the current behavior
- You see two injected spores that say conflicting things → supersede the older one
- An injected gotcha references code that was refactored → supersede it

**Other signals to act on:**

- **Recurring gotchas**: the same problem keeps being recorded → `myco_spores` op `"consolidate"` into one definitive note
- **Overlapping content**: a new spore would duplicate an existing spore → `myco_spores` op `"supersede"` with updated content instead
- **Stale decisions**: a decision references a deleted component or reversed approach → supersede it

The vault should get sharper over time, not just bigger. Every session should leave the vault more accurate than it found it.

## Patterns

### Starting work on an existing feature

1. `myco_cortex` op `"canopy_map"` for project layout, then `myco_search` with your branch and key files
2. `myco_sessions` filtered by branch to see prior session summaries
3. `myco_plans` to check if there's an active plan
4. `myco_plans` op `"save"` after generating or revising a plan that should persist in Myco

### After fixing a tricky bug

```json
{ "op": "save", "content": "Race condition in session stop: the unregister hook can fire before the stop hook processes the buffer. Fixed by checking buffer existence before deletion.", "type": "bug_fix", "tags": ["daemon", "hooks", "race-condition"] }
```

### Before making an architectural decision

1. `myco_search` for prior decisions on the same component
2. If you find relevant context, factor it into your recommendation
3. After the decision is made, use `myco_spores` op `"save"` to capture the rationale

## Reconfiguration

To change LLM providers, models, or digest settings on an existing vault, see `references/reconfiguration.md`. It covers the exact CLI commands, flag names, and order of operations (setup-llm → restart → rebuild if needed → verify).

## Maintenance

For the full CLI reference with all flags, see `references/cli-usage.md`.

All CLI commands use `node` with the CLI script inside the plugin root. Run commands as:

```
node <plugin-root>/dist/src/cli.js <command> [args]
```

Where `<plugin-root>` is the agent's plugin root environment variable (e.g., the value of `CLAUDE_PLUGIN_ROOT` or `CURSOR_PLUGIN_ROOT`).

### Reprocessing sessions

If observations were lost due to a bug, or if you want to re-extract observations with a different LLM, run the `reprocess` command:

```
node <plugin-root>/dist/src/cli.js reprocess
```

This re-reads all session transcripts, re-extracts observations, and re-indexes everything. Existing spores are preserved — new observations are additive.

Options:
- `--session <id>` — reprocess a single session (partial ID match)
- `--index-only` — skip LLM extraction, just re-index and re-embed existing notes

### Digest management

```
node <plugin-root>/dist/src/cli.js digest              # Run incremental digest cycle
node <plugin-root>/dist/src/cli.js digest --tier 3000  # Reprocess a specific tier (clean slate)
node <plugin-root>/dist/src/cli.js digest --full       # Reprocess all tiers from scratch
```

### Vault intelligence

Supersession happens automatically on every spore write. For vault-wide cleanup, see `references/cli-usage.md` for full flags:

```
node <plugin-root>/dist/src/cli.js agent              # Run the intelligence agent
node <plugin-root>/dist/src/cli.js agent --dry-run    # Preview without writing
```

For patterns on when to manually supersede or consolidate, see `references/wisdom.md`.

### Other maintenance commands

```
node <plugin-root>/dist/src/cli.js version     # Check plugin version
node <plugin-root>/dist/src/cli.js rebuild     # Re-index all records
node <plugin-root>/dist/src/cli.js stats       # Check vault health
node <plugin-root>/dist/src/cli.js verify      # Test provider connectivity
node <plugin-root>/dist/src/cli.js config get intelligence.llm.model
node <plugin-root>/dist/src/cli.js config set intelligence.llm.model phi4
```
