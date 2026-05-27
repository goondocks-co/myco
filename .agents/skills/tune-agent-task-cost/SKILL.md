---
name: tune-agent-task-cost
description: "Use this skill whenever you are designing, modifying, or debugging the cost profile of a Myco agent pipeline task — vault-evolve, skill-evolve, skill-survey, canopy-describe, title-summary, or any new phased task. It covers the cost-tuning patterns that have crystallized across the codebase: origin discipline on batch reads, accelerator threshold sizing, the orchestrator-as-narrower rule, mechanical pre-filtering before LLM spend, per-stage preConditions, tier-not-model phase routing, the cheap-search/expensive-write phase-split pattern, per-run work caps, and output discipline. Apply whenever you touch `packages/myco/src/agent/definitions/tasks/*.yaml`, the orchestrator, accelerator config, or any code that feeds an intelligence task. This skill is hand-managed — do NOT register it with the Myco skill pipeline."
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Tuning Agent Task Cost

Myco's phased agent tasks are the largest LLM-spend surface in the system. They run unattended on a schedule, often dozens of times per day, on the user's own credits. A task that is correct but cost-careless will burn through a monthly budget in days. This skill captures the patterns that have emerged across `skill-evolve` and `vault-evolve` for keeping these tasks cheap *and* predictable, without sacrificing the work they're meant to do.

Cost-tuning is a discipline, not a single trick. The same task can cost $0.40 or $3.00 depending on whether these patterns are applied. Use this skill any time you author a new phased task or revisit an existing one.

## Prerequisites

- Read `myco:author-and-debug-agent-pipeline-tasks` first for the mechanics (YAML anatomy, scheduling, budgets, preConditions). This skill is the cost-discipline layer on top of those mechanics.
- Familiarity with `agent_runs` table fields (`actual_cost_usd`, `checkpoints`, `error`) — the audit trail is where you measure whether your tuning worked.
- Understand the difference between `reasoningLevel` (a tier: `low | default | high`) and a concrete model name (`haiku`, `sonnet`, `opus`). Tasks should specify tiers; the provider's `reasoning_map` chooses the model.

---

## Pattern 1: Origin Discipline on Batch Reads

**Problem.** `prompt_batches` has an `origin` column: `human`, `system`, `agent_dispatch`. The `system` origin captures environment-context wrappers, tool announcements, and other harness-injected messages — none of which carry the user's intent. When an intelligence task reads `vault_unprocessed` without an origin filter, the LLM spends turns reasoning over noise like `<environment_context><current_date>...</current_date></environment_context>` and may even emit spores about it.

**Rule.** Intelligence tasks (extract, summarize, consolidate, anything that reasons about user work) read `origin = 'human'` only. The same filter must be applied to the *accelerator count*, or you'll trigger frequent runs over a queue that's secretly 10–20% noise.

**Exception.** Title-summary, classification, and other tasks that operate on raw session traffic may need `origin IN ('human', 'system')` — gate via an explicit caller-provided list. Default to `['human']` for new callers.

**Implementation site.** `getUnprocessedBatches` and `countUnprocessedSettledBatches` in `packages/myco/src/db/queries/batches.ts`. The accelerator wiring is in `packages/myco/src/daemon/task-scheduling.ts`.

---

## Pattern 2: Accelerator Sizing + Run-Per-Day Ceiling

**Problem.** Schedule blocks specify `intervalSeconds` (e.g., `21600` for 6h), but accelerators can override that cadence when work piles up. A heavy-use machine generating 100+ batches/day will keep an `accelerated: 25` threshold permanently tripped — turning a "6-hour task" into an hourly one. This was the single biggest cost driver discovered for vault-evolve.

**Rule.** Pair every accelerator with a **runs-per-24h ceiling** in the scheduler. The accelerator decides *when within the window*; the ceiling decides *how many times today*. Without the ceiling, the cadence is unbounded for heavy workloads.

**Threshold sizing.** Don't pick round numbers; size to throughput:
- `steady` ≈ "enough work to justify a single run." For batch-driven tasks, this is the number of items that fits comfortably in one phase budget (e.g., ~25 batches for a 35-turn extract).
- `accelerated` ≈ "the queue is growing faster than we can drain it." Should be 3–4× `steady`.
- Combine with a ceiling of ~6 runs/24h per project so a runaway queue doesn't translate into runaway spend.

