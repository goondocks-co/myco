/**
 * myco_write_intents — inspect the writes a dry-run agent would have
 * performed but skipped.
 *
 * Mirrors GET /api/agent/runs/:id/write-intents. Use with myco_runs to verify
 * safety before re-running a task without dry_run.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';
import { extractErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteIntentsInput {
  run_id: string;
  limit?: number;
  offset?: number;
}

export interface WriteIntentsHandlerResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoWriteIntents(
  input: WriteIntentsInput,
  client: DaemonClient,
): Promise<WriteIntentsHandlerResult> {
  if (!input.run_id) {
    return { ok: false, error: 'run_id is required' };
  }

  const endpoint = buildEndpoint(
    `/api/agent/runs/${encodeURIComponent(input.run_id)}/write-intents`,
    { limit: input.limit, offset: input.offset },
  );
  const result = await client.get(endpoint);
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(result.data, 'fetch_failed'),
    };
  }
  return { ok: true, data: result.data };
}
