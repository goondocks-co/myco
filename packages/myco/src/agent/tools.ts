/**
 * Vault MCP tool server for the agent.
 *
 * Creates vault tools that expose SQLite query helpers to the agent
 * via the Claude Agent SDK. Tools are grouped into:
 * - Read tools (11): vault_unprocessed, vault_batches, vault_session_summary_material,
 *                   vault_spores, vault_sessions, vault_search_fts,
 *                   vault_search_semantic, vault_search_canopy, vault_release_state,
 *                   vault_state, vault_edges
 * - Write tools (7): vault_create_spore, vault_resolve_spore, vault_update_session,
 *                    vault_set_state, vault_read_digest, vault_write_digest,
 *                    vault_mark_processed
 * - Observability (1): vault_report
 * - Skill tools (11): vault_skill_survey_prepare,
 *                    vault_skill_survey_bundle_decisions,
 *                    vault_skill_survey_reconciliation_plan,
 *                    vault_skill_survey_apply_reconciliation,
 *                    vault_skill_candidates, vault_skill_records,
 *                    vault_scan_skill_contamination, vault_write_skill,
 *                    vault_stage_skill, vault_finalize_skill,
 *                    vault_edit_skill
 * - Canopy tools (4): canopy_describe_next, canopy_describe_write,
 *                    canopy_list, canopy_describe_charge
 *
 * `agentId` and `runId` are captured in closures — tools inject them
 * automatically so the agent cannot impersonate another agent.
 */

