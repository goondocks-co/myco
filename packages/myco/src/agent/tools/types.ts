/**
 * Shared types and helpers for vault tool modules.
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { EmbeddingManager } from '@myco/daemon/embedding/index.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';

// Re-export for convenience
export type { SdkMcpToolDefinition };

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
  embeddingManager?: EmbeddingManager;
  teamClient?: TeamSyncClient | null;
  machineId?: string;
  projectRoot?: string;
  vaultDir?: string;
  /**
   * When true, the tool surface is running in dry-run mode. Most write
   * tools are intercepted centrally by `createVaultTools` (see
   * `wrapToolWithDryRun`), but a few (notably `vault_finalize_skill`)
   * need to read this flag in-handler to short-circuit before doing
   * expensive multi-step work that the interceptor can't express.
   */
  dryRun?: boolean;
  /** Record a turn in the audit trail. Returns the inserted row id when available. */
  recordTurn: (toolName: string, toolInput: unknown) => number | null;
}
