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
- **When starting work on a branch** — context is injected automatically at session start, but you can call `myco_recall` for deeper context on specific files.

## What's Automatic

Myco works in the background without explicit tool calls:

- **Session start**: relevant context is injected based on your git branch and active plans
- **During the session**: tool calls, prompts, and responses are buffered as events
- **Session stop**: the daemon extracts spores, writes session records, detects parent sessions, and captures artifacts
- **Lineage**: parent-child session relationships are detected automatically (clear context, same branch, semantic similarity)

The MCP tools below are for going deeper than the automatic context injection provides.

## Setup

If the vault isn't configured, run `myco init` in the project directory for guided first-time setup.

For reconfiguration, status checks, and ongoing management, use the CLI commands and MCP tools documented below. For detailed vault health checks, see `references/vault-status.md`.

## MCP Tools Reference

The local Myco MCP server registers 12 core tools. When the project is connected to a Myco Collective, 3 additional `collective_*` tools are also registered. Tools are defined in `packages/myco/src/mcp/tool-definitions.ts` — that file is the source of truth.

### myco_context — Get the project digest

Retrieve Myco's pre-computed project digest: a synthesis of project history, decisions, patterns, active work, and institutional knowledge. This is the right tool when you need broad orientation on the project, not when you need to find a specific prior record.

```json
{ "tier": 5000 }
```

Tiers: `1500` (executive briefing), `5000` (default), `10000` (comprehensive). Prefer this over `myco_search` for broad project orientation; use `myco_search` when you need specific prior decisions or bug fixes.

### myco_search — Find knowledge across the vault

Search across sessions, plans, and spores.

```json
{ "query": "why did we choose JWT over session cookies", "type": "spore", "limit": 5 }
```

**When to use**: searching for prior decisions, debugging context, or understanding rationale. The `type` filter narrows results — use `"spore"` for decisions/gotchas, `"session"` for session history, `"plan"` for plans, or omit for all.

### myco_recall — Look up a single vault note by ID

Return the full content of a specific session, spore, or plan given its ID. Use this after `myco_search` or `myco_graph` returns an ID you want to read in full.

```json
{ "note_id": "decision-abc123" }
```

(Note: this is *not* a branch-based context tool. For project orientation, use `myco_context`.)

### myco_remember — Save an observation

Store a noteworthy observation for future sessions. Only save things that aren't obvious from reading the code.

```json
{ "content": "better-sqlite3 WASM build fails on Node 22 ARM — must use native build", "type": "gotcha", "tags": ["sqlite", "build"] }
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

### myco_plans — List plans or read a single plan

List plans and their progress, or retrieve a single plan's full content by ID.

```json
{ "status": "active" }
```

```json
{ "id": "plan-feature-x" }
```

When `id` is set, the response includes the plan's `content` field. Otherwise the list shape contains summary metadata only.

### myco_sessions — Browse session history

Query past sessions with filters.

```json
{ "branch": "feature/auth", "limit": 5 }
```

Filter by `plan`, `branch`, `user`, or `since` (ISO timestamp).

### myco_graph — Traverse vault connections

Follow graph connections between records — find related sessions, spores, and plans.

```json
{ "note_id": "session-abc123", "direction": "both", "depth": 2 }
```

### myco_team — See teammate activity

See what teammates have been working on, filtered by files or plan.

```json
{ "plan": "auth-redesign" }
```

### myco_supersede — Mark a spore as replaced

When a newer observation makes an older one obsolete, supersede it. The old spore stays in the vault (data is never deleted) but is marked `status: superseded`.

```json
{ "old_spore_id": "decision-abc123", "new_spore_id": "decision-def456", "reason": "Migrated from bcrypt to argon2" }
```

**When to use**: a decision was reversed, a gotcha was fixed, a discovery turned out to be wrong, or the codebase changed and an observation no longer applies.

### myco_consolidate — Merge spores into wisdom

Merge 2+ related spores into a single wisdom note. The daemon inserts the new spore, then marks each source `superseded` and writes a `resolution_events` row (action=`consolidate`) linking it to the new wisdom spore. The source content stays in the vault — nothing is deleted.

```json
{
  "source_spore_ids": ["gotcha-aaa111", "gotcha-bbb222", "gotcha-ccc333"],
  "consolidated_content": "# SQLite Operational Gotchas\n\n1. WAL mode requires shared memory...\n2. Single writer lock...\n3. FTS5 tokenization...",
  "observation_type": "gotcha",
  "tags": ["sqlite", "infrastructure"],
  "reason": "Three related SQLite gotchas merged into one reference"
}
```

**When to use**: multiple spores share a root cause, describe the same pattern from different angles, or would be more useful as a single comprehensive reference. Prefer this over manually running `myco_supersede` repeatedly.

For detailed patterns on when and how to consolidate, read `references/wisdom.md`.

### myco_skills — Inspect skills in the vault

List skills generated by Myco, filter by status, or look up a specific skill by ID or name.

```json
{ "status": "active" }
```

```json
{ "id": "install-and-initialize-myco" }
```

### myco_skill_candidates — Manage skill candidates

List, approve, or dismiss candidate skills identified from vault observations.

```json
{ "action": "list", "status": "identified" }
```

Valid actions: `list`, `approve`, `dismiss`. Use `{ "id": "<candidate-id>" }` to target a specific candidate.

### Collective tools (only when connected)

The following tools appear only when the project is connected to a Myco Collective — they are conditionally registered by `createMycoServer` based on the team status.

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

## Wisdom — Keeping the Vault Clean

Spores are injected into every prompt via the `UserPromptSubmit` hook. Each injected spore includes its ID (e.g., `[decision-abc123]`). When you see an injected spore that contradicts what you just did or know to be outdated, **supersede it immediately** — don't wait to be asked. This is how the vault stays accurate.

**Proactive superseding during normal work:**

- You just changed how the stop hook works → an injected spore says it works the old way → `myco_supersede` with the old ID and a new `myco_remember` capturing the current behavior
- You see two injected spores that say conflicting things → supersede the older one
- An injected gotcha references code that was refactored → supersede it

**Other signals to act on:**

- **Recurring gotchas**: the same problem keeps being recorded → `myco_consolidate` into one definitive note
- **Overlapping content**: a `myco_remember` would duplicate an existing spore → `myco_supersede` with updated content instead
- **Stale decisions**: a decision references a deleted component or reversed approach → supersede it

The vault should get sharper over time, not just bigger. Every session should leave the vault more accurate than it found it.

## Patterns

### Starting work on an existing feature

1. `myco_recall` with your branch and key files
2. `myco_sessions` filtered by branch to see prior session summaries
3. `myco_plans` to check if there's an active plan

### After fixing a tricky bug

```json
{ "content": "Race condition in session stop: the unregister hook can fire before the stop hook processes the buffer. Fixed by checking buffer existence before deletion.", "type": "bug_fix", "tags": ["daemon", "hooks", "race-condition"] }
```

### Before making an architectural decision

1. `myco_search` for prior decisions on the same component
2. If you find relevant context, factor it into your recommendation
3. After the decision is made, `myco_remember` the rationale

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
