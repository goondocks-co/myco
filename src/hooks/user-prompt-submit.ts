import { DaemonClient } from './client.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const prompt = input.prompt ?? '';
    const sessionId = input.session_id ?? `s-${Date.now()}`;

    const client = new DaemonClient(VAULT_DIR);
    const result = await client.post('/events', {
      type: 'user_prompt', prompt, session_id: sessionId,
    });

    if (!result.ok) {
      const bufferDir = path.join(VAULT_DIR, 'buffer');
      fs.mkdirSync(bufferDir, { recursive: true });
      fs.appendFileSync(
        path.join(bufferDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user_prompt', prompt, timestamp: new Date().toISOString() }) + '\n',
      );
    }
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit error: ${(error as Error).message}\n`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 100);
  });
}

main();
