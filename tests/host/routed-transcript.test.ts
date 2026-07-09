/**
 * Tests for the host RECEIVE side of routed transcript capture (plan C2 + C3).
 *
 * `resolveRoutedTranscriptsDir` funnels through `resolveHostControlDir` →
 * `resolveTeamsHome`, which reads `MYCO_TEAM_HOME` from process.env — tests point
 * that at a fresh tmpdir so the default fs store never touches the developer's
 * real `~/.myco-team`, mirroring the env-override + tmpdir pattern in
 * `tests/host/registry.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_TRANSCRIPT_PUSH_BYTES,
  createFsRoutedTranscriptStore,
  createRoutedTranscriptHandler,
  decideChunkAction,
  deriveTranscriptId,
  type RoutedTranscriptStore,
} from '@myco/host/routed-transcript';
import { resolveRoutedTranscriptPath, resolveRoutedTranscriptsDir } from '@myco/grove/paths';
import type { RouteRequest } from '@myco/daemon/router';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

// ---------------------------------------------------------------------------
// C3 — transcript_id derivation + rotation
// ---------------------------------------------------------------------------

describe('deriveTranscriptId (C3)', () => {
  const base = { machineId: 'alice_a1b2c3d4', transcriptPath: '/home/alice/.claude/projects/p/s.jsonl', inode: 42 };

  test('is stable for the same (machine_id, path, inode)', () => {
    expect(deriveTranscriptId(base)).toBe(deriveTranscriptId({ ...base }));
  });

  test('rotates (new id) on inode change — mirrors the miner rotation gate', () => {
    expect(deriveTranscriptId({ ...base, inode: 43 })).not.toBe(deriveTranscriptId(base));
  });

  test('is machine_id-namespaced (same path+inode, different machine → different id)', () => {
    expect(deriveTranscriptId({ ...base, machineId: 'bob_99887766' })).not.toBe(deriveTranscriptId(base));
  });

  test('depends on the path (same machine+inode, different path → different id)', () => {
    expect(deriveTranscriptId({ ...base, transcriptPath: '/home/alice/other.jsonl' })).not.toBe(deriveTranscriptId(base));
  });

  test('a bigint inode equal in value to a number produces the same id', () => {
    expect(deriveTranscriptId({ ...base, inode: 42n })).toBe(deriveTranscriptId({ ...base, inode: 42 }));
  });

  test('output is a filesystem-safe segment (tx_ + 32 hex)', () => {
    expect(deriveTranscriptId(base)).toMatch(/^tx_[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// The pure offset gate
// ---------------------------------------------------------------------------

describe('decideChunkAction (offset gate)', () => {
  test('base_offset == current_size → append', () => {
    expect(decideChunkAction(10, 10)).toBe('append');
  });
  test('base_offset < current_size → replay', () => {
    expect(decideChunkAction(10, 4)).toBe('replay');
  });
  test('base_offset > current_size → gap', () => {
    expect(decideChunkAction(10, 20)).toBe('gap');
  });
});

// ---------------------------------------------------------------------------
// C2 — materializer (default fs store, hermetic tmp home)
// ---------------------------------------------------------------------------

describe('fs materializer store (C2)', () => {
  let tmp: string;
  let saved: string | undefined;
  const machineId = 'alice_a1b2c3d4';
  const sessionId = 'sess-1111-2222';
  const transcriptId = 'tx_deadbeefdeadbeefdeadbeefdeadbeef';
  let store: RoutedTranscriptStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-routed-tx-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    store = createFsRoutedTranscriptStore();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('base_offset == size appends and returns the post-append size; file lands at the keyed path', () => {
    const line = 'line1\n';
    const r = store.appendAtOffset(machineId, sessionId, transcriptId, 0, Buffer.from(line));
    expect(r).toEqual({ accepted: true, action: 'append', size: line.length });

    const expectedPath = resolveRoutedTranscriptPath(machineId, sessionId, transcriptId);
    expect(expectedPath.startsWith(resolveRoutedTranscriptsDir())).toBe(true);
    expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(line);
  });

  test('sequential in-order chunks append and reconstruct the file (line-boundary safe, §5.3)', () => {
    const a = '{"t":"a"}\n';
    const b = '{"t":"b"}\n';
    const r1 = store.appendAtOffset(machineId, sessionId, transcriptId, 0, Buffer.from(a));
    const r2 = store.appendAtOffset(machineId, sessionId, transcriptId, r1.size, Buffer.from(b));
    expect(r1.size).toBe(a.length);
    expect(r2.size).toBe(a.length + b.length);

    const content = fs.readFileSync(resolveRoutedTranscriptPath(machineId, sessionId, transcriptId), 'utf-8');
    expect(content).toBe(a + b);
    expect(content.split('\n').filter(Boolean)).toEqual(['{"t":"a"}', '{"t":"b"}']);
  });

  test('a gap (base_offset > size) is rejected with the current size; the file is not grown', () => {
    store.appendAtOffset(machineId, sessionId, transcriptId, 0, Buffer.from('abc'));
    const r = store.appendAtOffset(machineId, sessionId, transcriptId, 999, Buffer.from('xyz'));
    expect(r).toEqual({ accepted: false, action: 'gap', size: 3 });
    expect(fs.readFileSync(resolveRoutedTranscriptPath(machineId, sessionId, transcriptId), 'utf-8')).toBe('abc');
  });

  test('an idempotent re-POST of already-appended bytes is a no-op returning the current size (no duplication)', () => {
    const chunk = Buffer.from('hello\n');
    const first = store.appendAtOffset(machineId, sessionId, transcriptId, 0, chunk);
    expect(first.size).toBe(6);
    // Re-POST the SAME chunk at the SAME offset (retry after a lost ack).
    const replay = store.appendAtOffset(machineId, sessionId, transcriptId, 0, chunk);
    expect(replay).toEqual({ accepted: true, action: 'replay', size: 6 });
    expect(fs.readFileSync(resolveRoutedTranscriptPath(machineId, sessionId, transcriptId), 'utf-8')).toBe('hello\n');
  });

  test('distinct transcript_ids (rotation) materialize to distinct files under the same session dir', () => {
    const tidA = 'tx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tidB = 'tx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    store.appendAtOffset(machineId, sessionId, tidA, 0, Buffer.from('A\n'));
    store.appendAtOffset(machineId, sessionId, tidB, 0, Buffer.from('B\n'));
    expect(fs.readFileSync(resolveRoutedTranscriptPath(machineId, sessionId, tidA), 'utf-8')).toBe('A\n');
    expect(fs.readFileSync(resolveRoutedTranscriptPath(machineId, sessionId, tidB), 'utf-8')).toBe('B\n');
  });

  test('MAX_TRANSCRIPT_PUSH_BYTES stays one order below the 8 MB request-body limit', () => {
    expect(MAX_TRANSCRIPT_PUSH_BYTES).toBeGreaterThan(0);
    expect(MAX_TRANSCRIPT_PUSH_BYTES).toBeLessThan(8 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// C2 — route handler (base64 decode + validation + response mapping)
// ---------------------------------------------------------------------------

/** An in-memory store so handler tests exercise the wire contract without disk. */
function memoryStore(): RoutedTranscriptStore & { bytesFor(rel: string): Buffer } {
  const files = new Map<string, Buffer>();
  const key = (m: string, s: string, t: string) => `${m}/${s}/${t}`;
  return {
    appendAtOffset(m, s, t, baseOffset, bytes) {
      const k = key(m, s, t);
      const cur = files.get(k) ?? Buffer.alloc(0);
      const action = decideChunkAction(cur.length, baseOffset);
      if (action === 'append') {
        const next = Buffer.concat([cur, bytes]);
        files.set(k, next);
        return { accepted: true, action, size: next.length };
      }
      return { accepted: action === 'replay', action, size: cur.length };
    },
    bytesFor(rel) { return files.get(rel) ?? Buffer.alloc(0); },
  };
}

