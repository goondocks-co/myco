---
type: Subsystem
title: "Vault Intelligence: Spores, Digest, Wisdom"
description: "How Myco turns raw session activity into durable knowledge: the spore lifecycle (active/superseded/consolidated/obsolete), tiered digest extracts, wisdom synthesis, and release-state provenance — the substrate this synthesis run itself consumes."
timestamp: '2026-07-08T15:52:42.326Z'
---

Every claim on this wiki traces back to two things: a spore and, eventually, a digest tier. This page describes the substrate — how Myco turns raw captured session activity into durable, sharp knowledge, and how it tags that knowledge with whether it actually shipped. The Session Capture Flow page covers how raw activity lands in the vault in the first place; this page covers what happens to it after.

## Spores: the atomic unit of knowledge

A spore is one observation — a `gotcha`, `decision`, `discovery`, `trade_off`, `bug_fix`, or `cross-cutting` note — extracted from session activity, plus the synthesized kinds (`wisdom`, `pattern`, `architecture`) produced by consolidation. `packages/myco/src/constants/spore-status.ts` is the single source of truth for the lifecycle: one live state and three terminal ones.

- **active** — live knowledge, eligible for retrieval, search, embedding, and injection into agent context.
- **superseded** — replaced by a specific newer spore (a decision reversed, a gotcha fixed, a discovery corrected).
- **consolidated** — merged into a comprehensive `wisdom` note that synthesizes 3+ related spores.
- **obsolete** — no longer relevant, with no replacement (e.g. a dropped feature).

The module's own comment is worth repeating because it is a real design decision: every retrieval/search/embedding/feed path gates on `active` as an *allowlist*, so any of the three terminal states removes a spore from injection automatically — there is deliberately no separate "excluded statuses" denylist to keep in sync as new statuses get added.

### Where the writes happen

`packages/myco/src/spores/write.ts` is the shared write path for the symbiont MCP tool (`myco_spores`) and the agent harness's `vault_resolve_spore`/`vault_create_spore` tools — both route through the same `applySporeResolution()` core so status semantics never drift between the two callers. That function does three things in one SQLite transaction:

1. Flips the spore's `status` via a `RESOLUTION_ACTION_TO_STATUS` lookup (`supersede`→`superseded`, `consolidate`→`consolidated`, `obsolete`→`obsolete`).
2. Inserts a `resolution_event` row recording who did it, when, and why.
3. On `supersede`, inserts a `SUPERSEDED_BY` graph edge from the old spore to the new one.

`consolidateSpores()` builds on the same core: it inserts one new `wisdom`-typed spore, then resolves every source spore with `action: consolidate` and `new_spore_id` pointing at the new note, all inside a single transaction (`tests/mcp/tools/consolidate.test.ts` verifies exactly this — new wisdom spore created, sources marked consolidated, resolution events recorded atomically). No spore is ever deleted; supersession and consolidation are links, not erasure.

`packages/myco/src/db/queries/lineage.ts` maintains the broader provenance graph structurally — `FROM_SESSION`, `EXTRACTED_FROM`, `HAS_BATCH`, `DERIVED_FROM`, and `SUPERSEDED_BY` edges — automatically, as a daemon-owned side effect rather than something callers construct by hand.

### When to supersede vs. consolidate vs. obsolete

The `wisdom.md` skill reference (`packages/myco/skills/myco/references/wisdom.md`) is explicit about the signals, and this synthesis run itself follows them:

- **Supersede** when a decision was reversed, a gotcha got fixed, or a discovery turned out wrong/incomplete — one old spore, one specific replacement.
- **Consolidate** when 3+ spores describe the same underlying insight from different angles (three gotchas sharing a root cause, several trade-offs about one architectural decision) — the sources become one `wisdom` note with `properties.consolidated_from` linking back to them. Two related spores are *not* enough to force consolidation; age alone is never a reason to supersede.
- **Obsolete** when knowledge is simply no longer relevant — a dropped feature, no replacement to point to.

