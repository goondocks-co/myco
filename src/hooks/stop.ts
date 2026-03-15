import { EventBuffer } from '../capture/buffer.js';
import { BufferProcessor } from '../capture/processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote } from '../index/rebuild.js';
import { loadConfig } from '../config/loader.js';
import { createLlmBackend } from '../intelligence/llm.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID;
    if (!sessionId) return;

    const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
    if (!buffer.exists() || buffer.count() === 0) return;

    const config = loadConfig(VAULT_DIR);
    const backend = await createLlmBackend(config.intelligence);

    // Process buffer through LLM
    const processor = new BufferProcessor(backend);
    const events = buffer.readAll();
    const result = await processor.process(events, sessionId);

    // Write session note
    const writer = new VaultWriter(VAULT_DIR);
    const sessionPath = writer.writeSession({
      id: sessionId,
      user: config.team.user || undefined,
      started: events[0]?.timestamp as string ?? new Date().toISOString(),
      tags: [],
      summary: `# Session ${sessionId}\n\n## Summary\n${result.summary}`,
    });

    // Update index
    const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));
    indexNote(index, VAULT_DIR, sessionPath);

    // Write promoted observations as memory notes and index each one
    for (const obs of result.observations) {
      const memPath = writer.writeMemory({
        id: `${obs.type}-${sessionId.slice(-6)}-${Date.now()}`,
        observation_type: obs.type,
        session: `[[session-${sessionId}]]`,
        tags: obs.tags,
        content: `# ${obs.title}\n\n${obs.content}`,
      });
      indexNote(index, VAULT_DIR, memPath);
    }

    index.close();

    // Clean up buffer (unless degraded — preserve for retry)
    if (!result.degraded) {
      buffer.delete();
    }
  } catch (error) {
    console.error(`[myco] stop error: ${(error as Error).message}`);
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
