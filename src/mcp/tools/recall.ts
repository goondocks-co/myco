/**
 * myco_recall — get context relevant to current work.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 * Tries sessions, spores, and plans endpoints to find the note by ID.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecallInput {
  note_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Recall looks up a specific note by ID. It tries sessions, spores, and
 * plans via the daemon API and returns the first match.
 */
export async function handleMycoRecall(
  input: RecallInput,
  client: DaemonClient,
): Promise<Record<string, unknown>> {
  const id = input.note_id;

  // Try all three lookups in parallel
  const [sessionResult, sporeResult] = await Promise.all([
    client.get(`/api/sessions/${encodeURIComponent(id)}`),
    client.get(`/api/spores/${encodeURIComponent(id)}`),
  ]);

  if (sessionResult.ok && sessionResult.data) {
    return { type: 'session', ...sessionResult.data };
  }
  if (sporeResult.ok && sporeResult.data) {
    return { type: 'spore', ...sporeResult.data };
  }

  return { error: `Note not found: ${id}` };
}
