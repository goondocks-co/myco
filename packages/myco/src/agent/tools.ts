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
 * - Skill tools (10): vault_skill_survey_prepare,
 *                    vault_skill_survey_bundle_decisions,
 *                    vault_skill_survey_reconciliation_plan,
 *                    vault_skill_survey_apply_reconciliation,
 *                    vault_skill_candidates, vault_skill_records,
 *                    vault_scan_skill_contamination, vault_write_skill,
 *                    vault_stage_skill, vault_finalize_skill
 * - Canopy tools (2): canopy_describe_next, canopy_describe_write
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
import { createReadTools } from './tools/read-tools.js';
import { createWriteTools } from './tools/write-tools.js';
import { createObservabilityTools } from './tools/observability-tools.js';
import { createPhaseMetadataTools, PHASE_METADATA_TOOL_NAMES } from './tools/phase-metadata-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import { createExplorationTools } from './tools/exploration-tools.js';
import { createCanopyTools } from './tools/canopy-tools.js';
import { textResult, toSdkMcpToolDefinitions } from './tools/types.js';
import { errorMessage } from '@myco/utils/error-message.js';
import type { MycoToolDefinition, VaultToolDeps } from './tools/types.js';
import type { AgentEmbeddingPort, AgentTeamSearchPort } from '@myco/agent/runtime/ports.js';
import { rowProjectIdFromRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';

// Re-exports for backward compatibility
export { validateSkillContent, MAX_SKILL_LINES, REQUIRED_FRONTMATTER_FIELDS } from './tools/skill-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Options for createVaultTools beyond the required agentId and runId. */
export interface VaultToolOptions {
  turnOffset?: number;
  embeddingManager?: AgentEmbeddingPort;
  teamClient?: AgentTeamSearchPort | null;
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

const READ_TOOL_NAMES = new Set([
  'vault_unprocessed', 'vault_batches', 'vault_session_summary_material', 'vault_spores',
  'vault_sessions', 'vault_search_fts', 'vault_search_semantic', 'vault_search_canopy',
  'vault_release_state', 'vault_state', 'vault_edges',
]);

const WRITE_TOOL_NAMES = new Set([
  'vault_create_spore', 'vault_resolve_spore', 'vault_update_session', 'vault_set_state',
  'vault_read_digest', 'vault_write_digest', 'vault_mark_processed',
]);

const OBSERVABILITY_TOOL_NAMES = new Set(['vault_report']);

const PHASE_METADATA_TOOL_NAMES_SET = new Set<string>(PHASE_METADATA_TOOL_NAMES);

const SKILL_TOOL_NAMES = new Set([
  'vault_skill_survey_prepare', 'vault_skill_survey_bundle_decisions',
  'vault_skill_survey_reconciliation_plan',
  'vault_skill_survey_apply_reconciliation',
  'vault_skill_candidates', 'vault_skill_records', 'vault_scan_skill_contamination',
  'vault_write_skill', 'vault_stage_skill', 'vault_finalize_skill',
  'vault_edit_skill',
]);

const EXPLORATION_TOOL_NAMES = new Set([
  'fs_read', 'fs_list', 'fs_tree', 'code_grep',
]);

const CANOPY_TOOL_NAMES = new Set([
  'canopy_describe_next', 'canopy_describe_write', 'canopy_list',
  'canopy_describe_charge',
]);

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
 * Total number of vault tools defined. Derived from the union of the
 * seven tool-group sets above so this constant can never drift from the
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

function setsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) { if (b.has(item)) return true; }
  return false;
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
    teamClient,
    machineId,
    projectRoot,
    vaultDir,
    requestContext,
    dryRun,
    metadataAccumulator,
    onlyNames,
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
    teamClient,
    machineId: machineId ?? requestContext?.machineId,
    projectRoot,
    vaultDir,
    requestContext,
    dryRun,
    recordTurn,
    metadataAccumulator,
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

  return tools.map((toolDef) => {
    const typed = toolDef as MycoToolDefinition<any>;
    // Dry-run interceptor is applied FIRST (replacing the handler),
    // THEN the audit wrapper wraps on top. This way the audit trail
    // still records a turn for every intercepted call — the audit
    // wrapper calls our dry-run handler as its "original" and captures
    // the synthetic payload just like any other response.
    //
    // A tool qualifies for interception when dryRun is on, it is not
    // a read (readOnlyHint !== true), and it is not on the exception
    // list (DRY_RUN_EXEMPT_TOOLS).
    const shouldIntercept = Boolean(dryRun)
      && typed.annotations?.readOnlyHint !== true
      && !DRY_RUN_EXEMPT_TOOLS.has(typed.name);
    const inner = shouldIntercept ? wrapToolWithDryRun(typed) : typed;
    return wrapToolWithAudit(inner);
  }) as typeof tools;

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

  function wrapToolWithAudit(toolDef: MycoToolDefinition<any>): MycoToolDefinition<any> {
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
  options?: Pick<VaultToolOptions, 'embeddingManager' | 'projectRoot' | 'vaultDir' | 'requestContext' | 'dryRun' | 'metadataAccumulator'>,
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
  options?: Pick<VaultToolOptions, 'turnOffset' | 'embeddingManager' | 'projectRoot' | 'vaultDir' | 'requestContext' | 'dryRun' | 'metadataAccumulator'> & { readOnly?: boolean },
) {
  const nameSet = new Set(toolNames);
  const allTools = createVaultTools(agentId, runId, { ...options, onlyNames: nameSet });
  // readOnly gate first — structural enforcement before name scoping,
  // so a write tool in the name list can never pass the readOnly filter.
  const eligible = options?.readOnly
    ? allTools.filter((t) => t.annotations?.readOnlyHint === true)
    : allTools;
  const scopedTools = eligible.filter((t) => nameSet.has(t.name));

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
