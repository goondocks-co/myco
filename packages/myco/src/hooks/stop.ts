import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    if (!input.sessionId) return;

    const client = createHookDaemonClient(VAULT_DIR, { sessionId: input.sessionId });

    await client.ensureRunning({ checkStale: false });

    // Pass transcript_path and last_assistant_message from the active agent.
    // These are provided by the hook system and eliminate the need to
    // scan directories or mine the transcript for the AI response.
    await client.capturePost('/events/stop', {
      session_id: input.sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
      last_assistant_message: input.lastResponse,
    });
  } catch (error) {
    process.stderr.write(`[myco] stop error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'stop');
  }
}
