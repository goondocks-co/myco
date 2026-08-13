import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readTranscriptMeta } from '@myco/hooks/transcript-meta.js';

/**
 * `readTranscriptMeta` supports two transcript shapes:
 *   1. Codex's wrapped `session_meta` — the whole payload lives on line 1.
 *   2. Claude Code's headerless shape — structural fields like `entrypoint`
 *      only appear a few lines in, on an attachment/user record, not on
 *      line 1.
 *
 * These tests pin both, plus the merge rules for the headerless case:
 * scalars only, first-value-wins, nested objects on later lines ignored.
 */
describe('readTranscriptMeta', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-meta-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLines(rows: unknown[]): string {
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  it('returns the session_meta payload unchanged when line 1 is the wrapper (Codex regression pin)', () => {
    const file = writeLines([
      { type: 'session_meta', timestamp: 'x', payload: { id: 'abc', cwd: '/repo', source: 'cli' } },
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
    ]);
    expect(readTranscriptMeta(file)).toEqual({ id: 'abc', cwd: '/repo', source: 'cli' });
  });

  it('scans header lines to find entrypoint when it is absent from line 1 (Claude Code SDK shape)', () => {
    const file = writeLines([
      { type: 'queue-operation', id: 'op1' },
      { type: 'last-prompt', value: 'noop' },
      {
        type: 'attachment',
        cwd: '/repo/proj',
        version: '2.1.30',
        userType: 'external',
        gitBranch: 'main',
        entrypoint: 'sdk-py',
      },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hello' } },
    ]);
    const meta = readTranscriptMeta(file);
    expect(meta?.entrypoint).toBe('sdk-py');
    expect(meta?.cwd).toBe('/repo/proj');
    expect(meta?.version).toBe('2.1.30');
  });

  it('scans header lines to find entrypoint sdk-ts', () => {
    const file = writeLines([
      { type: 'queue-operation', id: 'op1' },
      { type: 'attachment', cwd: '/repo/proj', entrypoint: 'sdk-ts' },
    ]);
    expect(readTranscriptMeta(file)?.entrypoint).toBe('sdk-ts');
  });

  it('surfaces entrypoint cli for an ordinary interactive transcript', () => {
    const file = writeLines([
      { type: 'queue-operation', id: 'op1' },
      { type: 'attachment', cwd: '/repo/proj', entrypoint: 'cli' },
    ]);
    expect(readTranscriptMeta(file)?.entrypoint).toBe('cli');
  });

  it('first-value-wins: does not let a later line override a field the first line already set', () => {
    const file = writeLines([
      { type: 'queue-operation', cwd: '/first/line/cwd' },
      { type: 'attachment', cwd: '/later/line/cwd', entrypoint: 'sdk-py' },
    ]);
    const meta = readTranscriptMeta(file);
    expect(meta?.cwd).toBe('/first/line/cwd');
    expect(meta?.entrypoint).toBe('sdk-py');
  });

  it('does not deep-merge nested objects from lines after the first', () => {
    const file = writeLines([
      { type: 'queue-operation', id: 'op1' },
      { type: 'attachment', entrypoint: 'sdk-py', nested: { a: 1 } },
    ]);
    const meta = readTranscriptMeta(file);
    expect(meta?.entrypoint).toBe('sdk-py');
    expect(meta?.nested).toBeUndefined();
  });

  it('keeps line 1 nested fields reachable when line 1 is direct (non-wrapper) meta', () => {
    const file = writeLines([
      { id: 'x', source: { subagent: { thread_spawn: { parent_thread_id: 'p1' } } } },
      { type: 'other', unrelated: true },
    ]);
    const meta = readTranscriptMeta(file);
    expect(meta?.id).toBe('x');
    expect((meta?.source as { subagent?: unknown } | undefined)?.subagent).toEqual({
      thread_spawn: { parent_thread_id: 'p1' },
    });
  });

  it('bounds the scan to the declared header-line budget', () => {
    const rows: unknown[] = [{ type: 'queue-operation', id: 'op1' }];
    for (let i = 0; i < 30; i++) rows.push({ type: 'filler', n: i });
    rows.push({ type: 'attachment', entrypoint: 'sdk-py' });
    const file = writeLines(rows);
    // entrypoint sits past the 25-line budget, so it must not surface.
    expect(readTranscriptMeta(file)?.entrypoint).toBeUndefined();
  });

  it('returns null for a missing file', () => {
    expect(readTranscriptMeta(path.join(dir, 'does-not-exist.jsonl'))).toBeNull();
  });

  it('returns null for an empty file', () => {
    const file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    expect(readTranscriptMeta(file)).toBeNull();
  });
});
