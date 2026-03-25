import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID ?? `s-${Date.now()}`;

    const client = new DaemonClient(VAULT_DIR);

    const result = await client.post('/events', {
      type: 'subagent_stop',
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      last_assistant_message: input.last_assistant_message,
      agent_transcript_path: input.agent_transcript_path,
      session_id: sessionId,
    });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({
        type: 'subagent_stop',
        agent_id: input.agent_id,
        agent_type: input.agent_type,
        last_assistant_message: input.last_assistant_message,
        agent_transcript_path: input.agent_transcript_path,
      });
    }
  } catch (error) {
    process.stderr.write(`[myco] subagent-stop error: ${(error as Error).message}\n`);
  }
}
