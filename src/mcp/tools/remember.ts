/**
 * myco_remember — save a decision, gotcha, bug fix, discovery, or trade-off as a spore.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 * The daemon handles agent registration, spore insertion, and embedding.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RememberInput {
  content: string;
  type?: string;
  tags?: string[];
}

interface RememberResult {
  id: string;
  observation_type: string;
  status: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoRemember(
  input: RememberInput,
  client: DaemonClient,
): Promise<RememberResult> {
  const result = await client.post('/api/mcp/remember', {
    content: input.content,
    type: input.type,
    tags: input.tags,
  });

  if (!result.ok || !result.data) {
    // Return a graceful error shape that matches RememberResult enough to not crash
    return {
      id: '',
      observation_type: input.type ?? 'discovery',
      status: 'error',
      created_at: 0,
    };
  }

  return result.data as RememberResult;
}