const req = (body: unknown): RouteRequest => ({ body, query: {}, params: {}, pathname: '/routed-capture/transcript' });

describe('POST /routed-capture/transcript handler (C2 wire contract)', () => {
  test('accepts a valid base64 delta and returns 200 { ok, action:append, size }', async () => {
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const payload = 'utf8 bytes 🌱 with multibyte\n';
    const res = await handler(req({
      machine_id: 'alice_a1b2c3d4',
      session_id: 'sess-1',
      transcript_id: 'tx_00000000000000000000000000000001',
      agent: 'claude-code',
      base_offset: 0,
      bytes: b64(payload),
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'append', size: Buffer.byteLength(payload, 'utf-8') });
    // Byte-exact round-trip through base64.
    expect(store.bytesFor('alice_a1b2c3d4/sess-1/tx_00000000000000000000000000000001').toString('utf-8')).toBe(payload);
  });

  test('a gap returns 409 { ok:false, error:offset_gap, size }', async () => {
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const common = { machine_id: 'm_1', session_id: 's', transcript_id: 'tx_0000000000000000000000000000000a' };
    await handler(req({ ...common, base_offset: 0, bytes: b64('abc') }));
    const res = await handler(req({ ...common, base_offset: 100, bytes: b64('xyz') }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'offset_gap', size: 3 });
  });

  test('an idempotent replay returns 200 { ok:true, action:replay, size }', async () => {
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const common = { machine_id: 'm_1', session_id: 's', transcript_id: 'tx_0000000000000000000000000000000b' };
    await handler(req({ ...common, base_offset: 0, bytes: b64('hello') }));
    const res = await handler(req({ ...common, base_offset: 0, bytes: b64('hello') }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'replay', size: 5 });
  });

  test('a malformed body → 400 invalid_body (missing field, negative offset, non-int)', async () => {
    const handler = createRoutedTranscriptHandler(memoryStore());
    for (const bad of [
      { session_id: 's', transcript_id: 'tx_x', base_offset: 0, bytes: '' }, // missing machine_id
      { machine_id: 'm_1', session_id: 's', transcript_id: 'tx_x', base_offset: -1, bytes: '' },
      { machine_id: 'm_1', session_id: 's', transcript_id: 'tx_x', base_offset: 1.5, bytes: '' },
    ]) {
      const res = await handler(req(bad));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'invalid_body' });
    }
  });

  test('a traversal-shaped key is refused 400 invalid_key by the default fs store guard', async () => {
    const handler = createRoutedTranscriptHandler(createFsRoutedTranscriptStore());
    const res = await handler(req({
      machine_id: '..', session_id: 's', transcript_id: 'tx_x', base_offset: 0, bytes: b64('x'),
    }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid_key' });
  });
});