import crypto from 'node:crypto';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { insertTurn, updateTurn } from '@myco/db/queries/turns.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { notify } from '@myco/notifications/notify.js';
import { classifyWriteIntent } from './write-classifier.js';
import type { ClassifyWriteIntentResult } from './write-classifier.js';
import { createReadTools } from './tools/read-tools.js';
import { createWriteTools } from './tools/write-tools.js';
import { createObservabilityTools } from './tools/observability-tools.js';
import { createPhaseMetadataTools, PHASE_METADATA_TOOL_NAMES } from './tools/phase-metadata-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import { createExplorationTools } from './tools/exploration-tools.js';
import { createCanopyTools } from './tools/canopy-tools.js';
import { applyDeferredStubs, buildSearchToolsTool } from './tools/deferred-tools.js';
import { textResult, toSdkMcpToolDefinitions } from './tools/types.js';
import {
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  OBSERVABILITY_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  EXPLORATION_TOOL_NAMES,
  CANOPY_TOOL_NAMES,
} from './tool-names.js';
import { errorMessage } from '@myco/utils/error-message.js';
import type { MycoToolDefinition, VaultToolDeps } from './tools/types.js';
import type { AgentEmbeddingPort } from '@myco/agent/runtime/ports.js';
import { rowProjectIdFromRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';
import type { HarnessHooks, HarnessHookContext } from './harness/hooks.js';
import type { HarnessId, ProviderConfig, ReasoningLevel, RunLogger } from '@myco/agent/types.js';
import type { FlaggedWriteAccumulator } from './harness/types.js';

// Re-exports for backward compatibility
export { validateSkillContent, MAX_SKILL_LINES, REQUIRED_FRONTMATTER_FIELDS } from './tools/skill-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Options for createVaultTools beyond the required agentId and runId. */
export interface VaultToolOptions {
  turnOffset?: number;
  embeddingManager?: AgentEmbeddingPort;
  machineId?: string;
  projectRoot?: string;
  vaultDir?: string;
  requestContext?: MycoRequestContext;
  /**
   * When true, every vault-mutating tool (except the documented
   * exceptions below) is wrapped in a dry-run interceptor that records
   * the write intent to `agent_run_write_intents` and returns a
   * synthetic success payload instead of performing the real write.
   *
   * Exceptions (still run for real in dry-run):
   *   - vault_report — observability, not a vault mutation
   *   - vault_stage_skill — writes to .myco/staging/ only, which is
   *     already safe and sweepable
   *
   * Blocked entirely in dry-run (returns a dryRunResult ack without
   * running the handler or recording an intent row here — skill-tools
   * handles it in-handler):
   *   - vault_finalize_skill — promotion is a no-op under dry-run
   */
  dryRun?: boolean;
  /**
   * Per-phase metadata accumulator. Passed through to the
   * `phase_emit_metadata` tool's deps so the tool can `set(key, value)`.
   * The phase loop creates a fresh Map per phase and reads it back after
   * `harness.execute()` returns. Absent for any caller outside the
   * phase loop — the tool then no-ops gracefully.
   */
  metadataAccumulator?: Map<string, unknown>;
  /**
   * The calling phase's declared name and prompt excerpt. See
   * HarnessToolSurface.phasePurpose. Threaded straight through to
   * VaultToolDeps for the semantic-check wrapper.
   */
  phasePurpose?: { name: string; promptExcerpt: string };
  /**
   * Enables the semantic-check wrapper for destructiveHint tools. This is
   * the SNAPSHOTTED per-run value from
   * RunOptions.executionOverrides.semanticWriteCheckEnabled (Task 2b) —
   * never re-read from live myco.yaml on a resumed run.
   */
  semanticCheckEnabled?: boolean;
  /** Harness id to run the classifier call against — same harness the phase itself uses. */
  harnessId?: HarnessId;
  /** Fallback model for the classifier call if the provider has no matching reasoningMap entry. */
  model?: string;
  /**
   * Reasoning tier for the classifier call. Snapshotted per-run from
   * RunOptions.executionOverrides.classifierReasoningLevel (Task 2b),
   * defaulting to 'low' — never a hardcoded literal inside the wrapper
   * or inside write-classifier.ts.
   */
  classifierReasoningLevel?: ReasoningLevel;
  /**
   * The calling phase's resolved provider config, passed straight through
   * to `classifyWriteIntent()`. Without this the classifier always builds
   * its harness call against the DEFAULT provider env — on a
   * provider-override setup (Ollama/custom baseURL) that errors and the
   * classifier permanently fails open for the run, and any provider
   * `reasoningMap` entry (a cheaper model for the classifier tier) is
   * silently unreachable. See HarnessToolSurface.provider.
   */
  provider?: ProviderConfig;
  /**
   * Per-phase accumulator for flagged (blocked) destructive writes. When
   * present, `wrapToolWithSemanticCheck` appends one record per flag
   * verdict instead of relying solely on the thrown error to signal
   * failure — the SDK converts a tool handler's throw into an `isError`
   * tool result returned to the MODEL, so `executePhase`'s try/catch
   * around `harness.execute()` never observes it on its own. Absent for
   * any caller outside the phase loop (single-query, map-phase items) —
   * the wrapper still throws in that case, it just can't also record.
   */
  flaggedWritesAccumulator?: FlaggedWriteAccumulator;
  /**
   * Tool names to mark `deferrable: true` before the deferred-loading pass
   * runs. Names outside the tool set this call actually builds (e.g. a
   * name not in `onlyNames`) are silently ignored — deferral only ever
   * narrows within the already-scoped set, never widens it. See
   * docs/superpowers/specs/2026-07-01-tool-discovery-at-scale-design.md §3.3.
   */
  deferredNames?: Set<string>;
  /**
   * Harness-neutral lifecycle hooks. When both `hooks` and `hookContext`
   * are supplied, `wrapToolWithAudit` emits `preToolUse` before every tool
   * handler call and `postToolUse` (with outcome) after. Absent by
   * default — existing callers that don't pass these get byte-identical
   * behavior to before hook support was added.
   */
  hooks?: HarnessHooks;
  /**
   * Static per-run/per-phase identity attached to every emitted hook
   * event. Hook emission is a no-op unless this is present — `hooks`
   * alone (without `hookContext`) never fires.
   */
  hookContext?: HarnessHookContext;
  /**
   * Run logger for tool-level diagnostics. Threaded through so
   * `wrapToolWithSemanticCheck` can emit one `agent.write.classified`
   * line per rendered verdict (see HarnessToolSurface.logger for the
   * full threading path from `HarnessExecuteInput.logger`). Optional —
   * absent for any caller that doesn't pass one; every call site uses
   * `logger?.info(...)` so absence never throws.
   */
  logger?: RunLogger;
}

/**
 * Tool names that MUST NOT be intercepted by the central dry-run wrapper.
 *
 *  - vault_report: observability. We want real report rows so operators
 *    can read the dry-run's self-narration after the fact.
 *  - vault_stage_skill: writes to .myco/staging/skills/<id>/ only. The
 *    staging dir is already designed to be sweepable and is never
 *    promoted unless vault_finalize_skill runs — which is itself blocked
 *    in dry-run.
 *  - vault_finalize_skill: blocked inside the handler via `deps.dryRun`
 *    in skill-tools.ts (returns a dryRunResult without promoting). The
 *    handler owns this because promotion is a multi-step cross-cutting
 *    operation (disk + DB + symlinks + notifications) that can't be
 *    expressed by the generic interceptor's synthetic-payload shape.
 *    Exempting it here lets the in-handler short-circuit run.
 */
const DRY_RUN_EXEMPT_TOOLS = new Set<string>([
  'vault_report',
  'vault_stage_skill',
  'vault_finalize_skill',
]);

/**
 * Tools that mint an id when they write to the live tables. In dry-run
 * the interceptor creates a synthetic `dry-run:<uuid>` id, records it
 * in a per-closure stub map, and stitches it into the synthetic output
 * so downstream tool calls that reference the id keep working.
 *
 * `buildSynthetic` receives the validated args plus `agentId` + `now`
 * (epoch seconds) and returns the object that will be JSON-serialised
 * as the tool response payload. The shape MUST match what the real
 * handler would have returned on success.
 */
interface StubToolSpec {
  /** Arg name on the input side that (if set) should be recorded as the
   * "referring" stub — only used by `vault_resolve_spore` right now. */
  stubLookupField?: string;
  buildSynthetic: (args: Record<string, unknown>, stubId: string, agentId: string, now: number) => object;
}

const DRY_RUN_STUB_TOOLS = new Map<string, StubToolSpec>([
  ['vault_create_spore', {
    buildSynthetic: (args, stubId, agentId, now) => ({
      id: stubId,
      agent_id: agentId,
      observation_type: args.observation_type,
      content: args.content,
      session_id: args.session_id ?? null,
      prompt_batch_id: args.prompt_batch_id ?? null,
      importance: args.importance ?? 5,
      tags: args.tags ? JSON.stringify(args.tags) : null,
      context: args.context ?? null,
      file_path: args.file_path ?? null,
      properties: args.properties ?? null,
      status: 'active',
      created_at: now,
    }),
  }],
  ['vault_create_entity', {
    buildSynthetic: (args, stubId, agentId, now) => ({
      id: stubId,
      agent_id: agentId,
      type: args.type,
      name: args.name,
      properties: args.properties ? JSON.stringify(args.properties) : null,
      first_seen: now,
      last_seen: now,
    }),
  }],
  ['vault_create_edge', {
    buildSynthetic: (args, stubId, agentId, now) => ({
      id: stubId,
      agent_id: agentId,
      source_id: args.source_id,
      source_type: args.source_type,
      target_id: args.target_id,
      target_type: args.target_type,
      type: args.type,
      session_id: args.session_id ?? null,
      confidence: args.confidence ?? 1.0,
      properties: args.properties ? JSON.stringify(args.properties) : null,
      created_at: now,
    }),
  }],
]);

// ---------------------------------------------------------------------------
// Tool definitions factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool group membership — used to skip factory calls for unneeded groups
// ---------------------------------------------------------------------------
//
// The name-set literals live in tool-names.ts (zero-dep leaf module — see
// its header comment) so schemas.ts can validate task-level `deferredTools`
// against the full registry without pulling tools.ts's bun:sqlite-adjacent
// dependency chain into codegen. This file is the only place they're
// composed into factory-skipping Sets; import from tool-names.ts rather
// than redeclaring a set literal here.

const PHASE_METADATA_TOOL_NAMES_SET = new Set<string>(PHASE_METADATA_TOOL_NAMES);

/** Max chars stored from a tool response in the run audit trail. */
const TOOL_OUTPUT_SUMMARY_LIMIT = 240;
/** Read tools that can explode context if the agent loops on identical payloads. */
const LOOP_GUARDED_READ_TOOL_NAMES = new Set([
  'vault_unprocessed',
  'vault_batches',
  'vault_session_summary_material',
  'vault_spores',
  'vault_sessions',
  'vault_edges',
]);
/** On the third identical guarded read, stop resending the large payload and tell the agent to reuse prior context. */
const REPEATED_READ_SUPPRESSION_THRESHOLD = 2;
/** On the fifth identical guarded read, fail fast — the run is not making progress. */
const REPEATED_READ_FAILURE_THRESHOLD = 4;

/**
 * Cap on DISTINCT (toolName + args) semantic-check flags per phase. Counts
 * unique blocked calls, not total attempts — a retry of the SAME blocked
 * call is served from FLAGGED_VERDICT_CACHE and never counts against this
 * cap. Once a phase has accumulated this many distinct flagged attempts,
 * every subsequent destructiveHint call short-circuits straight to
 * 'blocked' with no classifier round-trip — a probing model that keeps
 * varying its arguments to find one the classifier lets through must not
 * be able to burn the phase's entire turn budget on classifier calls.
 */
const SEMANTIC_CHECK_DISTINCT_FLAG_CAP = 3;

/**
 * Total number of vault tools defined. Derived from the union of the
 * six tool-group sets above so this constant can never drift from the
 * actual factory output — adding a tool to a group bumps the count
 * automatically. Each set is disjoint so the straight sum is correct.
 * Do not hardcode this number in specs/docs — read VAULT_TOOL_COUNT or
 * re-derive it; the source of truth drifts every time a tool file gains
 * an entry.
 */
export const VAULT_TOOL_COUNT =
  READ_TOOL_NAMES.size +
  WRITE_TOOL_NAMES.size +
  OBSERVABILITY_TOOL_NAMES.size +
  SKILL_TOOL_NAMES.size +
  EXPLORATION_TOOL_NAMES.size +
  CANOPY_TOOL_NAMES.size +
  PHASE_METADATA_TOOL_NAMES_SET.size;

function setsOverlap(a: Set<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) { if (b.has(item)) return true; }
  return false;
}