There's also an automatic layer: per the skill doc, every new spore write triggers a fire-and-forget pipeline that searches for semantically similar active spores of the same observation type and asks an LLM whether any are now outdated, auto-superseding them — most vault hygiene happens without a human or agent explicitly invoking `vault_resolve_spore`. The `supersession-sweep.yaml` built-in task does the same work in bulk after large refactors.

## Digest tiers: compressed, rotating summaries

Spores accumulate faster than any single context window can hold. The digest system compresses them into three token-budgeted tiers, each with a distinct purpose (`packages/myco/src/prompts/digest-{1500,5000,10000}.md`):

| Tier | Budget | Purpose |
|---|---|---|
| `digest-1500` | ~1,500 tokens | Executive briefing — critical-only, highest-signal insights |
| `digest-5000` | ~5,000 tokens | Deep onboarding — patterns, trade-offs, and accumulated wisdom a new contributor needs (Project Identity, Architecture, Current State, Decision Log, Accumulated Wisdom, Trade-offs, Team Dynamics, Open Threads, Glossary) |
| `digest-10000` | ~10,000 tokens | Complete archive — every pattern, trade-off, and nuance |

Two tiers that used to exist — `digest-7500` and `digest-3000` — were removed. A quality audit found `digest-7500` was chronically undersized (~5,370 tokens, nearly indistinguishable from `digest-5000`) while `digest-3000` was chronically oversized (~4,074 tokens, bleeding into `digest-5000` territory); the middle tiers added no distinct informational layer, so cutting them to a clean 3× compression hierarchy (1500/5000/10000) also cut cost ~40% by running 3 concurrent phases instead of 5.

### Two-stage generation: assess, then rotate-and-update

The digest pipeline that runs inside `vault-evolve` (the phased task this very synthesis process is a variant of) is two-stage:

1. **`digest-assess`** runs first and serially. It picks exactly **one** tier to deep-assess per run — via `vault_read_digest({pick: "rotate_oldest", min_staleness_seconds: 1800})`, which reads `generated_at` across all 3 tiers and deterministically returns whichever is stalest, or `{skip: true}` if all three are under 30 minutes old. The other two tiers get explicit SKIP directives. This tool-driven (not prompt-driven) rotation was chosen over having assess re-evaluate all three tiers every run because it's deterministic, unit-testable with three timestamps, and self-auditing (`rotation_reason`, e.g. "Tier 5000 has oldest generated_at (1776574780)"); the same watermark-rotation shape (oldest-first, one item per run, fixed turn budget) also governs skill re-verification in the [Skill Lifecycle](/subsystems/skill-lifecycle.md) subsystem — two independent systems converging on it suggests it's a reusable agent-design primitive, not a one-off.
2. **3 parallel tier phases** (10000, 5000, 1500) then run concurrently, each assembled by `composePhasePrompt` with: the vault context, the full task overview, capped (4000-char) summaries from every prior phase including `digest-assess`'s findings, and a tier-specific prompt. Turn budgets scale with tier size (10000→7 turns, 5000→~5, 1500→~3). Notably, `vault_search_semantic` is deliberately excluded from the `digest-1500` phase — it already inherits `digest-assess`'s distillation of what's stale, so re-searching would just burn its few turns on retrieval instead of synthesis.

This assess-then-rotate design is itself a fix for an earlier, costlier shape (digest-assess used to read and re-evaluate all 3 tiers every run before rotation was introduced), and it has its own worked bug: `gatherStats()` once reported 5 digest tiers instead of 3 because it queried all rows in `digest_extracts`, including stale rows left over from the removed 3000/7500 tiers. The fix was to push the tier filter into `listDigestExtracts()` at the query layer rather than patching each caller — the dashboard stats card and the digest API endpoint both call that one function, so filtering once there fixed both call sites at once. That's a small but genuinely instructive instance of "filter where the data is read, not where it's displayed."

## Wisdom synthesis: 3+ spores become one note