**Anti-pattern.** Picking thresholds based on what the task *can do* in a single run instead of what the workload *naturally produces* — this is how `steady: 5` ended up running vault-evolve every ~90 minutes.

---

## Pattern 2b: `required: true` for Phases the Orchestrator Can't Plan For

**Problem.** The orchestrator runs once at the start of a task with only pre-planning context (configured `contextQueries` like `vault_state`, `vault_unprocessed`). It cannot know what later phases will discover. If you let it skip a phase whose need to run depends on a *prior in-run phase's output* — e.g., a digest-write phase that should fire only when digest-assess selects its tier for rotation — the orchestrator's upfront skip silently loses legitimate work.

We hit this on the first post-tuning dogfood run: `digest-assess` correctly identified tier 1500 for rotation and gathered the integration material, but `digest-1500` was already in the orchestrator's skip list and never wrote the new digest content.

**Rule.** A phase is `required: false` (and therefore orchestrator-skippable) **only if its need to run is knowable from pre-planning context** — vault_state, vault_unprocessed counts, the contextQueries block. If the need is only knowable *after* an in-run phase computes it, the dependent phase MUST be `required: true`. Its own prompt handles the cheap self-skip when the prior phase decides it shouldn't write anything.

**Examples.**
- `extract`: orchestrator can know there are no unprocessed batches from pre-planning context → `required: false` ok.
- `consolidate-shortlist`: deterministic preCondition (`has-recent-spore-activity`) makes the decision knowable upfront → `required: false` ok.
- `digest-1500` / `digest-5000` / `digest-10000`: rotation decision is made *during* the run by `digest-assess` → `required: true` is mandatory. Each prompt self-skips in ~3 haiku turns when not selected (≈ $0.04 per skipped tier per no-work run — bounded, predictable, far cheaper than losing a legitimate digest write).

**Spotting violations.** Look at a recent no-op run's checkpoints. Find phases that appear MISSING from the checkpoint despite their upstream completing. For each, ask: *could the orchestrator have known at planning time whether this phase had work?* If no, the phase must be `required: true`.

---

## Pattern 3: Orchestrator as Narrower, Never Widener

**Problem.** The orchestrator phase (`packages/myco/src/agent/orchestrator.ts`) is allowed to override per-phase `maxTurns` via `directive.maxTurns`. When the orchestrator widens a budget, the YAML stops being a spec — the same task can run 35 turns or 161 turns depending on how the orchestrator felt that day. This produced silent 4×+ cost variance in vault-evolve.

**Rule.** The orchestrator may **skip** phases and may **shrink** per-phase budgets. It may **never widen** a budget beyond the YAML value. `applyNonSkipDirective` must clamp `directive.maxTurns` to the original `phase.maxTurns`. Log a warning when the orchestrator tries to widen so the gap is visible.

