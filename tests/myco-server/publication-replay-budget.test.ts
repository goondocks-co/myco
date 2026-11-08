import { expect, test } from 'bun:test';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { withDocumentStores, captureDocumentTranscript } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { user, reply, MIN } from './helpers/document-publication.js';

const REPLAY_TURNS = 3000;
const REPLAY_CPU_BUDGET_MS = 30000;

test('long publication retains every turn within its replay CPU budget', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const body = Array.from({ length: REPLAY_TURNS }, (_, i) => user(`turn-${i}`, `prompt ${i}`) + reply(`answer ${i}`)).join('');
    const env = await captureDocumentTranscript(db, blobs, 'replay', 'tx_0123456789abcdef0123456789abcdef', body, at, 0, 'codex');
    const source = await db.prepare('SELECT transcript_id,size FROM transcripts').first();
    const start = process.cpuUsage();
    for (let pass = 0; ; pass++) {
      expect(pass).toBeLessThan(100);
      if (!(await publishDocuments(env, at + 20 * MIN, { calls: 500, deadline: Date.now() + 300000, clock: Date.now })).more) break;
    }
    const cpu = process.cpuUsage(start);
    expect(await db.prepare("SELECT prompts,replies FROM session_documents WHERE session_id='replay'").first(), target)
      .toEqual({ prompts: REPLAY_TURNS, replies: REPLAY_TURNS });
    expect(await db.prepare('SELECT transcript_id,size FROM transcripts').first(), target).toEqual(source);
    expect((cpu.user + cpu.system) / 1000, target).toBeLessThan(REPLAY_CPU_BUDGET_MS);
  });
}, 180000);
