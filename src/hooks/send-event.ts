/**
 * Shared hook helper — sends an event to the daemon, buffers on failure.
 *
 * Every hook follows the same pattern: read stdin, POST to daemon /events,
 * buffer to disk if the daemon is unreachable. This helper extracts that
 * skeleton so each hook is a one-liner mapping input fields to event fields.
 */

import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { normalizeHookInput, type NormalizedHookInput } from './normalize.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read hook stdin, POST event to daemon, buffer on failure.
 *
 * @param hookName — used for error logging (e.g., 'subagent-start')
 * @param buildEvent — maps the normalized hook input to the event payload.
 *   Receives a NormalizedHookInput with canonical field names.
 *   Return the full event object (must include `type`).
 */
export async function sendEvent(
  hookName: string,
  buildEvent: (input: NormalizedHookInput) => Record<string, unknown>,
): Promise<void> {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const rawInput = JSON.parse(await readStdin()) as Record<string, unknown>;
    const input = normalizeHookInput(rawInput);

    const event = buildEvent(input);

    const client = new DaemonClient(VAULT_DIR);
    const result = await client.post('/events', { ...event, session_id: input.sessionId });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), input.sessionId);
      // Strip session_id from buffer entry — it's in the filename
      const { session_id: _, ...bufferPayload } = event;
      buffer.append(bufferPayload);
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  }
}