**Why this matters for cost.** With widening allowed, the YAML budget is a suggestion; runs are unpredictable; failures look random (sometimes 35 hits a cap, sometimes 126 doesn't). With widening forbidden, the YAML is the spec, runs are deterministic, and budget-related failures are *informative* — they mean the YAML needs to change, and they tell you exactly where.

**Self-tune path (smart fallback).** A hard cap risks "fails forever until human bumps it." Two telemetry layers handle this without giving the orchestrator widening back:
- **Cap-hit recording.** When the SDK throws `Reached maximum number of turns (N)`, write structured `capHit: true, observedTurns, allowedTurns` onto the phase checkpoint.
- **Phase-budget advisor (optional follow-up).** A cheap non-LLM daily task scans `agent_runs.checkpoints` for cap-hits, computes p95 turns from successful runs of the same phase, and emits a notification — "extract hit cap 3× in 24h; p95 of successful runs was 47 turns; suggest bump to 55" — with a one-click apply to `grove.yaml` taskOverrides. The system observes its own pain and surfaces the action; the human still approves the change.

---

## Pattern 4: Mechanical Pre-Filter Before LLM Spend

**Problem.** Every LLM-decided "is there work to do here?" is paid for with turns. If the answer is "no" 80% of the time, you've spent 80% of that phase's budget on a check that could have been a SQL query.

**Rule.** Each multi-item phase has a **deterministic pre-filter** that runs before any LLM turn:
- "Are there N+ unprocessed-human batches whose oldest is at least M minutes old?" → SQL.
- "Have K+ new spores accumulated since the last consolidate-write?" → SQL.
- "Has the digest cursor moved by ≥X spores since the last digest rotation?" → SQL.

The LLM phase only validates and acts on the mechanical signals. It does not *discover* whether there is work — that's wasted spend.

**Reference implementation.** `skill-evolve`'s inventory phase computes narrow-skill and overlap-pair candidates via heading counts and similarity matching in deterministic code; the LLM validates the shortlist. The same pattern generalizes to any multi-item intelligence phase.

---

## Pattern 5: Per-Stage preConditions, Not Just Task-Level

**Problem.** A task-level `preCondition: has-unprocessed-batches` decides whether the *whole task* runs. But a multi-stage task has multiple kinds of work: extract has its own trigger (new batches), consolidate has its own (new spores), digest has its own (cursor movement). A single preCondition forces every stage to run any time *any* stage has work — and downstream stages then waste turns discovering "nothing for me to do."

**Rule.** Each phase carries its own preCondition. The phase is skipped entirely (no LLM call, no `vault_report`) if its preCondition is false. Phases also self-skip in their prompts as belt-and-suspenders, but the preCondition does the structural gating.

**New preCondition kinds to add when a new stage needs one.** Add to `agent.PreConditionKind`, wire the resolver in `task-scheduling.ts`, document the SQL it runs. Keep them cheap — preConditions run on every scheduler tick.

---

## Pattern 6: Tier-Not-Model Phase Routing

**Problem.** Specifying `model: sonnet` in a phase ties it to one Anthropic SKU. The provider's `reasoning_map` exists precisely so phase YAML can say "I need cheap-tier reasoning" without committing to a specific model — the operator picks the model.

**Rule.** Phases specify `reasoningLevel: low | default | high`. They do NOT specify `model:`. The provider's `reasoning_map` resolves the level to a model at run-time. This keeps the YAML portable across model upgrades, model swaps (sonnet 4.6 → 4.7), and runtime swaps (anthropic → ollama for cost experiments).

**Cost mapping rule of thumb (Anthropic):**
- `low` → haiku-class. ~5–10× cheaper per token than sonnet. Use for: retrieval, shortlist construction, mechanical decisions over structured data, deterministic transformations, anywhere the LLM is a parser more than a thinker.
- `default` → sonnet-class. Use for: judgment, synthesis, wisdom writing, multi-evidence reasoning.
- `high` → opus-class. Use sparingly; reserve for the few phases where opus-grade reasoning materially changes the output quality.

---

## Pattern 7: Phase-Split for Cheap-Search + Expensive-Write

**Problem.** A phase that does "find candidates → think hard → write the result" pays for the expensive tier across the entire turn budget, even though the search portion only needs cheap-tier reasoning.

**Rule.** Split the phase. The shortlist/search portion runs at `reasoningLevel: low` (haiku), passes structured output via `dependsOn`, and the synthesis/write portion runs at `reasoningLevel: default` (sonnet) on a much smaller turn budget. Typical split: 60% of original turns at low tier, 30% at default tier, 10% saved.

**Reference applied here.** Vault-evolve's `consolidate` phase split into:
- `consolidate-shortlist` (low) — semantic search, ID enumeration, dedup against existing.
- `consolidate-write` (default) — wisdom synthesis, supersede actions.

**Per-turn cost matters.** Sonnet costs ~5× haiku per token. A 25-turn sonnet phase costs roughly the same as a 100-turn haiku phase, but the haiku phase can do far more search work. Match the tier to the *kind* of work, not the *amount*.

---

## Pattern 8: Per-Run Work Caps

**Problem.** A task with a 35-turn extract phase facing a 300-batch backlog will burn the full budget on one run, then face a 250-batch backlog on the next run. Without a per-run work cap, worst-case spend scales with backlog size.

**Rule.** Multi-item phases declare a `max_items_per_run` parameter (e.g., `max_batches_per_run: 80`). The phase prompt instructs the LLM to stop after that many items even if budget remains. This bounds the worst case regardless of backlog and makes runs predictable. Skill-evolve uses `max_skills_per_run: 3` for the same reason.

**Companion rule.** Combine with the accelerator: when the work cap and the queue meet, you get a sensible drain rate (8 runs/day × 80 batches = 640 batches/day drained, which exceeds typical input rates).

---

## Pattern 9: Output Discipline in Phase Prompts

**Problem.** Output tokens often dominate phase cost because they're not cached. A phase prompt that says nothing about output length will produce 2,000-token phase summaries even when the actual decision was three words.

**Rule.** Every phase prompt ends with an explicit output cap: "Final summary MUST be ≤ N lines / ≤ N tokens." For phases whose output is purely status (skip, complete with count), the cap should be 2 lines. For phases whose output is the next phase's input (digest-assess → digest-write), the cap is whatever the next phase needs — no more.

**Cheap and overlooked.** This pattern alone often shaves 20–30% of output tokens with no functional impact. Worth retrofitting into existing phase prompts during any cost pass.

---

## Authoring Checklist for a New Phased Task

Before merging a new task YAML, walk this list explicitly:

- [ ] **Origin filter.** Reads only the origins this task actually needs (`human` by default for intelligence tasks).
- [ ] **Schedule.** `intervalSeconds` set; accelerator paired with throughput-sized thresholds and a runs-per-24h ceiling.
- [ ] **Task preCondition.** Cheap SQL gate that short-circuits the whole task when there's no work.
- [ ] **Per-phase preConditions.** Each multi-stage phase has its own gate; phases that have no work don't pay for LLM turns.
- [ ] **Reasoning tiers.** Phases say `reasoningLevel:`, never `model:`. Low tier for retrieval and mechanical work; default for judgment; high reserved.
- [ ] **Phase split.** Anywhere a phase does cheap-search + expensive-write, the two are separate phases on different tiers.
- [ ] **Per-run work cap.** Multi-item phases declare `max_items_per_run` in their `parameters`.
- [ ] **Output discipline.** Every phase prompt ends with an explicit output-length cap.
- [ ] **Orchestrator awareness.** YAML budgets are the spec; the orchestrator can only narrow them.
- [ ] **Required-vs-optional discipline.** Every `required: false` phase has its skip-condition knowable from pre-planning context. Phases whose work depends on a prior in-run phase's output are `required: true` (see Pattern 2b).
- [ ] **Audit plan.** After shipping, the task's actual cost is measurable via `agent_runs.actual_cost_usd` and per-phase breakdown via `agent_runs.checkpoints`. Capture a wisdom spore with the calibrated numbers.

---

## Auditing an Existing Task's Cost

When asked to "tune this task" or "why is X expensive," follow this loop:

1. **Pull the last 20 runs from the relevant Grove DB:**
   ```bash
   sqlite3 ~/.myco/groves/<grove>/myco.db \
     "SELECT id, status, started_at, completed_at, actual_cost_usd, tokens_used, error
      FROM agent_runs WHERE task='<name>' ORDER BY started_at DESC LIMIT 20;"
   ```
2. **Decompose the most expensive run into per-phase turns + cost** from `checkpoints` JSON. Identify which phase is the cost driver — almost always one phase dominates.
3. **Check for orchestrator widening.** Compare per-phase `turnsUsed` against the YAML `maxTurns`. If `turnsUsed > maxTurns` for any phase, the orchestrator is widening (or the cap isn't enforced) — fix that first.
4. **Check for `capHit` events** on failed runs. Cap-hits at the YAML budget mean the budget is too low; cap-hits well above the YAML budget mean orchestrator widening produced runaway runs.
5. **Check cadence.** `runs / time_window` vs the YAML `intervalSeconds`. If they don't match, the accelerator is firing — check its thresholds against actual throughput.
6. **Map each finding to a pattern above.** If a finding doesn't fit a pattern, write a new pattern at the end of this skill. Patterns are how the discipline compounds.

The goal isn't a single fix; it's a measured before/after with the wisdom spore capturing what moved and by how much.