A `wisdom` spore is what consolidation produces: a higher-order note synthesized from **3 or more** related spores, always carrying `properties.consolidated_from` back to its sources. This page itself draws on two such wisdom spores — one describing the digest pipeline's two-stage architecture, another synthesizing a digest-tier-rotation decision, the watermark-rotation pattern discovery, and the `gatherStats()` bug fix into a single "Digest Infrastructure" note. That structure is the template: a wisdom note doesn't just summarize its sources, it names each contributing spore's kind (decision, discovery, bug_fix) and preserves the distinct shape of its contribution rather than flattening everything into one paragraph.

`pattern` and `architecture` are the other two synthesized kinds, used more sparingly: a `pattern` spore names a recurring shape across the codebase (the watermark-rotation example above is a candidate once a third independent use case shows up); an `architecture` spore is reserved for load-bearing invariants — spores that explain *why* the design works the way it does, the kind that grounds pages like [Runtime & Daemon Authority](/architecture/runtime-and-daemon.md) and Myco's Own Agent Harness.

## Release-state provenance: what's actually shipped

Not all vault knowledge is equally trustworthy going forward — a `decision` spore about code on a branch that got reverted is a very different thing from one about code that shipped to `main` weeks ago. Myco tags spores, sessions, prompt batches, plans, artifacts, skills, and Canopy entries with a **release-state annotation**, computed by `packages/myco/src/release-provenance/reconcile.ts` from git commit history (patch-id matching against merge bases, tolerant of squash-merges) and exposed for lookup via the `vault_release_state` tool and `packages/myco/src/release-provenance/annotations.ts`.

Each record's annotation carries a `state` and a `confidence`:

- **`released`** — the change shipped (present on the reconciled release line).
- **`merged_unreleased`** — merged into the mainline but not yet in a release.
- **`not_on_release_line`** — exists but isn't part of the tracked release lineage (e.g. an abandoned branch).
- **`unreconciled`** — not yet checked against git history.
- **`unknown`** — no basis found to classify it.

The operating guidance this page's own instructions encode is worth stating explicitly because it's easy to get backwards: prefer released/high-confidence knowledge for general guidance, but do not discard `unknown` or `unreconciled` knowledge as unimportant — it's evidence that hasn't been checked yet, not evidence that's wrong. A `merged_unreleased` decision is still real; it just hasn't shipped.

## Why this matters for the rest of the wiki

Every subsystem and architecture page in this bundle is itself downstream of this pipeline: its claims came from spores extracted during past sessions, sharpened by supersession and consolidation, and — where cited — checked against release state before being trusted. The Myco's Own Agent Harness page describes the task engine that runs the extraction/consolidation/digest phases described here; the OKF Publishing page describes how this very wiki-synthesis run is required to consume that pre-computed intelligence (Canopy summaries, spores, digest) rather than re-exploring the codebase from scratch — a direct consequence of the vault being the load-bearing source of truth this page describes.

# Citations

[1] `packages/myco/src/constants/spore-status.ts` — spore status/resolution-action enums and the active-allowlist design note
[2] `packages/myco/src/spores/write.ts` — `applySporeResolution`, `supersedeSpore`, `obsoleteSpore`, `consolidateSpores`
[3] `packages/myco/skills/myco/references/wisdom.md` — supersede/consolidate signals and automatic-supersession pipeline
[4] `packages/myco/src/prompts/digest-1500.md`, `digest-5000.md`, `digest-10000.md` — per-tier budgets and required sections
[5] `packages/myco/src/release-provenance/annotations.ts` — release-state annotation shape and lookup helpers
[6] `packages/myco/src/db/queries/lineage.ts` — automatic lineage-edge maintenance
[7] `tests/mcp/tools/consolidate.test.ts` — transactional consolidation behavior
[8] spore `spore_f9ee7c0809ac9ffb7272689bea72a9b1` (wisdom) — digest pipeline two-stage design, tier purposes, 7500/3000 removal rationale
[9] spore `spore_d71f1fe96a77a703f468a3944479c281` (wisdom, consolidated from decision `afa38c0e`, discovery `f1e28a19`, bug_fix `f1ee5d53`) — digest tier rotation via tool-driven watermark, the watermark-rotation pattern, and the `gatherStats()` tier-count bug fix
[10] plan `50a8a6456778ac9c` — "Release Provenance and Knowledge State" design spec