/**
 * Deterministic JSON serialization with object keys sorted recursively, so
 * two structurally-identical tool-call args objects always produce the same
 * string regardless of key insertion order. Used to key the semantic-check
 * verdict cache — a retry of an identical blocked call must be recognized
 * as identical even if the model re-emits the same args with different key
 * ordering (some SDKs / models don't guarantee stable JSON key order).
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function truncateSummary(text: string | null): string | null {
  if (!text) return null;
  return text.length > TOOL_OUTPUT_SUMMARY_LIMIT
    ? `${text.slice(0, TOOL_OUTPUT_SUMMARY_LIMIT - 1)}…`
    : text;
}

/** Prefix on tool_output_summary rows that represent a tool error — either a
 *  handler exception or a `textResult({ error })` return. Queryable via
 *  `WHERE tool_output_summary LIKE '[ERROR]%'` to surface silent no-ops. */
const TOOL_ERROR_PREFIX = '[ERROR] ';

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return false;
  const trimmed = first.text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return !!parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error !== undefined;
  } catch {
    return false;
  }
}

function summarizeToolResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return null;
  const body = first.text.replace(/\s+/g, ' ').trim();
  const prefix = isErrorResult(result) ? TOOL_ERROR_PREFIX : '';
  return truncateSummary(prefix + body);
}

function summarizeToolError(error: unknown): string {
  return truncateSummary(TOOL_ERROR_PREFIX + errorMessage(error)) ?? TOOL_ERROR_PREFIX + 'Tool failed';
}

function buildRepeatedReadSuppressionResult(
  toolName: string,
  repeatedCalls: number,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        message: `Repeated identical ${toolName} read suppressed.`,
        repeated_calls: repeatedCalls,
        reuse_prior_result: true,
        next_step: 'Use the prior tool result already in context and continue with analysis, write, or report.',
      }),
    }],
  };
}

function shouldGuardRepeatedRead(toolDef: MycoToolDefinition<any>): boolean {
  return toolDef.annotations?.readOnlyHint === true && LOOP_GUARDED_READ_TOOL_NAMES.has(toolDef.name);
}

/**
 * Create vault tool definitions for the agent.
 *
 * When `onlyNames` is provided, only tool groups that contain at least one
 * requested name are instantiated — avoids building all tool closures when
 * a phase only needs 2-3 tools.
 *
 * Exposed for testing (call handler directly) and for the MCP server factory.
 */
