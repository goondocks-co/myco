import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    // No real transcript exists for this synthetic session anywhere on
    // disk, but leaving `discover` at its default would still touch the
    // real filesystem via findTranscriptFor on the ENOENT-fallback branch —
    // inject a no-op so this stays fully hermetic.
    const res = await collectTranscripts({
      db,
      window: { since: 0, until: 2000 },
      includeContent: false,
      discover: () => null,
    });
    expect(res.files.length).toBe(0);
    expect(res.errors.length + res.notes.length).toBeGreaterThan(0);
  });

  test('stale recorded transcript_path falls back to discovery: skeleton emitted, note present, no error', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diag-'));
    const db = getDatabase();
    const discoveredPath = writeTranscript(dir, 'discovered.jsonl');
    seedSession({
      id: 's3',
      agent: 'claude-code',
      startedAt: 1000,
      // The recorded path itself no longer exists on disk (e.g. a
      // worktree-suffixed project dir that was removed) — this is the
      // ENOENT-with-a-discoverable-alternative case discovery must recover.
      transcriptPath: '/definitely/does/not/exist/x.jsonl',
    });

    const res = await collectTranscripts({
      db,
      window: { since: 0, until: 2000 },
      includeContent: false,
      discover: (agent, sessionId) => (agent === 'claude-code' && sessionId === 's3' ? discoveredPath : null),
    });

    const skel = res.files.find((f) => f.path === 'transcripts/s3.skeleton.jsonl');
    expect(skel).toBeDefined();
    expect(
      res.notes.some((n) => n.includes('s3') && n.includes('recorded transcript_path missing on disk') && n.includes('discovery')),
    ).toBe(true);
    expect(res.errors.length).toBe(0);
  });

  test('stale recorded transcript_path with no discoverable alternative still records an error', async () => {
    const db = getDatabase();
    seedSession({
      id: 's4',
      agent: 'claude-code',
      startedAt: 1000,
      transcriptPath: '/definitely/does/not/exist/x.jsonl',
    });

    const res = await collectTranscripts({
      db,
      window: { since: 0, until: 2000 },
      includeContent: false,
      discover: () => null,
    });

    expect(res.files.length).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]!.layer).toBe('transcript:s4');
  });

  test('a non-ENOENT read failure (EISDIR) records an error and does NOT trigger discovery', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diag-'));
    const db = getDatabase();
    // transcript_path points at a DIRECTORY, not a missing file — readFile
    // fails with EISDIR, not ENOENT. The stale-path fallback is deliberately
    // scoped to ENOENT only (a genuinely absent file); any other failure
    // (permissions, EISDIR, a truncated read) is a different kind of bug
    // that discovery masking would only hide.
    const dirAsTranscriptPath = path.join(dir, 'not-a-file');
    mkdirSync(dirAsTranscriptPath);
    const discoveredPath = writeTranscript(dir, 'should-not-be-used.jsonl');
    let discoverCalled = false;
    seedSession({ id: 's5', agent: 'claude-code', startedAt: 1000, transcriptPath: dirAsTranscriptPath });

    const res = await collectTranscripts({
      db,
      window: { since: 0, until: 2000 },
      includeContent: false,
      discover: () => {
        discoverCalled = true;
        return discoveredPath;
      },
    });

    expect(discoverCalled).toBe(false);
    expect(res.files.length).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]!.layer).toBe('transcript:s5');
  });

  test('unsafe session id is sanitized in emitted bundle paths', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diag-'));
    const db = getDatabase();
    const tp = writeTranscript(dir, 'evil.jsonl');
    const unsafeId = '../evil';
    seedSession({ id: unsafeId, agent: 'claude-code', startedAt: 1000, transcriptPath: tp });

    const res = await collectTranscripts({ db, window: { since: 0, until: 2000 }, includeContent: false });
    expect(res.files.length).toBe(1);
    const emitted = res.files[0]!.path;
    expect(emitted.startsWith('transcripts/')).toBe(true);
    const rest = emitted.slice('transcripts/'.length);
    expect(rest.includes('/')).toBe(false);
    expect(rest.includes('..')).toBe(false);
    expect(res.notes.some((n) => n.includes('unsafe session id sanitized'))).toBe(true);
    expect(res.notes.some((n) => n.includes(unsafeId))).toBe(false);
  });
});
