import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { EventBuffer } from '../capture/buffer.js';
import { BufferProcessor } from '../daemon/processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote } from '../index/rebuild.js';
import { loadConfig } from '../config/loader.js';
import { createLlmProvider } from '../intelligence/llm.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeObservationNotes } from '../vault/observations.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID;
    if (!sessionId) return;

    const config = loadConfig(VAULT_DIR);
    const client = new DaemonClient(VAULT_DIR);

    const result = await client.post('/events/stop', {
      session_id: sessionId,
      user: config.team.user || undefined,
    });
    if (result.ok) return; // Daemon handled it (including transcript mining)

    // Degraded: process locally — but never overwrite an existing session file.
    // The daemon's append logic is authoritative; the degraded path only creates
    // a session file when one doesn't exist yet (true cold start).
    const date = new Date().toISOString().slice(0, 10);
    const sessionFile = path.join(VAULT_DIR, 'sessions', date, `session-${sessionId}.md`);
    if (fs.existsSync(sessionFile)) return; // Daemon will handle it when it's back

    const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
    if (!buffer.exists() || buffer.count() === 0) return;

    const llmProvider = createLlmProvider(config.intelligence.llm);
    const processor = new BufferProcessor(llmProvider, config.intelligence.llm.context_window);
    const events = buffer.readAll();
    const processed = await processor.process(events, sessionId);

    const writer = new VaultWriter(VAULT_DIR);
    const title = `Session ${sessionId}`;
    const sessionPath = writer.writeSession({
      id: sessionId,
      user: config.team.user || undefined,
      started: events[0]?.timestamp as string ?? new Date().toISOString(),
      tags: [],
      summary: `# ${title}\n\n## Summary\n${processed.summary}`,
    });

    const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));
    indexNote(index, VAULT_DIR, sessionPath);

    writeObservationNotes(processed.observations, sessionId, writer, index, VAULT_DIR);

    index.close();
  } catch (error) {
    process.stderr.write(`[myco] stop error: ${(error as Error).message}\n`);
  }
}

main();
