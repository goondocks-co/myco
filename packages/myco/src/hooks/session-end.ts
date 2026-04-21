import { DaemonClient } from './client.js';
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

    const client = new DaemonClient(VAULT_DIR);
    await client.post('/sessions/unregister', { session_id: input.sessionId });
  } catch (error) {
    process.stderr.write(`[myco] session-end error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'session-end');
  }
}
