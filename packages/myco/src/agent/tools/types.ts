/**
 * Shared types and helpers for vault tool modules.
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEmbeddingPort, AgentTeamSearchPort } from '@myco/agent/runtime/ports.js';
import {
  projectScopeFromRequestContext,
  resolveRequestContextForVault,
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import type { ProjectScope } from '@myco/grove/ids.js';

export interface MycoToolDefinition<TInput = any> {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: SdkMcpToolDefinition<any>['annotations'];
  handler: (args: TInput, extra: unknown) => Promise<any>;
  /**
   * When true, this tool's full schema is withheld from the initial phase
   * tool surface. The tool remains callable (its handler is never modified
   * or gated by this flag) but its `description`/`inputSchema` are replaced
   * with a lightweight stub in the surface handed to the harness/model.
   * The full schema becomes visible via `vault_search_tools`, a meta-tool
   * synthesized by `createVaultTools()` whenever at least one tool in the
   * current phase's scope is deferrable. See
   * docs/superpowers/specs/2026-07-01-tool-discovery-at-scale-design.md.
   */
  deferrable?: boolean;
  /**
   * One-line (<=80 char) summary shown in `vault_search_tools` results in
   * place of this tool's full description when `deferrable` is true.
   * Required (enforced at the factory level, not the type level) whenever
   * `deferrable` is set.
   */
  searchSummary?: string;
  /**
   * Narrows semantic-check applicability for a multi-action
   * `destructiveHint: true` tool whose primary actions are list/get (e.g.
   * `vault_skill_candidates`, `vault_skill_records`). When present,
   * `wrapToolWithSemanticCheck` (tools.ts) only runs the classifier when
   * `args.action` matches one of these values — a call whose `action` is a
   * string NOT in this list skips the check and runs the real handler
   * directly. When absent, every call to a `destructiveHint` tool is
   * checked (existing behavior, unchanged for single-action write tools).
   */
  destructiveActions?: string[];
  /**
   * Deterministic argument normalization applied by `createVaultTools()`
   * as the OUTERMOST wrapper — before audit-event recording, dry-run
   * write-intent capture, the semantic-check classifier, and the real
   * handler, so every consumer sees the same normalized arguments.
   *
   * Motivating case: payloads whose shape asks the model to transcribe a
   * load-bearing identifier (e.g. `run_id` in skill-evolve state/report
   * payloads). Models fabricate placeholders instead of copying UUIDs,
   * which the task postconditions then reject. Stamping the true value
   * here makes that failure class structurally impossible.
   *
   * Must be pure and total: return the (possibly new) args object, never
   * throw — `wrapToolWithArgNormalization` fails open to the original
   * args if it does.
   */
  normalizeArgs?: (args: Record<string, unknown>, ctx: { runId: string }) => Record<string, unknown>;
}

/**
 * Stamp `run_id` in a plain-object payload to the actual run id. Returns
 * a new object when the payload carries a `run_id` key with a different
 * value; returns the input unchanged otherwise (no key added — payloads
 * without run-attribution semantics are never touched, so cursor-style
 * state values and strict downstream parsers are unaffected).
 */
export function stampRunIdInPayload(
  payload: unknown,
  runId: string,
): unknown {
  if (
    payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && 'run_id' in payload
    && (payload as Record<string, unknown>).run_id !== runId
  ) {
    return { ...(payload as Record<string, unknown>), run_id: runId };
  }
  return payload;
}

export function toSdkMcpToolDefinition<TInput>(
  tool: MycoToolDefinition<TInput>,
): SdkMcpToolDefinition<any> {
  return tool as SdkMcpToolDefinition<any>;
}

export function toSdkMcpToolDefinitions(
  tools: MycoToolDefinition[],
): SdkMcpToolDefinition<any>[] {
  return tools.map((tool) => toSdkMcpToolDefinition(tool));
}

/**
 * Non-null JSON-serialisable shapes accepted by textResult.
 *
 * Narrower than `unknown` so a `null` returned from a write helper (e.g.
 * `upsertDigestExtract` in dry-run mode) cannot be silently JSON-stringified
 * as `"null"` and handed back to the agent as a successful result. Call
 * sites that genuinely need to signal "nothing happened" should use
 * `dryRunResult(...)` instead, which makes the dry-run semantics explicit
 * in the payload.
 */
export type TextResultPayload =
  | string
  | number
  | boolean
  | object;

/** MCP tool response helper -- wraps data as text content for the agent. */
export function textResult(data: TextResultPayload): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/**
 * Dry-run acknowledgement payload. Used by write tools when an operation
 * was intercepted (dryRun mode) and no live-table write occurred. Keeps
 * the shape explicit so callers and the agent both see a positive signal
 * rather than a serialised `null`.
 */
export function dryRunResult(
  toolName: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: 'text'; text: string }> } {
  return textResult({
    dryRun: true,
    skipped: true,
    tool: toolName,
    ...details,
  });
}

/** Dependencies shared by all vault tool factories. */
export interface VaultToolDeps {
  agentId: string;
  runId: string;
  embeddingManager?: AgentEmbeddingPort;
  teamClient?: AgentTeamSearchPort | null;
  machineId?: string;
  projectRoot?: string;
  vaultDir?: string;
  requestContext?: MycoRequestContext;
  /**
   * When true, the tool surface is running in dry-run mode. Most write
   * tools are intercepted centrally by `createVaultTools` (see
   * `wrapToolWithDryRun`), but a few (notably `vault_finalize_skill`)
   * need to read this flag in-handler to short-circuit before doing
   * expensive multi-step work that the interceptor can't express.
   */
  dryRun?: boolean;
  /**
   * The calling phase's declared name and a bounded excerpt of its
   * prompt. Populated by createVaultTools from VaultToolOptions.
   * See HarnessToolSurface.phasePurpose for the full rationale.
   */
  phasePurpose?: { name: string; promptExcerpt: string };
  /** Record a turn in the audit trail. Returns the inserted row id when available. */
  recordTurn: (toolName: string, toolInput: unknown) => number | null;
  /**
   * Per-phase metadata accumulator. When present, `phase_emit_metadata`
   * tool calls write key→value pairs here; the phase loop reads it back
   * after `harness.execute()` returns and attaches it to the PhaseResult
   * so downstream phases can gate on it via
   * `PhaseDefinition.gateOnPriorMetadata`. When absent, the tool is a
   * structural no-op — it still returns success, but values are dropped
   * (lets the same handler ship before the phase-loop wiring lands).
   */
  metadataAccumulator?: Map<string, unknown>;
}

export function rowProjectIdFromVaultToolDeps(deps: VaultToolDeps): string | null | undefined {
  const context = deps.requestContext
    ?? (deps.vaultDir ? resolveRequestContextForVault(deps.vaultDir, {
      machineId: deps.machineId,
    }) : undefined);
  return rowProjectIdFromRequestContext(context);
}

export function projectScopeFromVaultToolDeps(deps: VaultToolDeps): ProjectScope {
  const context = deps.requestContext
    ?? (deps.vaultDir ? resolveRequestContextForVault(deps.vaultDir, {
      machineId: deps.machineId,
    }) : undefined);
  return projectScopeFromRequestContext(context);
}
