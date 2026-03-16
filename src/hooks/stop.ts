import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { loadConfig } from '../config/loader.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID;
    if (!sessionId) return;

    const config = loadConfig(VAULT_DIR);
    const client = new DaemonClient(VAULT_DIR);

    await client.ensureRunning();

    // Pass transcript_path and last_assistant_message from Claude Code.
    // These are provided by the hook system and eliminate the need to
    // scan directories or mine the transcript for the AI response.
    await client.post('/events/stop', {
      session_id: sessionId,
      user: config.team.user || undefined,
      transcript_path: input.transcript_path,
      last_assistant_message: input.last_assistant_message,
    });
  } catch (error) {
    process.stderr.write(`[myco] stop error: ${(error as Error).message}\n`);
  }
}

main();
