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
      type: 'tool_failure',
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      error: input.error,
      is_interrupt: input.is_interrupt,
      session_id: sessionId,
    });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({
        type: 'tool_failure',
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        error: input.error,
        is_interrupt: input.is_interrupt,
      });
    }
  } catch (error) {
    process.stderr.write(`[myco] post-tool-use-failure error: ${(error as Error).message}\n`);
  }
}
