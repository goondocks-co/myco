import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
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

    // Forward prompt as event for capture
    const eventResult = await client.post('/events', {
      type: 'user_prompt', prompt, session_id: sessionId,
    });

    if (!eventResult.ok) {
      const bufferDir = path.join(VAULT_DIR, 'buffer');
      fs.mkdirSync(bufferDir, { recursive: true });
      fs.appendFileSync(
        path.join(bufferDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user_prompt', prompt, timestamp: new Date().toISOString() }) + '\n',
      );
    }

    // Search for relevant memories to inject as context for this prompt.
    // The daemon does a vector search against the prompt text and returns
    // any high-relevance memories. This is fast (~20ms) — no LLM call.
    const contextResult = await client.post('/context/prompt', {
      prompt,
      session_id: sessionId,
    });

    if (contextResult.ok && contextResult.data?.text) {
      process.stdout.write(contextResult.data.text);
    }
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit error: ${(error as Error).message}\n`);
  }
}

main();
