import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID ?? `s-${Date.now()}`;

    // Hot path: append to JSONL buffer — fast, no processing
    const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
    buffer.append({
      type: 'tool_use',
      tool: input.tool_name,
      input: input.tool_input,
      output_preview: typeof input.tool_output === 'string'
        ? input.tool_output.slice(0, 200)
        : undefined,
    });
  } catch (error) {
    // OAK lesson: never let hook failure block the agent
    console.error(`[myco] post-tool-use error: ${(error as Error).message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 100);
  });
}

main();
