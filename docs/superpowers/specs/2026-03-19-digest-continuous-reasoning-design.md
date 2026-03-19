# Digest: Continuous Reasoning for Myco

**Date:** 2026-03-19
**Status:** Approved
**Author:** Chris + Claude

## Summary

Digest is a continuous reasoning system that runs inside the Myco daemon, periodically synthesizing all accumulated vault knowledge into tiered, pre-computed context representations called **extracts**. It replaces the current session-start context injection (layer-based: plans, sessions, memories, team) with a rich, always-ready project understanding that an agent receives automatically or pulls on demand.

The feature is **opt-out by default** — upgrading users get conservative settings that just work; new users get system-aware recommendations during onboarding.

## Motivation

Today, Myco captures rich data — session summaries, observations (spores), plans, artifacts, team activity — but serves it back as search results and raw snippets. Each session is analyzed in isolation. No process reasons across the accumulated corpus to produce a unified understanding.

The result: agents start each session with a shallow view — recent session titles, a few relevant spore snippets. They can search for more, but they don't know what they don't know.

Digest closes this gap. A background process continuously maintains a synthesized understanding of the project: what it is, what's been happening, where it's going, who's building it, and what the team has learned. This understanding is pre-computed and instantly available — no LLM call at serve time.

Inspired by [Honcho's continuous reasoning architecture](https://docs.honcho.dev/v3/documentation/core-concepts/architecture), adapted for Myco's local-first, file-based design.

## Glossary

| Term | Definition |
|------|-----------|
| **Digest** | The continuous reasoning process that synthesizes accumulated vault knowledge into pre-computed context representations. Runs as a daemon task on an adaptive timer. |
| **Digest cycle** | A single execution of the digest process — discovers substrate, reasons over it, produces updated extracts. |
| **Extract** | A tiered, pre-computed context representation at a specific token budget (1500/3000/5000/10000). Stored as markdown in `vault/digest/`. The output of a digest cycle. |
| **Substrate** | New or updated vault notes (sessions, spores, plans, artifacts, team) that haven't been digested yet. The input to a digest cycle. |
| **Trace** | The append-only audit chain recording what each digest cycle processed — which notes, which tiers, duration, model used. Stored as JSONL in `vault/digest/trace.jsonl`. |
| **Metabolism** | The adaptive processing rate of the digest system. High metabolism = frequent cycles. Low metabolism = infrequent cycles. |
| **Active metabolism** | Digest cycles running at maximum frequency (~5 min). Triggered by active sessions. |
| **Metabolic slowdown** | Progressive backoff of cycle frequency when no new sessions are active but substrate exists. |
| **Dormancy** | Digest timer fully suspended. No substrate has arrived for an extended period. No processing occurs. |
| **Activation** | Transition from dormancy back to active metabolism, triggered by a new session registration or fresh substrate. |
| **Spore** | A discrete observation extracted from session activity — a gotcha, decision, discovery, trade-off, or bug fix. Formerly called "memory." Stored in `vault/spores/{type}/`. |

## Architecture

### Module Placement

The Digest module lives in `src/daemon/digest.ts` and runs inside the existing daemon process — not a separate process. It's a peer to batch processing and plan watching: another background task managed by the daemon lifecycle.

### Lifecycle

```
Daemon starts
  → Digest initializes
  → Reads trace (last cycle state)
  → Checks for substrate (new data since last cycle)
  → If substrate exists: runs digest cycle
  → Sets timer based on metabolic rate
  → Listens for activation signals (new session events)
```

The daemon already knows about session registrations. The Digest module subscribes to these events for activation — no new infrastructure needed.

### Adaptive Metabolism (Timer)

```
Active metabolism:    5 min cycles   (sessions active in last 30 min)
Slowing metabolism:  15 min → 30 min → 1 hour   (backoff steps, no active sessions)
Dormancy:            timer suspended   (no new substrate for 2+ hours)
Activation:          session-start event → resume active metabolism
```

Power-aware design inspired by Open Agent Kit's power state management: burst when active, decay when idle, full sleep when stale. Prevents keeping laptops awake when there's nothing to process.

## The Digest Cycle

### Trigger

The timer fires. The digest module checks: is there new substrate since the last cycle? If not, skip and advance toward dormancy. If yes, run.

### Substrate Discovery

Query the existing SQLite index for notes with `updated_at > last_cycle_timestamp`:

- Session summaries (new or resumed sessions — resumed sessions generate new spores, which update `updated_at`)
- Spores (new observations from any session)
- Plans (status changes, new plans)
- Artifacts (new or updated)
- Team members (new or updated)

This is a single index query, not a vault scan. The index already tracks `updated_at` for every note. **Note:** The current `MycoIndex.query()` API filters on `created`, not `updated_at`. The index schema has the `updated_at` column, but `QueryOptions` must be extended to support filtering by it. This is a small addition to `src/index/sqlite.ts`.

### Pipeline

```
1. Query index for substrate (notes with updated_at > last_cycle_timestamp)
2. If no substrate → skip, increase backoff toward dormancy, return
3. Load substrate content (read the actual note files)
4. For each configured tier (1500, 3000, 5000, 10000):
   a. Read the previous extract for this tier (if exists)
   b. Build prompt: system prompt + tier prompt + previous extract + substrate
   c. LLM call with tier-specific prompt and token budget
   d. Write new extract to vault/digest/extract-{tier}.md
5. Append cycle record to trace.jsonl
6. Reset timer to active metabolism rate
```

### Delta-Based Processing

Each cycle takes the previous extract as input alongside new substrate. The LLM integrates new information into its existing understanding and produces an updated extract. The previous extract is the LLM's "memory" of all prior cycles.

This means:
- Context window stays bounded regardless of vault size
- Older knowledge is preserved through the extract, not re-read from source
- Resumed sessions naturally surface as fresh substrate (their `updated_at` changes when new spores are extracted)

### Substrate Truncation

When substrate exceeds the context budget, prioritize by:
1. **Recency** — most recent notes first
2. **Type weight** — sessions and spores over artifacts and team notes
3. **Truncation** — individual note content trimmed using `CHARS_PER_TOKEN` heuristic

Unprocessed substrate remains for the next cycle — the delta approach naturally catches up over subsequent cycles.

## Tiered Extracts

Each tier gets an independent LLM call with a purpose-built prompt. Tiers are not compressed versions of each other — each reasons about what matters within its specific budget.

| Tier | Focus | Character |
|------|-------|-----------|
| **1,500 tokens** | Project identity, current focus, critical gotchas/blockers, who's working | Executive briefing — what is this and what's happening right now |
| **3,000 tokens** | Above + recent activity narrative, key decisions, active plans, conventions | Team standup — enough to orient and start contributing |
| **5,000 tokens** | Above + accumulated wisdom, patterns, trade-off reasoning, cross-cutting concerns | Deep onboarding — a new contributor could hit the ground running |
| **10,000 tokens** | Above + full thread histories, plan evolution, artifact summaries, lessons learned | Institutional knowledge — the full picture with context behind decisions |

### Context Window Requirements

| Tier | Output | Previous Extract | Substrate Budget | System Prompt | Total Needed |
|------|--------|-----------------|------------------|---------------|-------------|
| 1,500 | ~1,500 | ~1,500 | ~3,000 | ~500 | ~6,500 |
| 3,000 | ~3,000 | ~3,000 | ~5,000 | ~500 | ~11,500 |
| 5,000 | ~5,000 | ~5,000 | ~8,000 | ~500 | ~18,500 |
| 10,000 | ~10,000 | ~10,000 | ~10,000 | ~500 | ~30,500 |

### Extract Format

Each extract is a markdown file with YAML frontmatter, readable in Obsidian:

```markdown
---
type: extract
tier: 3000
generated: 2026-03-18T14:30:00Z
cycle_id: dc-a1b2c3
substrate_count: 12
model: llama3.2
---

[synthesized context as markdown prose, structured by the LLM
 to fit within the token budget]
```

### Trace Record

Each cycle appends one JSON line to `trace.jsonl`:

```json
{
  "cycle_id": "dc-a1b2c3",
  "timestamp": "2026-03-18T14:30:00Z",
  "substrate": {
    "sessions": ["session-abc123", "session-def456"],
    "spores": ["gotcha-ac5220-1773416089650"],
    "plans": [],
    "artifacts": ["artifact-readme"]
  },
  "tiers_generated": [1500, 3000, 5000, 10000],
  "model": "llama3.2",
  "duration_ms": 45200,
  "tokens_used": 18400
}
```

## Prompt Design

### Shared System Prompt

```
You are Myco's digest engine. Your role is to maintain a living understanding
of a software project by synthesizing observations, session histories, plans,
and team activity into a coherent context representation.

You will receive:
1. Your previous synthesis (if one exists)
2. New substrate — recently captured knowledge that needs to be incorporated

Produce an updated synthesis that:
- Integrates the new substrate into your existing understanding
- Stays within the specified token budget
- Is written for an AI agent that will use this as its primary project context
- Uses present tense for active state, past tense for completed work
- Never fabricates — only synthesize from provided data
```

### Tier-Specific Prompts

**1,500 tokens — Executive Briefing:**
```
Budget: ~1,500 tokens. This is the smallest representation.
Prioritize ruthlessly:
- What is this project? (1-2 sentences)
- What is actively being worked on right now?
- What are the critical gotchas or blockers?
- Who is working on it? (if known)

Drop: historical decisions, completed work, trade-off reasoning, conventions.
An agent reading this should immediately know what it's walking into.
```

**3,000 tokens — Team Standup:**
```
Budget: ~3,000 tokens.
Include everything from the briefing tier, plus:
- Recent activity narrative (what happened in the last few sessions)
- Key decisions made and why
- Active plans and their status
- Important conventions or patterns the agent should follow

Drop: deep trade-off reasoning, exhaustive history, edge case wisdom.
An agent reading this should be able to start contributing meaningfully.
```

**5,000 tokens — Deep Onboarding:**
```
Budget: ~5,000 tokens.
Include everything from the standup tier, plus:
- Accumulated wisdom: recurring gotchas, established patterns
- Trade-off reasoning behind key architectural decisions
- Cross-cutting concerns that affect multiple areas
- Team member specialties and working patterns

Drop: exhaustive historical detail, completed-and-closed threads.
An agent reading this should understand not just what to do, but why things are the way they are.
```

**10,000 tokens — Institutional Knowledge:**
```
Budget: ~10,000 tokens.
The full picture. Include everything from the onboarding tier, plus:
- Complete thread histories for active and recently completed work
- Detailed trade-off analysis and alternatives that were rejected
- Plan evolution — what changed and why
- Artifact summaries and their significance
- Lessons learned from past incidents

An agent reading this should have the equivalent of months of project context.
```

### Prompt Assembly

```
[System prompt]
[Tier-specific prompt]

## Previous Synthesis
{previous extract content, or "No previous synthesis exists."}

## New Substrate
{formatted substrate notes — type, title, key content for each}

## Instructions
Produce your updated synthesis now. Stay within {budget} tokens.
```

### Substrate Formatting

Each substrate note is formatted compactly:

```
### [session] session-abc123 — "Refactored auth middleware"
Ended: 2026-03-18. Branch: fix/auth. Files changed: 4.
Summary: Replaced legacy session token storage with encrypted JWT...

### [spore:gotcha] gotcha-ac5220-1773416089650
Session: session-abc123
Root cause: The old middleware cached tokens in localStorage...

### [plan] plan-digest-feature
Status: active. Author: chris.
Implement continuous reasoning for the Myco daemon...
```

## Serving

### Session-Start Injection

When `digest.enabled: true` and `digest.inject_tier` is set, the session-start hook reads the extract file directly from disk — no LLM call, no index query:

```
vault/digest/extract-{inject_tier}.md → parse frontmatter → inject body as context
```

This replaces the current `buildInjectedContext()` layer system. The extract already contains a synthesized version of plans, sessions, spores, and team activity.

**Fallback:** If digest is enabled but no extract file exists yet (first run, vault just initialized), fall back to the existing layer-based injection until the first digest cycle completes.

### MCP Tool: `myco_context`

New tool exposed via the MCP server:

```typescript
{
  name: "myco_context",
  description: "Retrieve Myco's synthesized understanding of this project. " +
    "Returns a pre-computed context extract at the requested token tier. " +
    "Available tiers: 1500 (executive briefing), 3000 (team standup), " +
    "5000 (deep onboarding), 10000 (institutional knowledge). " +
    "This is a rich, always-current synthesis of project history, " +
    "decisions, patterns, and active work — not a search result.",
  inputSchema: {
    type: "object",
    properties: {
      tier: {
        type: "number",
        enum: [1500, 3000, 5000, 10000],
        description: "Token budget tier. Larger tiers include more detail."
      }
    }
  }
}
```

Reads the extract file, returns its content. If the requested tier doesn't exist, returns the nearest available tier with a note about what was served. No LLM call at serve time.

### Skill Update

The Myco skill is updated to know about `myco_context`. When digest is enabled but injection tier is low (or disabled), the skill instructs the agent to use the MCP tool for deeper context. This enables the layered approach: auto-inject 1.5K, agent pulls 5K+ when it needs deeper understanding.

### Per-Prompt Spore Injection

**Unchanged.** The existing vector-search-based per-prompt injection continues. When the user types a prompt, the hook searches for relevant spores and injects the top matches. This complements the extract — the extract provides the big picture, spore injection provides targeted relevance for the specific prompt.

## Configuration

New `digest` section in `myco.yaml`:

```yaml
digest:
  enabled: true                     # Opt-out (enabled by default)
  tiers: [1500, 3000, 5000, 10000]  # Which tiers to generate
  inject_tier: 3000                 # Which tier to auto-inject at session start (null = disabled)

  intelligence:
    provider: null       # null = inherit from intelligence.llm.provider
    model: null          # null = inherit from intelligence.llm.model
    base_url: null       # null = inherit from intelligence.llm.base_url
    context_window: 32768  # Override for digest operations

  metabolism:
    active_interval: 300         # 5 min when sessions active
    cooldown_intervals: [900, 1800, 3600]  # 15m → 30m → 1h backoff steps
    dormancy_threshold: 7200     # 2 hours no substrate → dormancy

  substrate:
    max_notes_per_cycle: 50      # Cap substrate size per cycle
```

### Interaction with Existing Config

When `digest.enabled: true` and `digest.inject_tier` is set:
- Session-start injection uses the extract file instead of the layer-based system
- The current `context.layers` config is bypassed (not removed)
- Per-prompt spore injection continues unchanged

When `digest.enabled: false`:
- Everything works exactly as it does today
- No digest cycles run, no extracts generated

### Intelligence Override

The `digest.intelligence` block allows a full LLM provider override. Users can run:
- **Hooks/extraction:** Ollama, `gpt-oss-20b`, 8K context — fast, lightweight
- **Digest:** Ollama, `qwen3.5-30b`, 32K context — slower, deeper reasoning

Or point digest at a different provider entirely. The separation exists because digest has fundamentally different resource needs than real-time hook processing.

**Tier gating by context window:** If the configured `context_window` is too small for a tier (per the Context Window Requirements table), that tier is automatically skipped during digest cycles. For example, `context_window: 8192` only generates the 1,500-token tier. This prevents failed LLM calls and lets users safely configure all four tiers knowing only the ones their hardware can handle will run.

## Upgrade & Onboarding

### Existing Users (Upgrade Path)

On daemon startup, if `digest` config section is missing from `myco.yaml`:
- Add it with `enabled: true`
- No intelligence overrides — inherits the existing LLM config
- Default tiers: `[1500, 3000]` (safe for any machine already running local LLMs)
- Default `inject_tier: 1500` (conservative, immediately useful)

No re-setup required. The daemon starts the digest metabolism, and the next session gets a synthesized extract.

### New Users (Onboarding)

The `/init` and `/setup-llm` commands are enhanced with system capability detection:

```
Detecting system capabilities...
  RAM: 32GB | GPU: Apple M2 Pro 16GB unified
  Recommended digest config: tiers [1500, 3000, 5000], context 16K

? Accept recommended digest configuration? [Y/n]
```

Heuristics:

| Available Memory | Recommended Tiers | Context Window |
|-----------------|-------------------|----------------|
| < 16GB | `[1500]` | 8K |
| 16–32GB | `[1500, 3000]` | 16K |
| 32–64GB | `[1500, 3000, 5000]` | 24K |
| 64GB+ | `[1500, 3000, 5000, 10000]` | 32K |

System detection: `sysctl hw.memsize` (macOS), `/proc/meminfo` (Linux), Ollama model list for available models.

### Power Users

Run `/setup-llm` to reconfigure with full control: separate provider/model for digest, custom tiers, context window tuning.

## Spore Migration

Rename `memories` → `spores` across the codebase and vault.

### Vault Migration

One-time, on daemon startup:

1. **Detect:** `vault/memories/` exists and `vault/spores/` does not
2. **Rename:** `vault/memories/` → `vault/spores/`
3. **Update frontmatter:** Walk all `.md` files — `type: 'memory'` → `type: 'spore'`
4. **Reindex:** All affected notes (type field changed)
5. **Re-embed:** Affected notes (metadata updated)

**Idempotent:** If `vault/spores/` already exists, skip. If both exist (interrupted migration), merge and deduplicate by note ID.

### Code Changes

The rename touches every file that references `memory`/`Memory`/`memories`. The table below lists the primary areas; the implementation must also grep for and update all remaining references across the codebase.

| Area | Change |
|------|--------|
| `src/vault/writer.ts` | `writeMemory()` → `writeSpore()`, paths `memories/` → `spores/` |
| `src/vault/types.ts` | `MemorySchema` → `SporeSchema`, `MemoryFrontmatter` → `SporeFrontmatter`, `type: 'memory'` → `type: 'spore'` |
| `src/vault/frontmatter.ts` | `memoryFm()` → `sporeFm()`, imports updated |
| `src/vault/observations.ts` | `writeMemory()` → `writeSpore()`, `formatMemoryBody()` → `formatSporeBody()` |
| `src/vault/reader.ts` | Query paths updated |
| `src/obsidian/formatter.ts` | `formatMemoryBody()` → `formatSporeBody()`, `MemoryBodyInput` → `SporeBodyInput`, `'memory'` tag → `'spore'` |
| `src/constants.ts` | `CONTEXT_MEMORY_PREVIEW_CHARS` → `CONTEXT_SPORE_PREVIEW_CHARS` and similar |
| `src/config/schema.ts` | `context.layers.memories` → `context.layers.spores`, new `digest` config section with Zod schema (all-optional fields inheriting from parent LLM config) |
| `src/prompts/extraction.md` | Terminology update |
| `src/mcp/tools/` | `myco_remember`, `myco_recall`, `myco_search`, `consolidate`, `supersede` — descriptions updated, tool names unchanged (the verbs "remember" and "recall" are user-facing actions, not tied to the internal type name) |
| `src/context/injector.ts` | Layer references updated |
| `src/cli/` | `stats.ts`, `rebuild.ts`, `reprocess.ts`, `init.ts` — memory paths/types updated |
| `src/index/sqlite.ts` | Extend `QueryOptions` to support `updatedSince` filter on `updated_at` column (existing `since` filter on `created` remains unchanged) |
| `CLAUDE.md` | Update vault structure, naming conventions (`memories/` → `spores/`), `writeMemory` → `writeSpore` references, glossary |
| `tests/` | All test files mirroring the above changes |

## New Components

| File | Purpose |
|------|---------|
| `src/daemon/digest.ts` | The digest engine — timer, substrate discovery, cycle pipeline, metabolism management |
| `src/mcp/tools/context.ts` | `myco_context` MCP tool handler |
| `src/prompts/digest-system.md` | Shared system prompt template |
| `src/prompts/digest-1500.md` | 1,500-token tier prompt |
| `src/prompts/digest-3000.md` | 3,000-token tier prompt |
| `src/prompts/digest-5000.md` | 5,000-token tier prompt |
| `src/prompts/digest-10000.md` | 10,000-token tier prompt |
| `vault/digest/` | Extract files and trace (created on first cycle) |

## Updated Vault Structure

```
~/.myco/vaults/<vault-name>/
  myco.yaml           # Vault configuration
  daemon.json          # Running daemon PID/port
  index.db             # SQLite FTS5 index
  vectors.db           # sqlite-vec vector embeddings
  buffer/              # Per-session JSONL event buffers (ephemeral)
  sessions/            # Session notes by date
  spores/              # Observation notes (renamed from memories/)
  plans/               # Plan notes
  artifacts/           # Artifact references
  attachments/         # Images from session transcripts
  team/                # Team member notes
  digest/              # Extracts and trace (new)
  logs/                # Daemon logs
```

## Design Principles

All existing Myco principles apply to the digest system:

- **Data preservation:** Extracts are overwritten (they're derived, not primary data). The trace is append-only. Source data (sessions, spores) is never modified by the digest process.
- **Idempotence:** Running the same digest cycle twice with the same substrate produces the same result. The LLM may vary output, but the process is structurally idempotent.
- **Session ID as source of truth:** Digest doesn't track sessions by lifecycle events. It discovers substrate via `updated_at` timestamps in the index.
- **No magic literals:** All timer intervals, thresholds, token budgets, and limits are named constants.
- **Graceful degradation:** If the LLM is unreachable, the cycle skips and retries on the next timer tick. If no extract exists, session-start falls back to the existing layer-based injection.
