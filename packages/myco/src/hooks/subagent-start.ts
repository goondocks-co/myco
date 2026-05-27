import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { writeHookResponse } from './response.js';
import { captureHookEvent } from './send-event.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const agentId = input.raw.agent_id;
    const agentType = input.raw.agent_type;
    await captureHookEvent(VAULT_DIR, 'subagent-start', input, {
      type: 'subagent_start',
      agent_id: agentId,
      agent_type: agentType,
    });

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });
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
