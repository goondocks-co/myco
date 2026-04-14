/**
 * Shared types and helpers for vault tool modules.
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';

// Re-export for convenience
export type { SdkMcpToolDefinition };

/** MCP tool response helper -- wraps data as text content for the agent. */
export function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/** Dependencies shared by all vault tool factories. */
export interface VaultToolDeps {
  agentId: string;
  runId: string;
  embeddingManager?: EmbeddingManager;
  teamClient?: TeamSyncClient | null;
  machineId?: string;
  projectRoot?: string;
  vaultDir?: string;
  /** Record a turn in the audit trail. Returns the inserted row id when available. */
  recordTurn: (toolName: string, toolInput: unknown) => number | null;
}
