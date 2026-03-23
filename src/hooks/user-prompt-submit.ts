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
    const prompt = input.prompt ?? '';
    const sessionId = input.session_id ?? `s-${Date.now()}`;

    const client = new DaemonClient(VAULT_DIR);
    // Spawn daemon if needed but don't block on full health check backoff.
    // The event POST will fail fast if daemon isn't ready — buffer absorbs it.
    if (!(await client.isHealthy())) {
      client.spawnDaemon();
    }

    // Forward prompt as event for capture
    const eventResult = await client.post('/events', {
      type: 'user_prompt', prompt, session_id: sessionId,
    });

    if (!eventResult.ok) {
      // Daemon still unreachable — write directly to buffer for later processing
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({ type: 'user_prompt', prompt });
    }

    // Search for relevant spores to inject as context for this prompt.
    // The daemon does a vector search against the prompt text and returns
    // any high-relevance spores. This is fast (~20ms) — no LLM call.
    const contextResult = await client.post('/context/prompt', {
      prompt,
      session_id: sessionId,
    });

    // Always include the session ID so the agent can pass it to myco_remember.
    // Uses Session:: format consistent with daemon context injection (Branch::, Session::).
    const sessionLine = `Session:: \`${sessionId}\``;
    const contextText = contextResult.ok && contextResult.data?.text
      ? `${contextResult.data.text}\n${sessionLine}`
      : sessionLine;

    process.stdout.write(contextText);
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit error: ${(error as Error).message}\n`);
  }
}
