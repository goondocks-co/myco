---
type: Subsystem
title: Cortex — Session-Start Guidance
description: How Cortex generates and injects session-start guidance — stored instructions, digest excerpts, and the config/feature-gating decisions behind them.
timestamp: '2026-07-08T16:22:59.000Z'
---

Cortex is Myco's outbound counterpart to [session capture](/architecture/session-capture-flow.md): where capture pulls raw activity *into* the vault, Cortex pushes distilled project knowledge *back out* to a symbiont at the moment a new session starts. It answers the question "what should this agent already know before it takes its first action?" — tool recall (`myco_search`, `canopy_map()`, `myco_plans`), recent workstreams, and (optionally) a digest excerpt.

Cortex was deliberately designed as a **first-class, task-backed** feature, not an on-the-fly compiler. Per wisdom spore `dd6bf7fa`, the architecture decision locked into session `019d9c0a` established two independent delivery systems:

- **Session-start injection** — an operating brief served once, at session initialization.
- **Prompt-submit / prompt builder** — a separate `cortex-prompt-builder` task path for symbionts that lack native session-start support.

Instructions are *generated ahead of time* by the `cortex-instructions` agent task (defined in `packages/myco/src/agent/definitions/tasks/cortex-instructions.yaml`, itself run by Myco's agent harness) and stored as a durable artifact. They are refreshed on a schedule or by explicit user action — never recompiled per-request. This mirrors how the digest is treated: `myco_context` pulls it on demand rather than force-injecting it into every session.

## Request-time flow

A symbiont's session-start hook calls the daemon's `/context` route, handled by `createSessionContextHandler` in `packages/myco/src/daemon/api/context.ts`. The handler:

1. Resolves tenant config via `resolveTenantConfig` — Cortex settings are grove/project-tier, so the request's own tenancy is used rather than the daemon's bootstrap-home `liveConfig`.
2. Gates on the coarse `cortex` capability (`capabilityEnabled(config, 'cortex')`) — a single kill switch that suppresses all session-start injection regardless of sub-toggle state.
3. Checks `shouldInjectCortex(config)` (in `packages/myco/src/context/cortex-brief.ts`) and `shouldInjectSessionStartDigest(config.cortex.digest)`. If both are off, it returns `{ text: '' }` immediately.
4. If cortex injection is enabled, fetches the stored artifact via `getCortexInstructionsSnapshot(config, scope)` — never regenerates it inline.
5. Hands the resolved config, fetched instruction content, and scope to `composeSessionStartContext` (`packages/myco/src/context/session-start-context.ts`), which composes the cortex and digest parts into one ordered text block and reports back which parts actually contributed (for logging/attribution).
6. Appends branch/session metadata and returns the composed text.

`session-start-context.ts` is intentionally thin: it exists only so the heading format and the `\n\n` join between parts have one source of truth, shared between the daemon's live `/context` path and any degraded fallback path that reads cortex content itself.

The instruction text itself is wrapped by `composeCortexInstructionInjection` in `packages/myco/src/context/cortex-injection-context.ts`. This module enforces that **the managed Cortex artifact remains the single source of truth** — event-specific injection surfaces (`session-start` vs `subagent-start`) may wrap it with a small stable frame (e.g. `SUBAGENT_CORTEX_GUIDANCE` telling a delegated subagent to defer orchestration to its parent, or `CLI_TOOL_TRANSPORT_DIRECTIVE` telling a CLI-only symbiont how to invoke `myco_*` tools via shell) but must not fork their own instruction content.

## The daemon API surface (`daemon/api/cortex.ts`)

Separate from the `/context` session-start route, `packages/myco/src/daemon/api/cortex.ts` exposes the Cortex management surface consumed by the UI's Cortex page:

- `handleGetInstructions` — returns the current stored snapshot (`getCortexInstructionsSnapshot`) for display.
- `handleRefreshInstructions` — fire-and-forget triggers the `cortex-instructions` task via `triggerCortexInstructions` (in `packages/myco/src/daemon/cortex.ts`), the "run now" path used by the page's manual refresh action. It fails loud with `provider-not-configured` or `event-tasks-disabled` (HTTP 400) rather than silently no-op-ing.
- `handleBuildPrompt` / `handleGetPromptResult` — drive the prompt-builder path (`buildCortexPrompt`), which resolves a target symbiont, resolves its delivery contract (inline instructions vs. reference), and dispatches a `cortex-prompt-builder` run.

Both `triggerCortexInstructions` and `buildCortexPrompt` resolve config through `resolveCortexTenantConfig`, deliberately mirroring how the actual agent run resolves provider config (`resolveRunConfig` → `loadMergedConfig(vaultDir, { groveId })`) so the gate that decides *whether* to start a run and the run itself agree on the same tenant.

## Config schema and feature gating (spore `360b5ed8`)

A wisdom spore synthesized from three decision spores (`b1c5b976`, `9f199f24`, `23f7c6d3`, session `b8a86bbf`) records three concrete quality fixes behind the current Cortex config shape:

**1. Unified `cortex.*` config root, `inject_on_<event>` vocabulary.** Injection settings used to be scattered — some under `context.*`, some under `cortex.canopy.injection.*`, some under a root `canopy:` key — so no single `grep` could reveal every way Cortex injects. The fix restructures everything under `cortex.*`, grouped by feature (`instructions`, `digest`, `spores`, `canopy`), each with an `inject_on_<event>` toggle (e.g. `inject_on_session_start`, `inject_on_prompt_submit`, `inject_on_pre_tool_use`) and tuning knobs living beside their toggle (`max_per_prompt` next to `inject_on_prompt_submit`). `cortex.enabled` is a whole-layer kill switch layered on top of the per-event toggles — exactly the two-tier gate visible in `context.ts`'s `capabilityEnabled(config, 'cortex')` check followed by the finer `shouldInjectCortex`/`shouldInjectSessionStartDigest` checks.

**2. Feature-gated tool mentions.** The generated instructions only tell an agent to call `canopy_map()` if a populated Canopy map actually exists (`canopy_maps` row present and `is_empty = 0`). Earlier versions unconditionally instructed "call `canopy_map()` first," which on a fresh project meant agents called an empty tool, lost trust in it, and stopped using it. The generalized principle: only document a tool as available when it is configured, enabled, and non-empty — a pattern that extends beyond Canopy to any tool mention in generated guidance.

**3. Last-section primacy for behavior priming.** Instructions are deliberately ordered identity → retrieval tools → plan persistence → recent workstreams (background) → `myco_remember` call-to-action, *last*. The rationale: the last section read leaves the freshest impression on agent behavior, so the closing section should be a directive ("capture discoveries via `myco_remember`") rather than background reference data. "Current workstreams" was also reworded to "Recent workstreams... in case your task overlaps" specifically to stop models from treating listed sessions as an action agenda rather than context.

A companion wisdom spore (`dd6bf7fa`) records a related prompt-engineering gotcha in the `cortex-instructions` task itself: the task-level `taskOverview` prompt (injected into every phase by `composePhasePrompt()`) dominated smaller models' framing, causing the research phase to skip vault tool calls (`vault_search_fts`, `vault_spores`) entirely and instead draft polished markdown prematurely. The fix narrowed the task-level prompt to strategic intent only, moved output-format demands into the phase-specific prompts, and made the author phase require a "Current workstreams" section citing a real plan/session by title (or the literal string "No active workstreams").

## Open questions

Hotspot ranking (which files/workstreams surface in the generated brief and how often the underlying data is recomputed) is not established by the sources read for this page — the `cortex-instructions` task's research-phase spore inputs (3 wisdom + 3 decision + 3 discovery spores per `dd6bf7fa`) and its `intervalSeconds: 14400` schedule (`runIn: [idle, sleep]`, never during an active session) are documented, but the ranking algorithm itself lives in code this page's sources did not cover in depth. Similarly, the rollout completeness of the `cortex.*` config migration (Config Migration v28, mentioned in `360b5ed8`) across all 22 read-site files is asserted by the spore but not independently re-verified here.

# Citations

- `packages/myco/src/daemon/api/cortex.ts` — Cortex management HTTP handlers (get/refresh instructions, prompt builder)
- `packages/myco/src/daemon/api/context.ts` — `/context` session-start handler, capability + toggle gating
- `packages/myco/src/context/cortex-injection-context.ts` — shared instruction-wrapping composition, single-source-of-truth rule
- `packages/myco/src/context/session-start-context.ts` — cortex + digest part composition for session start
- `packages/myco/src/daemon/cortex.ts` — `getCortexInstructionsSnapshot`, `triggerCortexInstructions`, `buildCortexPrompt`, tenant config resolution
- `packages/myco/src/agent/definitions/tasks/cortex-instructions.yaml` (Canopy summary) — the task that generates the stored instruction artifact
- Spore `360b5ed8` (wisdom, importance 9) — config schema unification, feature-gated tool mentions, section-ordering for behavior priming
- Spore `dd6bf7fa` (wisdom, importance 9) — Cortex architecture decision, task redesign, `taskOverview` prompt-leak gotcha, UI reference
