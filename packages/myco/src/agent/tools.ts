/**
 * Vault MCP tool server for the agent.
 *
 * Creates vault tools that expose SQLite query helpers to the agent
 * via the Claude Agent SDK. Tools are grouped into:
 * - Read tools (10): vault_unprocessed, vault_batches, vault_session_summary_material,
 *                    vault_spores, vault_sessions, vault_search_fts,
 *                    vault_search_semantic, vault_state, vault_entities, vault_edges
 * - Write tools (9): vault_create_spore, vault_create_entity, vault_create_edge,
 *                     vault_resolve_spore, vault_update_session, vault_set_state,
 *                     vault_read_digest, vault_write_digest, vault_mark_processed
 * - Observability (1): vault_report
 * - Skill tools (5): vault_skill_candidates, vault_skill_records, vault_write_skill,
 *                    vault_stage_skill, vault_finalize_skill
 *
 * `agentId` and `runId` are captured in closures — tools inject them
 * automatically so the agent cannot impersonate another agent.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { insertTurn, updateTurn } from '@myco/db/queries/turns.js';
import { createReadTools } from './tools/read-tools.js';
import { createWriteTools } from './tools/write-tools.js';
import { createObservabilityTools } from './tools/observability-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import type { SdkMcpToolDefinition, VaultToolDeps } from './tools/types.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';

// Re-exports for backward compatibility
export { validateSkillContent, MAX_SKILL_LINES, REQUIRED_FRONTMATTER_FIELDS } from './tools/skill-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Options for createVaultTools beyond the required agentId and runId. */
export interface VaultToolOptions {
  turnOffset?: number;
  embeddingManager?: EmbeddingManager;
  teamClient?: TeamSyncClient | null;
  machineId?: string;
  projectRoot?: string;
  vaultDir?: string;
}

// ---------------------------------------------------------------------------
// Tool definitions factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool group membership — used to skip factory calls for unneeded groups
// ---------------------------------------------------------------------------

const READ_TOOL_NAMES = new Set([
  'vault_unprocessed', 'vault_batches', 'vault_session_summary_material', 'vault_spores',
  'vault_sessions', 'vault_search_fts', 'vault_search_semantic', 'vault_state',
  'vault_entities', 'vault_edges',
]);

const WRITE_TOOL_NAMES = new Set([
  'vault_create_spore', 'vault_create_entity', 'vault_create_edge',
  'vault_resolve_spore', 'vault_update_session', 'vault_set_state',
  'vault_read_digest', 'vault_write_digest', 'vault_mark_processed',
]);

const OBSERVABILITY_TOOL_NAMES = new Set(['vault_report']);

const SKILL_TOOL_NAMES = new Set([
  'vault_skill_candidates', 'vault_skill_records', 'vault_write_skill',
  'vault_stage_skill', 'vault_finalize_skill',
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
  'vault_entities',
  'vault_edges',
]);
/** On the third identical guarded read, stop resending the large payload and tell the agent to reuse prior context. */
const REPEATED_READ_SUPPRESSION_THRESHOLD = 2;
/** On the fifth identical guarded read, fail fast — the run is not making progress. */
const REPEATED_READ_FAILURE_THRESHOLD = 4;

/**
 * Total number of vault tools defined. Derived from the union of the
 * four tool-group sets above so this constant can never drift from the
 * actual factory output — adding a tool to a group bumps the count
 * automatically. Each set is disjoint so the straight sum is correct.
 */
export const VAULT_TOOL_COUNT =
  READ_TOOL_NAMES.size +
  WRITE_TOOL_NAMES.size +
  OBSERVABILITY_TOOL_NAMES.size +
  SKILL_TOOL_NAMES.size;

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

function summarizeToolResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return null;
  return truncateSummary(first.text.replace(/\s+/g, ' ').trim());
}

function summarizeToolError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return truncateSummary(error.message) ?? 'Tool failed';
  }
  return truncateSummary(String(error)) ?? 'Tool failed';
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

function shouldGuardRepeatedRead(toolDef: SdkMcpToolDefinition<any>): boolean {
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
  const { turnOffset = 0, embeddingManager, teamClient, machineId, projectRoot, vaultDir, onlyNames } = options ?? {};

  /** Turn number counter — incremented per tool call (read and write) within a run. */
  let turnCounter = turnOffset;
  /** Exact-read loop counters for the current tool server instance. */
  const repeatedReadCounts = new Map<string, number>();

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
    machineId,
    projectRoot,
    vaultDir,
    recordTurn,
  };

  // When onlyNames is provided, skip factory calls for groups with no overlap
  const needsAll = !onlyNames;
  const tools = [
    ...(needsAll || setsOverlap(onlyNames!, READ_TOOL_NAMES) ? createReadTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, WRITE_TOOL_NAMES) ? createWriteTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, OBSERVABILITY_TOOL_NAMES) ? createObservabilityTools(deps) : []),
    ...(needsAll || setsOverlap(onlyNames!, SKILL_TOOL_NAMES) ? createSkillTools(deps) : []),
  ];

  return tools.map((toolDef) => wrapToolWithAudit(toolDef as SdkMcpToolDefinition<any>)) as typeof tools;

  function wrapToolWithAudit(toolDef: SdkMcpToolDefinition<any>): SdkMcpToolDefinition<any> {
    const originalHandler = toolDef.handler;
    return {
      ...toolDef,
      handler: async (args, extra) => {
        const serializedArgs = JSON.stringify(args);
        const repeatedReadKey = shouldGuardRepeatedRead(toolDef)
          ? `${toolDef.name}\u0000${serializedArgs}`
          : null;
        const priorIdenticalCalls = repeatedReadKey
          ? (repeatedReadCounts.get(repeatedReadKey) ?? 0)
          : 0;
        const turnId = recordTurn(toolDef.name, args);
        try {
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
export function createVaultToolServer(agentId: string, runId: string, options?: Pick<VaultToolOptions, 'embeddingManager' | 'vaultDir'>) {
  const tools = createVaultTools(agentId, runId, options);

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools,
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
  options?: Pick<VaultToolOptions, 'turnOffset' | 'embeddingManager' | 'projectRoot' | 'vaultDir'> & { readOnly?: boolean },
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
    tools: scopedTools,
  });
}
