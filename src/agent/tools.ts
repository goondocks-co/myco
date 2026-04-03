/**
 * Vault MCP tool server for the agent.
 *
 * Creates 21 tools that expose SQLite query helpers to the agent
 * via the Claude Agent SDK. Tools are grouped into:
 * - Read tools (8): vault_unprocessed, vault_spores, vault_sessions, vault_search_fts,
 *                    vault_search_semantic, vault_state, vault_entities, vault_edges
 * - Write tools (9): vault_create_spore, vault_create_entity, vault_create_edge,
 *                     vault_resolve_spore, vault_update_session, vault_set_state,
 *                     vault_read_digest, vault_write_digest, vault_mark_processed
 * - Observability (1): vault_report
 * - Skill tools (3): vault_skill_candidates, vault_skill_records, vault_write_skill
 *
 * `agentId` and `runId` are captured in closures — tools inject them
 * automatically so the agent cannot impersonate another agent.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { createReadTools } from './tools/read-tools.js';
import { createWriteTools } from './tools/write-tools.js';
import { createObservabilityTools } from './tools/observability-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import type { VaultToolDeps } from './tools/types.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';

// Re-exports for backward compatibility
export { validateSkillContent, MAX_SKILL_LINES, REQUIRED_FRONTMATTER_FIELDS } from './tools/skill-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total number of vault tools defined. */
export const VAULT_TOOL_COUNT = 21;

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

/**
 * Create the 21 vault tool definitions for the agent (includes 3 skill tools:
 * vault_skill_candidates, vault_skill_records, vault_write_skill).
 *
 * Exposed for testing (call handler directly) and for the MCP server factory.
 */
export function createVaultTools(agentId: string, runId: string, options?: VaultToolOptions) {
  const { turnOffset = 0, embeddingManager, teamClient, machineId, projectRoot, vaultDir } = options ?? {};

  /** Turn number counter — incremented per tool call (read and write) within a run. */
  let turnCounter = turnOffset;

  /**
   * Record a turn in the audit trail.
   * Called for ALL tool invocations (read and write) for full visibility.
   * Fire-and-forget — does not block the tool response.
   */
  function recordTurn(toolName: string, toolInput: unknown): void {
    turnCounter++;
    try {
      insertTurn({
        run_id: runId,
        agent_id: agentId,
        turn_number: turnCounter,
        tool_name: toolName,
        tool_input: JSON.stringify(toolInput),
        started_at: epochSeconds(),
      });
    } catch {
      /* audit trail is best-effort */
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

  return [
    ...createReadTools(deps),
    ...createWriteTools(deps),
    ...createObservabilityTools(deps),
    ...createSkillTools(deps),
  ];
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create a vault MCP tool server with 21 tools for the agent.
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
  options?: Pick<VaultToolOptions, 'turnOffset' | 'embeddingManager' | 'projectRoot' | 'vaultDir'>,
) {
  const allTools = createVaultTools(agentId, runId, options);
  const nameSet = new Set(toolNames);
  const scopedTools = allTools.filter((t) => nameSet.has(t.name));

  return createSdkMcpServer({
    name: 'myco-vault',
    version: getPluginVersion(),
    tools: scopedTools,
  });
}
