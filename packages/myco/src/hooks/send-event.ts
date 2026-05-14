/** Shared skeleton: read stdin, POST to daemon /events, buffer on failure. */

import { createHookDaemonClient, isIgnoredEventResponse } from './client.js';
import { type NormalizedHookInput } from './normalize.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import fs from 'node:fs';
import path from 'node:path';

export async function sendEvent(
  hookName: string,
  buildEvent: (input: NormalizedHookInput) => Record<string, unknown>,
): Promise<void> {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const event = buildEvent(input);
    const eventWithContext = {
      ...event,
      transcript_path: input.transcriptPath,
    };

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });
    const result = await client.capturePost(
      '/events',
      { ...eventWithContext, session_id: sessionId, agent: symbiont },
    );

    // Buffer on transport failure OR server-side `ignored` so reconcile can replay it.
    if (!result.ok || isIgnoredEventResponse(result.data)) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append(eventWithContext);
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName);
  }
}