export function createVaultTools(agentId: string, runId: string, options?: VaultToolOptions & { onlyNames?: Set<string> }) {
  const {
    turnOffset = 0,
    embeddingManager,
    machineId,
    projectRoot,
    vaultDir,
    requestContext,
    dryRun,
    metadataAccumulator,
    phasePurpose,
    semanticCheckEnabled,
    harnessId,
    model,
    classifierReasoningLevel,
    provider,
    flaggedWritesAccumulator,
    onlyNames,
    deferredNames,
    hooks,
    hookContext,
    logger,
  } = options ?? {};
  const projectId = rowProjectIdFromRequestContext(requestContext);

  /** Turn number counter — incremented per tool call (read and write) within a run. */
  let turnCounter = turnOffset;
  /** Exact-read loop counters for the current tool server instance. */
  const repeatedReadCounts = new Map<string, number>();
  /**
   * In-memory stub-id map for dry-run mode. Every time the interceptor
   * mints a `dry-run:<uuid>` id, it records the synthetic row keyed by
   * the stub id. Downstream tools that reference ids (today only
   * `vault_resolve_spore` via `spore_id`) look up the map first so the
   * dry-run remains coherent across a chain of tool calls.
   *
   * Lives in the closure alongside `turnCounter` — identical lifetime.
   *
   * KNOWN LIMITATION — per-phase only: this map is scoped to a single
   * `createVaultTools` call, which means it's recreated for every phase
   * (see `createScopedVaultToolServer`). A stub id minted in phase A
   * cannot be resolved in phase B — the phase-B closure starts with an
   * empty map and any lookup falls through to the "stub miss" generic
   * ack path in `vault_resolve_spore`. Cross-phase stub resolution would
   * require lifting the map to a module-level run-keyed registry with
   * explicit cleanup on run end; not done today because phase A writes
   * are rarely referenced by phase B reads/writes in practice.
   */
  const dryRunStubs = new Map<string, { tool: string; args: unknown; syntheticRow: unknown }>();

  /**
   * Semantic-check verdict cache, keyed by `${toolName} ${stableSerialize(args)}`.
   * Scoped to this `createVaultTools` call — same per-phase lifetime as
   * `dryRunStubs` above. A retry of an identical blocked call (a model
   * re-attempting the same destructive write after the classifier flagged
   * it) is served from here instead of paying a fresh classifier round
   * trip, and does not record a second write-intent row or fire a second
   * notification — see `wrapToolWithSemanticCheck`.
   */
  const semanticCheckVerdictCache = new Map<string, ClassifyWriteIntentResult>();

  /**
   * Count of DISTINCT flagged (toolName, args) pairs this phase has
   * accumulated — a strict subset of `semanticCheckVerdictCache`'s entries
   * (which also caches 'ok' verdicts). Tracked separately so an 'ok'-heavy
   * phase doesn't spuriously eat into the distinct-flag cap; only actual
   * flags count against `SEMANTIC_CHECK_DISTINCT_FLAG_CAP`.
   */
  let distinctFlagCount = 0;

  /**
   * Cache keys already recorded into `flaggedWritesAccumulator`. Every
   * retry of a blocked call still throws (the model must see the block
   * every time), but a CACHED retry (same cacheKey) must not push a
   * second entry onto the accumulator — otherwise the phase-failure
   * summary's write count inflates with retry attempts instead of
   * reflecting distinct blocked writes. The write-intent row and
   * notification are already deduped independently (only the FIRST
   * classification of a given cacheKey inserts/notifies); this set
   * mirrors that same "first occurrence only" rule for the accumulator.
   */
  const flaggedAccumulatorKeys = new Set<string>();

  /**
   * Record a turn in the audit trail.
   * Called for ALL tool invocations (read and write) for full visibility.
   * Fire-and-forget — does not block the tool response.
   */
  function recordTurn(toolName: string, toolInput: unknown): number | null {
    turnCounter++;
    try {
      const turn = insertTurn({
        run_id: runId,
        project_id: projectId,
        agent_id: agentId,
        turn_number: turnCounter,
        tool_name: toolName,
        tool_input: JSON.stringify(toolInput),
        started_at: epochSeconds(),
      });
      return turn.id;
    } catch {
      /* audit trail is best-effort */
      return null;
    }
  }

  const deps: VaultToolDeps = {
    agentId,
    runId,
    embeddingManager,
    machineId: machineId ?? requestContext?.machineId,
    projectRoot,
    vaultDir,
    requestContext,
    dryRun,
    recordTurn,
    metadataAccumulator,
    phasePurpose,
  };

  // When onlyNames is provided, skip factory calls for groups with no overlap
  const needsAll = !onlyNames;
  const tools = [
    ...(needsAll || setsOverlap(onlyNames!, READ_TOOL_NAMES) ? createReadTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, WRITE_TOOL_NAMES) ? createWriteTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, OBSERVABILITY_TOOL_NAMES) ? createObservabilityTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, SKILL_TOOL_NAMES) ? createSkillTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, EXPLORATION_TOOL_NAMES) ? createExplorationTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, CANOPY_TOOL_NAMES) ? createCanopyTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, PHASE_METADATA_TOOL_NAMES_SET) ? createPhaseMetadataTools(deps) : []),
  ];

  const wrapped: MycoToolDefinition<any>[] = tools.map((toolDef) => {
    const typed = toolDef as MycoToolDefinition<any>;
    // Wrapper order: dry-run interceptor first (it fully replaces the
    // handler and never calls the real one), then the semantic check
    // (only reached for real, non-dry-run writes), then the audit
    // wrapper outermost so every call — intercepted, flagged, or real —
    // gets a turn recorded and participates in preToolUse/postToolUse
    // hook emission exactly like any other tool call.
    //
    // A tool qualifies for dry-run interception when dryRun is on, it is
    // not a read (readOnlyHint !== true), and it is not on the exception
    // list (DRY_RUN_EXEMPT_TOOLS).
    const shouldDryRunIntercept = Boolean(dryRun)
      && typed.annotations?.readOnlyHint !== true
      && !DRY_RUN_EXEMPT_TOOLS.has(typed.name);
    // No tool-specific exemption set here — every destructiveHint tool is
    // in scope for the classifier once the feature is enabled (design
    // spec §2.1). That currently includes vault_resolve_spore,
    // vault_mark_processed, vault_skill_survey_apply_reconciliation, and
    // (since the harness-hygiene annotation sweep) the delete-capable
    // vault_skill_candidates and vault_skill_records — the wrapper reads
    // the live annotation rather than a hardcoded name list, so it never
    // drifts from whichever tools actually carry destructiveHint: true.
    const shouldSemanticCheck = Boolean(semanticCheckEnabled)
      && !shouldDryRunIntercept
      && typed.annotations?.destructiveHint === true;

    let inner = typed;
    if (shouldDryRunIntercept) {
      inner = wrapToolWithDryRun(typed);
    } else if (shouldSemanticCheck) {
      inner = wrapToolWithSemanticCheck(typed);
    }
    const audited = wrapToolWithAudit(inner, hooks, hookContext);
    // Argument normalization is the OUTERMOST wrapper so it runs FIRST on
    // the way in: audit events, dry-run write intents, the semantic-check
    // classifier, and the real handler all see the same normalized args.
    // Ordering matters for the dry-run path in particular — the intent row
    // records the arguments verbatim, and the run-end/phase postconditions
    // validate against that row, so a normalization applied only inside
    // the real handler would leave dry runs validating unstamped payloads.
    return typed.normalizeArgs
      ? wrapToolWithArgNormalization(audited, typed.normalizeArgs)
      : audited;
  });

  // Deferred-loading pass: built from the FULLY WRAPPED tool list so
  // vault_search_tools returns each deferred tool's real (post-wrap)
  // description/schema, and so the meta-tool sees the exact set the
  // harness/model will receive. Runs after audit/dry-run wrapping — the
  // wrappers only replace `handler`, never `description`/`inputSchema`,
  // so ordering here does not affect wrapper behavior in either direction.
  //
  // The synthesized vault_search_tools meta-tool is itself wrapped with
  // wrapToolWithAudit (passing the same hooks/hookContext as every other
  // tool, so it participates in preToolUse/postToolUse emission exactly
  // like a real tool) before being appended — every tool call, including
  // calls to this meta-tool, must produce an agent_turns audit row. It is
  // intentionally NOT passed through wrapToolWithDryRun: it is a pure read
  // (readOnlyHint: true, see Task 2) and is exempt from dry-run interception
  // the same way all other read tools are.
  // deferredNames marks additional tools deferrable on top of whatever a
  // tool factory already set via its own `deferrable` field — task-YAML
  // opt-in (Task 4) layers on top of code-level opt-in (Task 2/3) rather
  // than replacing it. Set.has() against the already-scoped `wrapped`
  // list means a stale/typo'd name silently matches nothing here; the
  // YAML-load-time refine on PhaseDefinitionSchema is what catches that.
  //
  // Scope-leak guard: `onlyNames` only narrows which tool-GROUP factories
  // run (see setsOverlap above) — a group that overlaps `onlyNames` still
  // produces every tool in that group, including ones outside the
  // caller's declared surface. Without intersecting against `onlyNames`
  // here, a factory-level `deferrable: true` tool (or a `deferredNames`
  // entry) that ships in the same group as a requested tool but is itself
  // NOT in `onlyNames` would still feed `buildSearchToolsTool`'s closure —
  // so `vault_search_tools` would disclose its name/description/schema
  // via search results even though the tool itself is correctly excluded
  // from the returned array by the caller's own name-scoping filter
  // (createScopedVaultToolServer / LocalVaultMcpServer). Intersecting
  // here means the closure never captures an out-of-surface tool in the
  // first place — no separate fix needed at either call site.
  const withDeferredFlags = wrapped.map((t) => {
    const requestedDeferral = t.deferrable === true || (deferredNames?.has(t.name) ?? false);
    const inScope = !onlyNames || onlyNames.has(t.name);
    const deferrable = requestedDeferral && inScope;
    if (deferrable) {
      return { ...t, deferrable: true, searchSummary: t.searchSummary ?? t.description };
    }
    // A tool a factory marked `deferrable: true` that falls outside
    // `onlyNames` must have that flag cleared, not just left alone —
    // applyDeferredStubs only checks `t.deferrable === true` (it has no
    // scope awareness of its own), so an unscoped out-of-surface tool
    // would still get stubbed into an unreachable dead stub otherwise.
    return t.deferrable === true ? { ...t, deferrable: false } : t;
  });
  const searchTool = buildSearchToolsTool(withDeferredFlags);
  const withStubs = applyDeferredStubs(withDeferredFlags);
  return (searchTool
    ? [...withStubs, wrapToolWithAudit(searchTool, hooks, hookContext)]
    : withStubs) as typeof tools;

  /**
   * Outermost wrapper for tools that declare `normalizeArgs` (see
   * MycoToolDefinition.normalizeArgs in tools/types.ts): rewrites the
   * incoming arguments deterministically before ANY other consumer —
   * audit events, dry-run write intents, the semantic-check classifier,
   * and the real handler all receive the normalized shape. Fails open to
   * the original args if the normalizer throws — normalization is a
   * correction, never a gate.
   */
  function wrapToolWithArgNormalization(
    toolDef: MycoToolDefinition<any>,
    normalizeArgs: NonNullable<MycoToolDefinition<any>['normalizeArgs']>,
  ): MycoToolDefinition<any> {
    return {
      ...toolDef,
      handler: async (args, extra) => {
        let normalized = args ?? {};
        try {
          normalized = normalizeArgs(normalized, { runId });
        } catch {
          normalized = args ?? {};
        }
        return toolDef.handler(normalized, extra);
      },
    };
  }

  /**
   * Outer wrapper applied only when `dryRun === true` and the tool is a
   * non-exempt write. Intercepts the call, records the intent, mints a
   * stub id for id-producing tools, and returns a synthetic MCP payload
   * WITHOUT calling the original handler.
   *
   * The interceptor never throws from its own bookkeeping (intent insert
   * failures are swallowed, same pattern as recordTurn) — a broken
   * write-intent log must not cascade into tool failures that confuse
   * the dry-run agent.
   */
  function wrapToolWithDryRun(toolDef: MycoToolDefinition<any>): MycoToolDefinition<any> {
    return {
      ...toolDef,
      handler: async (args) => {
        const now = epochSeconds();
        const stubSpec = DRY_RUN_STUB_TOOLS.get(toolDef.name);

        let stubId: string | null = null;
        let syntheticPayload: object;

        if (stubSpec) {
          stubId = `dry-run:${crypto.randomUUID()}`;
          const syntheticRow = stubSpec.buildSynthetic(
            (args ?? {}) as Record<string, unknown>,
            stubId,
            agentId,
            now,
          );
          dryRunStubs.set(stubId, { tool: toolDef.name, args, syntheticRow });
          syntheticPayload = syntheticRow;
        } else if (toolDef.name === 'vault_resolve_spore') {
          // Resolve is a write that doesn't mint an id on its own, but
          // it references a spore_id that MAY be a previously-minted
          // stub. Two cases:
          //   (a) stub hit — return a plausible resolution-event record
          //       with the stubbed spore attached.
          //   (b) stub miss — the agent may be resolving a real live
          //       spore (reads remain live in dry-run), so we still
          //       record the intent and return a generic ack. No throw.
          const sporeIdRaw = (args as { spore_id?: unknown } | undefined)?.spore_id;
          const sporeId = typeof sporeIdRaw === 'string' ? sporeIdRaw : undefined;
          const match = sporeId ? dryRunStubs.get(sporeId) : undefined;
          const eventStubId = `dry-run:${crypto.randomUUID()}`;
          if (match) {
            syntheticPayload = {
              spore: match.syntheticRow,
              resolution_event_id: eventStubId,
            };
          } else {
            syntheticPayload = {
              dryRun: true,
              skipped: true,
              tool: toolDef.name,
              resolution_event_id: eventStubId,
              spore_id: sporeId ?? null,
              note: 'spore_id did not match a dry-run stub; intent recorded against the live id',
            };
          }
          stubId = eventStubId;
        } else {
          // Generic write with no id to mint: return the positive-signal
          // dry-run ack payload. Echoes args so the agent can reason
          // about what it "wrote".
          syntheticPayload = {
            dryRun: true,
            skipped: true,
            tool: toolDef.name,
            intercepted: true,
            args_echo: args,
          };
        }

        // Serialize once, reuse for both the MCP response and the
        // write-intent row. Prior to this optimization, the synthetic
        // payload and args were each stringified twice per intercepted
        // call (once for the response, once for the intent row).
        const serializedPayload = JSON.stringify(syntheticPayload);
        const serializedArgs = JSON.stringify(args ?? {});

        const response = {
          content: [{
            type: 'text' as const,
            text: serializedPayload,
          }],
        };

        try {
          insertWriteIntent({
            runId,
            projectId,
            phaseId: null,
            toolName: toolDef.name,
            toolInput: serializedArgs,
            syntheticOutput: serializedPayload,
            stubId,
          });
        } catch {
          /* write-intent log is best-effort, same as recordTurn */
        }

        return response;
      },
    };
  }

  /**
   * Record one flagged/blocked write into the per-phase accumulator (when
   * present) and throw the block error. Shared by both the classifier
   * verdict path and the cap-exceeded short-circuit path below, so both
   * routes into "blocked" leave `executePhase` an identical trail to
   * convert the phase result to failed.
   *
   * The thrown message is deliberately GENERIC — it names the tool and
   * phase but never the classifier's reason. The SDK returns a tool
   * handler's throw to the calling MODEL as the tool result (see the
   * deterministic-failure comment on `wrapToolWithSemanticCheck` above), so
   * the verbatim reason would hand a probing model exactly what it needs to
   * rephrase its next attempt against — and the verdict cache above only
   * catches an EXACT retry, not a varied one. The real reason still reaches
   * every operator-facing surface: the write-intent row's
   * `classifierReason` column, the `agent.write.flagged` notification, and
   * the `flaggedWritesAccumulator` record pushed here — all set before this
   * function is called. Only the text returned to the model itself is
   * scrubbed.
   *
   * `cacheKey` dedups the accumulator push: every call to this function
   * still throws (the model must see the block on every retry), but a
   * CACHED retry of an already-flagged call must not push a second entry
   * — otherwise the phase-failure summary's write count inflates with
   * retry attempts instead of reflecting distinct blocked writes.
   */
  function recordFlagAndThrow(
    toolName: string,
    reason: string | null,
    classifierTokens: number | undefined,
    phaseName: string,
    cacheKey: string,
  ): never {
    if (!flaggedAccumulatorKeys.has(cacheKey)) {
      flaggedAccumulatorKeys.add(cacheKey);
      flaggedWritesAccumulator?.push({ toolName, reason, classifierTokens });
    }
    throw new Error(
      `Blocked by a semantic safety check: "${toolName}" in phase "${phaseName}". This call will not succeed on retry.`,
    );
  }

  /**
   * Outer wrapper applied only when `semanticCheckEnabled === true`, the
   * tool is not already dry-run-intercepted, and the tool carries
   * `destructiveHint: true`. Runs `classifyWriteIntent()` before the real
   * handler; an 'ok' verdict lets the real write through unmodified, a
   * 'flag' verdict blocks the write, records the flagged intent, emits an
   * `agent.write.flagged` notification, and throws — the semantic check
   * fails CLOSED once it has actually rendered a verdict (the classifier
   * itself fails open at the uncertainty level, inside
   * classifyWriteIntent()).
   *
   * No phase purpose / harness id / model means the check cannot run
   * meaningfully (e.g. single-query tasks with no phase loop) — fail open
   * at the applicability level in that case, same spirit as the
   * classifier's own uncertainty fail-open.
   *
   * Two containment mechanisms guard against a retrying/probing model:
   *   - Verdict cache: a retry of the EXACT SAME (toolName, args) pair
   *     that was already classified is served from
   *     `semanticCheckVerdictCache` — no second classifier call, no second
   *     write-intent row, no second notification. The block error still
   *     throws every time (and still records into the phase accumulator)
   *     so the model can't loop past it by retrying identically.
   *   - Distinct-flag cap: once this phase has accumulated
   *     `SEMANTIC_CHECK_DISTINCT_FLAG_CAP` distinct flagged (toolName,
   *     args) pairs, any FURTHER distinct destructiveHint call
   *     short-circuits straight to blocked without running the classifier
   *     at all — bounds the classifier-call budget a single phase can burn
   *     probing for an args shape the classifier will let through.
   */
  function wrapToolWithSemanticCheck(toolDef: MycoToolDefinition<any>): MycoToolDefinition<any> {
    const originalHandler = toolDef.handler;
    return {
      ...toolDef,
      handler: async (args, extra) => {
        // Action-aware narrowing: a multi-action tool (e.g.
        // vault_skill_candidates, vault_skill_records) can declare
        // destructiveActions to restrict which args.action values are
        // classified. A call whose action is a string NOT on that list
        // skips the check entirely and runs the real handler directly.
        const declaredActions = toolDef.destructiveActions;
        const callAction = args && typeof args === 'object'
          ? (args as Record<string, unknown>).action
          : undefined;
        if (declaredActions && typeof callAction === 'string' && !declaredActions.includes(callAction)) {
          return originalHandler(args, extra);
        }

        // Args-shape narrowing: a call the tool can PROVE non-destructive
        // from its arguments (e.g. a bookkeeping watermark update) skips
        // the classifier — a model must never sit in judgment of a write
        // whose harmlessness is deterministically decidable. A throwing
        // predicate falls through to classification, never to bypass.
        if (toolDef.nonDestructiveCall && args && typeof args === 'object') {
          let provablyNonDestructive = false;
          try {
            provablyNonDestructive = toolDef.nonDestructiveCall(args as Record<string, unknown>);
          } catch {
            provablyNonDestructive = false;
          }
          if (provablyNonDestructive) {
            return originalHandler(args, extra);
          }
        }

        if (!phasePurpose || !harnessId || !model) {
          return originalHandler(args, extra);
        }

        const cacheKey = `${toolDef.name}\u0000${stableSerialize(args)}`;
        const cached = semanticCheckVerdictCache.get(cacheKey);
        if (cached) {
          if (cached.verdict === 'ok') {
            return originalHandler(args, extra);
          }
          // Identical retry of an already-flagged call: reuse the verdict,
          // skip the classifier call, and skip the write-intent/notify
          // side effects (both already happened on the first attempt).
          recordFlagAndThrow(toolDef.name, cached.reason, undefined, phasePurpose.name, cacheKey);
        }

        if (distinctFlagCount >= SEMANTIC_CHECK_DISTINCT_FLAG_CAP) {
          // Cap reached on distinct flagged attempts this phase — refuse
          // to spend another classifier call on a NEW args shape. Still
          // recorded as a flag (best-effort) so the audit trail shows the
          // short-circuit, but with no classifier round-trip.
          const reason = `Semantic check distinct-flag cap (${SEMANTIC_CHECK_DISTINCT_FLAG_CAP}) reached for this phase — further destructive calls on "${toolDef.name}" are blocked without a classifier call.`;
          try {
            insertWriteIntent({
              runId,
              projectId,
              phaseId: phasePurpose.name,
              toolName: toolDef.name,
              toolInput: JSON.stringify(args ?? {}),
              syntheticOutput: JSON.stringify({ blocked: true, reason, capped: true }),
              classifierVerdict: 'flag',
              classifierReason: reason,
            });
          } catch {
            /* write-intent log is best-effort, same as the dry-run interceptor */
          }
          recordFlagAndThrow(toolDef.name, reason, undefined, phasePurpose.name, cacheKey);
        }

        const classifyStartedAt = Date.now();
        const verdict = await classifyWriteIntent({
          harnessId,
          model,
          provider,
          reasoningLevel: classifierReasoningLevel ?? 'low',
          phasePurpose,
          toolName: toolDef.name,
          toolArgs: args,
        });
        const latencyMs = Date.now() - classifyStartedAt;

        logger?.info('agent.write.classified', `Semantic check verdict for ${toolDef.name}`, {
          runId,
          phase: phasePurpose.name,
          toolName: toolDef.name,
          verdict: verdict.verdict,
          outcome: verdict.outcome,
          latencyMs,
          classifierTokens: verdict.usage?.totalTokens,
        });

        if (verdict.verdict === 'ok') {
          semanticCheckVerdictCache.set(cacheKey, verdict);
          return originalHandler(args, extra);
        }

        semanticCheckVerdictCache.set(cacheKey, verdict);
        distinctFlagCount++;

        try {
          insertWriteIntent({
            runId,
            projectId,
            phaseId: phasePurpose.name,
            toolName: toolDef.name,
            toolInput: JSON.stringify(args ?? {}),
            syntheticOutput: JSON.stringify({ blocked: true, reason: verdict.reason }),
            classifierVerdict: 'flag',
            classifierReason: verdict.reason,
          });
        } catch {
          /* write-intent log is best-effort, same as the dry-run interceptor */
        }

        try {
          notify(vaultDir, {
            domain: 'agents',
            type: 'agent.write.flagged',
            title: `Blocked ${toolDef.name} in phase "${phasePurpose.name}"`,
            message: verdict.reason ?? 'Semantic check flagged this write with no reason given.',
            metadata: { runId, phase: phasePurpose.name, tool: toolDef.name },
          });
        } catch {
          /* notification is best-effort */
        }

        recordFlagAndThrow(toolDef.name, verdict.reason, verdict.usage?.totalTokens, phasePurpose.name, cacheKey);
      },
    };
  }

  function wrapToolWithAudit(
    toolDef: MycoToolDefinition<any>,
    hooks?: HarnessHooks,
    hookContext?: HarnessHookContext,
  ): MycoToolDefinition<any> {
    const originalHandler = toolDef.handler;
    // Reject args keys not in the tool's declared schema. Without this,
    // Zod silently strips unknown keys, which lets a prompt reference a
    // parameter the tool doesn't accept and silently no-op.
    const declaredKeys = toolDef.inputSchema && typeof toolDef.inputSchema === 'object'
      ? new Set(Object.keys(toolDef.inputSchema as Record<string, unknown>))
      : new Set<string>();
    return {
      ...toolDef,
      handler: async (args, extra) => {
        // Only serialize args when we actually need the key — guarded
        // reads use it to detect identical-payload loops. For all other
        // tool calls (writes, non-guarded reads) the serialization is
        // pure waste since `recordTurn` does its own stringify inside
        // `insertTurn`.
        const repeatedReadKey = shouldGuardRepeatedRead(toolDef)
          ? `${toolDef.name}\u0000${JSON.stringify(args)}`
          : null;
        const priorIdenticalCalls = repeatedReadKey
          ? (repeatedReadCounts.get(repeatedReadKey) ?? 0)
          : 0;
        const turnId = recordTurn(toolDef.name, args);
        const hookStartedAt = Date.now();
        if (hookContext) {
          try {
            await hooks?.preToolUse?.({ ...hookContext, toolName: toolDef.name, toolInput: args });
          } catch {
            /* hook callbacks are best-effort observability, never fail the tool call */
          }
        }
        try {
          // Unknown-key guard: fail loud if the caller passed a parameter
          // the tool doesn't declare. This catches prompt-tool contract
          // drift at first call time, not months later.
          if (declaredKeys.size > 0 && args && typeof args === 'object') {
            const unknown: string[] = [];
            for (const key of Object.keys(args as Record<string, unknown>)) {
              if (!declaredKeys.has(key)) unknown.push(key);
            }
            if (unknown.length > 0) {
              const accepted = Array.from(declaredKeys).sort().join(', ');
              const result = textResult({
                error: `Unknown parameter(s) for ${toolDef.name}: ${unknown.join(', ')}. Accepted parameters: ${accepted}.`,
              });
              if (turnId !== null) {
                try {
                  updateTurn(turnId, {
                    tool_output_summary: summarizeToolResult(result),
                    completed_at: epochSeconds(),
                  });
                } catch {
                  /* audit trail is best-effort */
                }
              }
              if (hookContext) {
                try {
                  await hooks?.postToolUse?.({
                    ...hookContext, toolName: toolDef.name, toolInput: args,
                    outcome: 'success', durationMs: Date.now() - hookStartedAt,
                  });
                } catch {
                  /* hook callbacks are best-effort observability */
                }
              }
              return result;
            }
          }

          if (priorIdenticalCalls >= REPEATED_READ_FAILURE_THRESHOLD) {
            throw new Error(
              `Repeated identical ${toolDef.name} reads detected (${priorIdenticalCalls + 1} calls). ` +
              'Reuse the prior result already in context and proceed to a write, report, or different query.',
            );
          }

          if (priorIdenticalCalls >= REPEATED_READ_SUPPRESSION_THRESHOLD) {
            if (repeatedReadKey) {
              repeatedReadCounts.set(repeatedReadKey, priorIdenticalCalls + 1);
            }
            const result = buildRepeatedReadSuppressionResult(toolDef.name, priorIdenticalCalls + 1);
            if (turnId !== null) {
              try {
                updateTurn(turnId, {
                  tool_output_summary: summarizeToolResult(result),
                  completed_at: epochSeconds(),
                });
              } catch {
                /* audit trail is best-effort */
              }
            }
            if (hookContext) {
              try {
                await hooks?.postToolUse?.({
                  ...hookContext, toolName: toolDef.name, toolInput: args,
                  outcome: 'success', durationMs: Date.now() - hookStartedAt,
                });
              } catch {
                /* hook callbacks are best-effort observability */
              }
            }
            return result;
          }

          const result = await originalHandler(args, extra);
          if (repeatedReadKey) {
            repeatedReadCounts.set(repeatedReadKey, priorIdenticalCalls + 1);
          }
          if (toolDef.annotations?.readOnlyHint !== true) {
            repeatedReadCounts.clear();
          }
          if (turnId !== null) {
            try {
              updateTurn(turnId, {
                tool_output_summary: summarizeToolResult(result),
                completed_at: epochSeconds(),
              });
            } catch {
              /* audit trail is best-effort */
            }
          }
          if (hookContext) {
            try {
              await hooks?.postToolUse?.({
                ...hookContext, toolName: toolDef.name, toolInput: args,
                outcome: 'success', durationMs: Date.now() - hookStartedAt,
              });
            } catch {
              /* hook callbacks are best-effort observability */
            }
          }
          return result;
        } catch (error) {
          if (turnId !== null) {
            try {
              updateTurn(turnId, {
                tool_output_summary: summarizeToolError(error),
                completed_at: epochSeconds(),
              });
            } catch {
              /* audit trail is best-effort */
            }
          }
          if (hookContext) {
            try {
              await hooks?.postToolUse?.({
                ...hookContext, toolName: toolDef.name, toolInput: args,
                outcome: 'error', errorMessage: errorMessage(error), durationMs: Date.now() - hookStartedAt,
              });
            } catch {
              /* hook callbacks are best-effort observability */
            }
          }
          throw error;
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create a vault MCP tool server with the full vault tool surface for the agent.
 *
 * Wraps `createVaultTools()` with `createSdkMcpServer()` from the
 * Claude Agent SDK.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @returns an MCP server config with instance, suitable for the SDK.
 */
export function createVaultToolServer(
  agentId: string,
  runId: string,
  options?: Pick<VaultToolOptions, 'embeddingManager' | 'projectRoot' | 'vaultDir' | 'requestContext' | 'dryRun' | 'metadataAccumulator' | 'phasePurpose' | 'semanticCheckEnabled' | 'harnessId' | 'model' | 'classifierReasoningLevel' | 'provider' | 'flaggedWritesAccumulator' | 'hooks' | 'hookContext' | 'deferredNames' | 'logger'>,
) {
  const tools = createVaultTools(agentId, runId, options);

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: toSdkMcpToolDefinitions(tools),
    // Every phase needs its vault tools present starting at turn 1 (phase
    // prompts reference tool names directly) — don't let the SDK defer
    // tool schemas behind its tool-search default.
    alwaysLoad: true,
  });
}

/**
 * Create a vault MCP tool server scoped to a subset of tools.
 *
 * Used by the phased executor to restrict each phase to only the tools
 * it needs. Tools not in `toolNames` are excluded from the server.
 *
 * @param agentId — the agent identity, injected into all write operations.
 * @param runId — the current agent run ID, injected into reports and turns.
 * @param toolNames — tool names to include (e.g., ['vault_unprocessed', 'vault_create_spore']).
 * @returns an MCP server config with only the specified tools.
 */
export function createScopedVaultToolServer(
  agentId: string,
  runId: string,
  toolNames: string[],
  options?: Pick<VaultToolOptions, 'turnOffset' | 'embeddingManager' | 'projectRoot' | 'vaultDir' | 'requestContext' | 'dryRun' | 'metadataAccumulator' | 'phasePurpose' | 'semanticCheckEnabled' | 'harnessId' | 'model' | 'classifierReasoningLevel' | 'provider' | 'flaggedWritesAccumulator' | 'hooks' | 'hookContext' | 'deferredNames' | 'logger'> & { readOnly?: boolean },
) {
  const nameSet = new Set(toolNames);
  const allTools = createVaultTools(agentId, runId, { ...options, onlyNames: nameSet });
  // readOnly gate first — structural enforcement before name scoping,
  // so a write tool in the name list can never pass the readOnly filter.
  const eligible = options?.readOnly
    ? allTools.filter((t) => t.annotations?.readOnlyHint === true)
    : allTools;
  // vault_search_tools is synthesized by createVaultTools when any tool in
  // this scope is deferrable — it is never itself in `toolNames` (the
  // phase's declared tools list), so the name-scoping filter below must
  // let it through explicitly or deferred tools would have no discovery
  // path once scoped down to a phase's tool subset.
  const scopedTools = eligible.filter((t) => nameSet.has(t.name) || t.name === 'vault_search_tools');

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: toSdkMcpToolDefinitions(scopedTools),
    alwaysLoad: true,
  });
}

/**
 * Build a vault MCP tool server from a pre-materialized tool list.
 *
 * Used by map-phase mode (in harness adapters) when the harness has
 * already constructed a constrained per-item surface — argMap-pinned
 * fields stripped from the sink schema, outcome-capture wrapper applied.
 * Rebuilding via createVaultTools() would discard those modifications,
 * so map-phase passes the materialized tools through `toolSurface.tools`
 * and the harness adapter calls this entrypoint instead.
 */
export function createMaterializedVaultToolServer(tools: MycoToolDefinition<any>[]) {
  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: toSdkMcpToolDefinitions(tools),
    alwaysLoad: true,
  });
}
