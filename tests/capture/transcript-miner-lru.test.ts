import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { TranscriptMiner } from '@myco/capture/transcript-miner.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('TranscriptMiner parseCache LRU + short-circuit', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lru-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(p: string, prompts: string[]): void {
    const lines: string[] = [];
    for (const text of prompts) {
      lines.push(JSON.stringify({
        type: 'user', promptId: `p-${text}`, message: { role: 'user', content: text },
      }));
      lines.push(JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }));
    }
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }

  it('bounds parseCache to the configured LRU cap', () => {
    const miner = new TranscriptMiner();

    // 40 distinct transcripts > the 32-entry cap.
    const paths: string[] = [];
    for (let i = 0; i < 40; i++) {
      const sessionId = `s-lru-${i}`;
      seedSession({ id: sessionId, agent: 'claude-code' });
      const tp = path.join(tmpDir, `t-${i}.jsonl`);
      writeTranscript(tp, [`prompt-${i}`]);
      paths.push(tp);
      miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
    }

    // Inspect the private cache via indexed access — this is a white-box test
    // guarding the bound, not a public API contract.
    const cache = (miner as unknown as { parseCache: Map<string, unknown> }).parseCache;
    expect(cache.size).toBeLessThanOrEqual(32);
    // Oldest entries should have been evicted; newest must still be present.
    expect(cache.has(paths[0])).toBe(false);
    expect(cache.has(paths[paths.length - 1])).toBe(true);
  });

  it('keeps a hot entry resident when newer cold entries churn through', () => {
    const miner = new TranscriptMiner();

    const hotSessionId = 's-hot';
    seedSession({ id: hotSessionId, agent: 'claude-code' });
    const hotPath = path.join(tmpDir, 't-hot.jsonl');
    writeTranscript(hotPath, ['hot-prompt']);
    miner.reconcileBatchKinds(hotSessionId, { agent: 'claude-code', transcriptPath: hotPath });

    // Churn 40 cold transcripts, but touch the hot path between each.
    for (let i = 0; i < 40; i++) {
      const sid = `s-cold-${i}`;
      seedSession({ id: sid, agent: 'claude-code' });
      const tp = path.join(tmpDir, `cold-${i}.jsonl`);
      writeTranscript(tp, [`cold-${i}`]);
      miner.reconcileBatchKinds(sid, { agent: 'claude-code', transcriptPath: tp });
      // Touch hot path — short-circuit path still moves it to LRU tail.
      miner.reconcileBatchKinds(hotSessionId, { agent: 'claude-code', transcriptPath: hotPath });
    }

    const cache = (miner as unknown as { parseCache: Map<string, unknown> }).parseCache;
    expect(cache.has(hotPath)).toBe(true);
  });

  it('short-circuits repeat reconciles when the file has not grown', () => {
    const sessionId = 's-shortcircuit';
    seedSession({ id: sessionId, agent: 'claude-code' });
    const tp = path.join(tmpDir, 'unchanged.jsonl');
    writeTranscript(tp, ['only']);

    const miner = new TranscriptMiner();
    // First pass performs the real work.
    const first = miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
    expect(first.inserted).toBe(1);

    // Subsequent passes must short-circuit cheaply (no DB scan, no reparse).
    // We assert the no-op result; if the short-circuit regresses, the
    // idempotent pipeline would still report 0 but we'd pay the DB cost.
    for (let i = 0; i < 5; i++) {
      const r = miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
      expect(r).toEqual({ reclassified: 0, inserted: 0, errors: [] });
    }
  });

  it('does NOT short-circuit after the transcript grows', () => {
    const sessionId = 's-grows';
    seedSession({ id: sessionId, agent: 'claude-code' });
    const tp = path.join(tmpDir, 'grows.jsonl');
    writeTranscript(tp, ['first']);

    const miner = new TranscriptMiner();
    miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });

    // Append another turn — short-circuit guard must fail and real reconcile runs.
    fs.appendFileSync(tp,
      JSON.stringify({ type: 'user', promptId: 'p2', message: { role: 'user', content: 'second' } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) + '\n',
    );

    const second = miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
    expect(second.inserted).toBe(1);

    // And another idempotent pass after the growth settles must short-circuit again.
    const third = miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
    expect(third).toEqual({ reclassified: 0, inserted: 0, errors: [] });
  });

  it('does NOT short-circuit after a rotation (inode change)', () => {
    const sessionId = 's-rotate';
    seedSession({ id: sessionId, agent: 'claude-code' });
    const tp = path.join(tmpDir, 'rotates.jsonl');
    writeTranscript(tp, ['pre']);

    const miner = new TranscriptMiner();
    miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });

    // Rotation: unlink + recreate with same size but different inode + content.
    fs.rmSync(tp);
    writeTranscript(tp, ['post']);

    const after = miner.reconcileBatchKinds(sessionId, { agent: 'claude-code', transcriptPath: tp });
    // A new prompt was recovered from the rotated transcript — short-circuit
    // must not have blocked the real work.
    expect(after.inserted).toBeGreaterThanOrEqual(1);
  });
});
