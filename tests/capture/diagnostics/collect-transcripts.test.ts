import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { seedSession } from '../../helpers/sessions.js'; // supports id/agent/startedAt/transcriptPath (tests/helpers/sessions.ts:32)
import { collectTranscripts } from '@myco/capture/diagnostics/collect-transcripts.js';

beforeEach(() => { setupTestDb(); cleanTestDb(); });
afterAll(() => teardownTestDb());

const PROSE = 'TRANSCRIPT_PROSE_planted';

function writeTranscript(dir: string, name: string): string {
  const p = path.join(dir, name);
  writeFileSync(
    p,
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't', message: { role: 'user', content: PROSE } }) + '\n',
  );
  return p;
}

describe('collectTranscripts', () => {
  test('skeleton by default; full copy only when includeContent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diag-'));
    const db = getDatabase();
    const tp = writeTranscript(dir, 's1.jsonl');
    seedSession({ id: 's1', agent: 'claude-code', startedAt: 1000, transcriptPath: tp });

    const def = await collectTranscripts({ db, window: { since: 0, until: 2000 }, includeContent: false });
    const skel = def.files.find((f) => f.path === 'transcripts/s1.skeleton.jsonl');
    expect(skel).toBeDefined();
    expect(String(skel!.data)).not.toContain(PROSE);
    expect(def.files.some((f) => f.path.endsWith('.full.jsonl'))).toBe(false);

    const full = await collectTranscripts({ db, window: { since: 0, until: 2000 }, includeContent: true });
    const fullFile = full.files.find((f) => f.path === 'transcripts/s1.full.jsonl');
    expect(String(fullFile!.data)).toContain(PROSE);
  });

  test('missing transcript file becomes a note + error, not a throw', async () => {
    const db = getDatabase();
    seedSession({ id: 's2', agent: 'claude-code', startedAt: 1000, transcriptPath: '/nonexistent/x.jsonl' });
    const res = await collectTranscripts({ db, window: { since: 0, until: 2000 }, includeContent: false });
    expect(res.files.length).toBe(0);
    expect(res.errors.length + res.notes.length).toBeGreaterThan(0);
  });
});
