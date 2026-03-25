/**
 * Shared hook helper — sends an event to the daemon, buffers on failure.
 *
 * Every hook follows the same pattern: read stdin, POST to daemon /events,
 * buffer to disk if the daemon is unreachable. This helper extracts that
 * skeleton so each hook is a one-liner mapping input fields to event fields.
 */

import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read hook stdin, POST event to daemon, buffer on failure.
 *
 * @param hookName — used for error logging (e.g., 'subagent-start')
 * @param buildEvent — maps the raw hook input to the event payload.
 *   Receives the parsed stdin JSON and the resolved session ID.
 *   Return the full event object (must include `type`).
 */
export async function sendEvent(
  hookName: string,
  buildEvent: (input: Record<string, unknown>, sessionId: string) => Record<string, unknown>,
): Promise<void> {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin()) as Record<string, unknown>;
    const sessionId = (input.session_id as string) ?? process.env.MYCO_SESSION_ID ?? `s-${Date.now()}`;

    const event = buildEvent(input, sessionId);

    const client = new DaemonClient(VAULT_DIR);
    const result = await client.post('/events', { ...event, session_id: sessionId });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      // Strip session_id from buffer entry — it's in the filename
      const { session_id: _, ...bufferPayload } = event;
      buffer.append(bufferPayload);
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  }
}
