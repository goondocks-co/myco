/**
 * Phase 4 regression test: concurrent appends from two processes to
 * the same session buffer journal do not interleave at the byte
 * level.
 *
 * Two writers can reach `EventBuffer.append` for the same session:
 * the daemon's event dispatcher (when an event POST succeeds) and
 * the hook subprocess (when the POST fails and the event falls back
 * to the durable buffer). The `withFileLockSync` wrapping the
 * appendFileSync call serializes those callers so every line in the
 * JSONL remains valid, even for events larger than PIPE_BUF.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const APPENDER_HELPER = path.resolve('tests/helpers/event-buffer-appender-helper.ts');

describe.skipIf(!supported)('EventBuffer.append — concurrent-writer serialization', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buffer-concurrent-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function spawnAppender(sessionId: string, count: number, writerId: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['run', APPENDER_HELPER, bufferDir, sessionId, String(count), writerId],
        { stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd() },
      );
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('exit', (code) => {
        if (code === 0) resolve(0);
        else reject(new Error(`appender ${writerId} exited ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });
  }

  it('two processes appending oversized events do not corrupt any JSONL line', async () => {
    const sessionId = 'concurrent-test-001';
    const perWriter = 30;

    await Promise.all([
      spawnAppender(sessionId, perWriter, 'A'),
      spawnAppender(sessionId, perWriter, 'B'),
    ]);

    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    const content = fs.readFileSync(bufferPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);

    // Every line is independently valid JSON. Without the lock, an
    // oversized event from one writer can interleave with another's
    // and split a single line into two JSON-invalid fragments.
    expect(lines.length).toBe(perWriter * 2);
    for (const line of lines) {
      // Throws if the line isn't valid JSON — the assertion is that
      // none of the lines is half from writer A and half from writer B.
      const parsed = JSON.parse(line) as { tool_input: { writer: string; seq: number } };
      expect(parsed.tool_input).toBeDefined();
      expect(['A', 'B']).toContain(parsed.tool_input.writer);
      expect(typeof parsed.tool_input.seq).toBe('number');
    }

    // Each writer's events are all present and sequence numbers cover
    // the full range. (Order across writers is unconstrained — the
    // lock serializes writes but does not impose a global order.)
    const byWriter: Record<string, number[]> = { A: [], B: [] };
    for (const line of lines) {
      const parsed = JSON.parse(line) as { tool_input: { writer: string; seq: number } };
      byWriter[parsed.tool_input.writer].push(parsed.tool_input.seq);
    }
    for (const w of ['A', 'B'] as const) {
      const seqs = byWriter[w].sort((a, b) => a - b);
      expect(seqs.length).toBe(perWriter);
      expect(seqs).toEqual(Array.from({ length: perWriter }, (_, i) => i));
    }
  }, 30_000);
});
