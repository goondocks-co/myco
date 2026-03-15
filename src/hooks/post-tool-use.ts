import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID ?? `s-${Date.now()}`;

    const client = new DaemonClient(VAULT_DIR);
    const result = await client.post('/events', {
      type: 'tool_use',
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      output_preview: typeof input.tool_output === 'string' ? input.tool_output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
      session_id: sessionId,
    });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({
        type: 'tool_use',
        tool: input.tool_name,
        input: input.tool_input,
        output_preview: typeof input.tool_output === 'string' ? input.tool_output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
      });
    }
  } catch (error) {
    process.stderr.write(`[myco] post-tool-use error: ${(error as Error).message}\n`);
  }
}

main();
