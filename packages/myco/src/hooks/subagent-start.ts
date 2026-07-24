import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { writeHookResponse } from './response.js';
import { captureHookEvent } from './send-event.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export async function main(lockNamespace?: PerUserLockNamespace) {
  // Use the shared provisioning gate like every other event hook
  // (send-event, post-tool-use, user-prompt-submit). The legacy
  // `resolveVaultDir() + existsSync(myco.yaml)` pattern bailed in a
  // never-provisioned git project where the sibling hooks would
  // auto-provision and capture — an inconsistent gate that could hide a
  // capture gap. `resolveProvisionedVaultDir` git-gates, auto-provisions
  // the cold path, and runs the one-shot migration.
  const VAULT_DIR = resolveProvisionedVaultDir(undefined, lockNamespace);
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const agentId = input.raw.agent_id;
    const agentType = input.raw.agent_type;
    await captureHookEvent(
      VAULT_DIR,
      'subagent-start',
      input,
      {
        type: 'subagent_start',
        agent_id: agentId,
        agent_type: agentType,
      },
      lockNamespace,
    );

    const client = createHookDaemonClient(VAULT_DIR, { sessionId }, lockNamespace);
    const contextResult = await client.post('/context/subagent', {
      session_id: sessionId,
      agent: symbiont,
      agent_id: agentId,
      agent_type: agentType,
    }, { timeoutMs: 3000 });

    const text = contextResult.ok && contextResult.data?.text ? contextResult.data.text : '';
    if (text) {
      writeHookResponse(symbiont, 'subagent-start', { additionalContext: text });
      return;
    }
  } catch (error) {
    process.stderr.write(`[myco] subagent-start error: ${(error as Error).message}\n`);
  }

  writeHookResponse(symbiont, 'subagent-start');
}
