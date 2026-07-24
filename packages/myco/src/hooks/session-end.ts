import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export async function main(lockNamespace?: PerUserLockNamespace) {
  const VAULT_DIR = resolveProvisionedVaultDir(undefined, lockNamespace);
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    if (!input.sessionId) return;

    const client = createHookDaemonClient(
      VAULT_DIR,
      { sessionId: input.sessionId },
      lockNamespace,
    );
    await client.post('/sessions/unregister', { session_id: input.sessionId });
  } catch (error) {
    process.stderr.write(`[myco] session-end error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'session-end');
  }
}
