/**
 * myco_digest_revisions — list historical digest revisions.
 *
 * Mirrors GET /api/digest/revisions. The revision log is scoped per
 * (agent, tier); `tier` is required by the daemon route. Restore
 * (POST /api/digest/revisions/:id/restore) is intentionally UI-only and
 * NOT exposed via MCP.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';
import { extractErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestRevisionsInput {
  /** Optional; the daemon route defaults to DEFAULT_AGENT_ID ('myco-agent'). */
  agent_id?: string;
  /**
   * Required by the daemon route — passing an unset tier returns a 400.
   * Kept optional on the input type so zod surfaces the error at parse
   * time with a consistent message.
   */
  tier?: number;
  limit?: number;
}

export interface DigestRevisionsHandlerResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoDigestRevisions(
  input: DigestRevisionsInput,
  client: DaemonClient,
): Promise<DigestRevisionsHandlerResult> {
  if (input.tier === undefined || input.tier === null) {
    return { ok: false, error: 'tier is required' };
  }

  const endpoint = buildEndpoint('/api/digest/revisions', {
    agentId: input.agent_id,
    tier: input.tier,
    limit: input.limit,
  });
  const result = await client.get(endpoint);
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(result.data, 'fetch_failed'),
    };
  }
  return { ok: true, data: result.data };
}
