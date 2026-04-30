/**
 * myco_supersede — mark a spore as outdated and replaced by a newer one.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 * The daemon handles status update and resolution event recording.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SupersedeInput {
  old_spore_id: string;
  new_spore_id: string;
  reason?: string;
}

interface SupersedeResult {
  old_spore: string;
  new_spore: string;
  status: 'superseded';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSupersede(
  input: SupersedeInput,
  client: DaemonClient,
): Promise<SupersedeResult> {
  const result = await client.post('/api/mcp/supersede', {
    old_spore_id: input.old_spore_id,
    new_spore_id: input.new_spore_id,
    reason: input.reason,
  });

  if (!result.ok || !result.data) {
    throw new Error(`Failed to supersede spore: daemon request failed`);
  }

  return result.data as SupersedeResult;
}
