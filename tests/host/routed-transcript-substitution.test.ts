/**
 * Tests for the host-side `transcript_path` substitution (plan C4).
 *
 * `resolveRoutedTranscriptPathForSession` reads the materialized cache under
 * `resolveRoutedTranscriptsDir()` → `resolveHostControlDir` → `resolveTeamsHome`,
 * which honors `MYCO_TEAM_HOME`; tests point that at a fresh tmpdir so the
 * resolver never touches the developer's real `~/.myco-team` (same env-override +
 * tmpdir pattern as `tests/host/routed-transcript.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hostSubstitutedTranscriptPath,
  resolveRoutedTranscriptPathForSession,
} from '@myco/host/routed-transcript';
import { resolveRoutedTranscriptPath } from '@myco/grove/paths';

const MACHINE = 'alice_a1b2c3d4';
const SESSION = 'sess-c4-0001';
const MEMBER_PATH = '/Users/alice/.claude/projects/p/sess-c4-0001.jsonl';

/** Materialize a host transcript file at the C2-keyed path and return it. */
function materialize(machine: string, session: string, tid: string, content = '{"type":"x"}\n'): string {
  const filePath = resolveRoutedTranscriptPath(machine, session, tid);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('C4 — resolveRoutedTranscriptPathForSession', () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-c4-resolve-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('resolves the materialized file for (machine, session)', () => {
    const tid = `tx_${'a'.repeat(32)}`;
    const filePath = materialize(MACHINE, SESSION, tid);
    expect(resolveRoutedTranscriptPathForSession(MACHINE, SESSION)).toBe(filePath);
  });

  test('rotation: returns the most-recently-modified tid, ignoring .lock siblings', () => {
    const old = materialize(MACHINE, SESSION, `tx_${'a'.repeat(32)}`);
    const live = materialize(MACHINE, SESSION, `tx_${'b'.repeat(32)}`);
    // A .lock sibling from the materializer's flock must never be selected.
    fs.writeFileSync(`${live}.lock`, '');
    // Make the rotation ordering deterministic regardless of write timing.
    const base = Math.floor(Date.now() / 1000);
    fs.utimesSync(old, base - 100, base - 100);
    fs.utimesSync(live, base, base);

    expect(resolveRoutedTranscriptPathForSession(MACHINE, SESSION)).toBe(live);
  });

  test('returns null when the session dir is absent (bytes not drained yet)', () => {
    expect(resolveRoutedTranscriptPathForSession(MACHINE, SESSION)).toBeNull();
  });

  test('returns null when the session dir holds no .jsonl (only a lock)', () => {
    const dir = path.dirname(resolveRoutedTranscriptPath(MACHINE, SESSION, `tx_${'a'.repeat(32)}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stray.jsonl.lock'), '');
    expect(resolveRoutedTranscriptPathForSession(MACHINE, SESSION)).toBeNull();
  });

  test('a traversal-shaped id resolves to null rather than escaping the cache root', () => {
    expect(resolveRoutedTranscriptPathForSession('../../etc', SESSION)).toBeNull();
    expect(resolveRoutedTranscriptPathForSession(MACHINE, '..')).toBeNull();
  });
});

describe('C4 — hostSubstitutedTranscriptPath', () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-c4-sub-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('local (non-host-served) request: member path is UNCHANGED', () => {
    materialize(MACHINE, SESSION, `tx_${'a'.repeat(32)}`); // present but must be ignored
    const result = hostSubstitutedTranscriptPath({
      hostServed: false,
      machineId: MACHINE,
      sessionId: SESSION,
      memberTranscriptPath: MEMBER_PATH,
    });
    expect(result).toEqual({ transcriptPath: MEMBER_PATH, action: 'unchanged' });
  });

  test('host-served with a materialized file: substitutes the host path', () => {
    const filePath = materialize(MACHINE, SESSION, `tx_${'a'.repeat(32)}`);
    const result = hostSubstitutedTranscriptPath({
      hostServed: true,
      machineId: MACHINE,
      sessionId: SESSION,
      memberTranscriptPath: MEMBER_PATH,
    });
    expect(result).toEqual({ transcriptPath: filePath, action: 'substituted' });
    expect(result.transcriptPath).not.toBe(MEMBER_PATH);
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);
  });

  test('host-served but nothing materialized: degrades to NO path (no bogus stamp)', () => {
    const result = hostSubstitutedTranscriptPath({
      hostServed: true,
      machineId: MACHINE,
      sessionId: SESSION,
      memberTranscriptPath: MEMBER_PATH,
    });
    expect(result).toEqual({ transcriptPath: undefined, action: 'degraded-missing' });
  });

  test('host-served but no member path on the event: unchanged (no over-substitution)', () => {
    materialize(MACHINE, SESSION, `tx_${'a'.repeat(32)}`);
    const result = hostSubstitutedTranscriptPath({
      hostServed: true,
      machineId: MACHINE,
      sessionId: SESSION,
      memberTranscriptPath: undefined,
    });
    expect(result).toEqual({ transcriptPath: undefined, action: 'unchanged' });
  });

  test('host-served with no machineId: degrades safely', () => {
    materialize(MACHINE, SESSION, `tx_${'a'.repeat(32)}`);
    const result = hostSubstitutedTranscriptPath({
      hostServed: true,
      machineId: undefined,
      sessionId: SESSION,
      memberTranscriptPath: MEMBER_PATH,
    });
    expect(result).toEqual({ transcriptPath: undefined, action: 'degraded-missing' });
  });
});
