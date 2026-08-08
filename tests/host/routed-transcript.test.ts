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
  MAX_ROUTED_TRANSCRIPT_MEMBER_BYTES,
  MAX_TRANSCRIPT_PUSH_BYTES,
  createFsRoutedTranscriptStore,
  createRoutedTranscriptHandler,
  decideChunkAction,
  deriveTranscriptId,
  type RoutedTranscriptStore,
} from '@myco/host/routed-transcript';
import type { MycoRequestContext } from '@myco/grove/request-context';
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

  test('throws on a traversal-shaped machine_id — the assertSafeCaptureSegment guard behind the schema check', () => {
    // The HTTP handler's zod schema now refuses this shape before the store is
    // ever called (see the C2 wire-contract tests below); this is the deeper
    // defense-in-depth layer for any caller that reaches the store directly.
    expect(() => store.appendAtOffset('..', sessionId, transcriptId, 0, Buffer.from('x')))
      .toThrow(/Unsafe machine_id path segment/);
  });
});

// ---------------------------------------------------------------------------
// C2 — route handler (base64 decode + validation + response mapping)
// ---------------------------------------------------------------------------

/** An in-memory store so handler tests exercise the wire contract without disk. */
function memoryStore(): RoutedTranscriptStore & { bytesFor(rel: string): Buffer } {
  const files = new Map<string, Buffer>();
  const key = (m: string, s: string, t: string) => `${m}/${s}/${t}`;
  const machineTotal = (m: string): number => {
    let total = 0;
    for (const [k, buf] of files) if (k.startsWith(`${m}/`)) total += buf.length;
    return total;
  };
  return {
    appendAtOffset(m, s, t, baseOffset, bytes, maxMachineBytes) {
      const k = key(m, s, t);
      const cur = files.get(k) ?? Buffer.alloc(0);
      const action = decideChunkAction(cur.length, baseOffset);
      if (action === 'append') {
        if (maxMachineBytes !== undefined && machineTotal(m) + bytes.length > maxMachineBytes) {
          return { accepted: false, action: 'over-cap', size: cur.length };
        }
        const next = Buffer.concat([cur, bytes]);
        files.set(k, next);
        return { accepted: true, action, size: next.length };
      }
      return { accepted: action === 'replay', action, size: cur.length };
    },
    bytesFor(rel) { return files.get(rel) ?? Buffer.alloc(0); },
  };
}

/** A request as it arrives PAST the team gate: the authenticated machine id is
 *  stamped into the context (the gate refuses a disagreeing header, so context
 *  and header can never diverge). Defaults to the body's id — the conformant
 *  member — so existing cases exercise the match path; pass `authenticated`
 *  to impersonate a cross-member caller, or null for a gate bypass. */
const req = (body: unknown, authenticated?: string | null): RouteRequest => {
  const stamped = authenticated === undefined
    ? (body as { machine_id?: string } | null)?.machine_id
    : authenticated ?? undefined;
  return {
    body,
    query: {},
    params: {},
    pathname: '/routed-capture/transcript',
    ...(stamped === undefined ? {} : { requestContext: { machineId: stamped } as MycoRequestContext }),
  };
};

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

  test('an over-cap chunk is refused 413 and NOTHING is written', async () => {
    // The cap is enforced on BOTH sides now. Producer-only was fine while this
    // route was reachable from a private tailnet; the effective ceiling for a
    // write that lands in the operator's home directory and is retained
    // indefinitely must not be the 8 MB body limit — five times the documented
    // cap — now that the surface is the public internet and one shared bearer
    // reaches it.
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const oversized = Buffer.alloc(MAX_TRANSCRIPT_PUSH_BYTES + 1, 0x61);

    const res = await handler(req({
      machine_id: 'm_1',
      session_id: 'sess-big',
      transcript_id: 'tx_0000000000000000000000000000000b',
      base_offset: 0,
      bytes: oversized.toString('base64'),
    }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ ok: false, error: 'chunk_too_large', max_bytes: MAX_TRANSCRIPT_PUSH_BYTES });
    expect(store.bytesFor('m_1/sess-big/tx_0000000000000000000000000000000b')).toHaveLength(0);
  });

  test('a chunk exactly AT the cap is accepted — the bound is inclusive', async () => {
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const atCap = Buffer.alloc(MAX_TRANSCRIPT_PUSH_BYTES, 0x62);

    const res = await handler(req({
      machine_id: 'm_1',
      session_id: 'sess-at-cap',
      transcript_id: 'tx_0000000000000000000000000000000c',
      base_offset: 0,
      bytes: atCap.toString('base64'),
    }));

    expect(res.status).toBe(200);
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

  test('a traversal-shaped key is refused 400 invalid_body by the schema check (before the store ever runs)', async () => {
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const res = await handler(req({
      machine_id: '..', session_id: 's', transcript_id: 'tx_x', base_offset: 0, bytes: b64('x'),
    }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid_body' });
    // The store was never reached — the schema refused it up front.
    expect(store.bytesFor('../s/tx_x').length).toBe(0);
  });

  test('every traversal/separator/empty shape the schema refuses matches what assertSafeCaptureSegment refuses', async () => {
    const handler = createRoutedTranscriptHandler(memoryStore());
    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      const res = await handler(req({
        machine_id: bad, session_id: 's', transcript_id: 'tx_x', base_offset: 0, bytes: b64('x'),
      }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'invalid_body' });
    }
  });
});

// ---------------------------------------------------------------------------
// Admission — identity binding + the per-member byte bound
// ---------------------------------------------------------------------------

describe('POST /routed-capture/transcript admission', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    machine_id: 'alice_a1b2c3d4',
    session_id: 'sess-1',
    transcript_id: 'tx_00000000000000000000000000000001',
    base_offset: 0,
    bytes: b64('hello\n'),
    ...over,
  });

  test("IDENTITY: a body machine_id that is not the token's is refused 403, nothing written", async () => {
    // The team gate refuses a disagreeing HEADER, but this field lives in the
    // body where the gate cannot see it — and it is the cache path key. Combined
    // with the gap response disclosing the current size, an unchecked body id
    // lets any authenticated member append bytes to another member's LIVE
    // session, which the miner then files as that member's session content.
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const res = await handler(req(body(), 'mallory_ffffffff'));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('machine_id_mismatch');
    expect(store.bytesFor('alice_a1b2c3d4/sess-1/tx_00000000000000000000000000000001').length).toBe(0);
  });

  test('IDENTITY: no request context at all fails closed', async () => {
    // Every legitimate caller arrives through the team gate, which always
    // stamps the authenticated id. A request without one bypassed the gate.
    const store = memoryStore();
    const handler = createRoutedTranscriptHandler(store);
    const res = await handler(req(body(), null));
    expect(res.status).toBe(403);
    expect(store.bytesFor('alice_a1b2c3d4/sess-1/tx_00000000000000000000000000000001').length).toBe(0);
  });

  test('BOUND: an append past the member byte bound is refused 429 without writing', async () => {
    // The store honors the cap only for writes that would GROW the cache, so
    // this drives the real handler against a store already holding bytes for
    // the member and asserts the refusal is retry-later shaped: the drain
    // treats an unrecognized status as retry-next-tick, so the queue resumes
    // by itself once space frees. Nothing is ever deleted to make room.
    const store = memoryStore();
    // A tiny stand-in bound via a wrapping store: the production constant is
    // 1 GiB, which a unit test should not allocate.
    const capped: RoutedTranscriptStore = {
      appendAtOffset: (m, s, t, o, bytes) => store.appendAtOffset(m, s, t, o, bytes, 10),
    };
    const handler = createRoutedTranscriptHandler(capped);

    const first = await handler(req(body({ bytes: b64('0123456789') })));
    expect(first.status).toBe(200);

    const second = await handler(req(body({ session_id: 'sess-2', bytes: b64('x') })));
    expect(second.status).toBe(429);
    expect((second.body as { error: string }).error).toBe('member_transcript_cache_full');
    expect(store.bytesFor('alice_a1b2c3d4/sess-2/tx_00000000000000000000000000000001').length).toBe(0);
  });

  test('BOUND: a REPLAY at the cap still answers 200 — a resuming drain never wedges', async () => {
    // After a host restart the member re-slices from the authoritative size,
    // which begins with replays of bytes already present. Refusing those at
    // the cap would wedge the very member the bound is pressuring: it cannot
    // advance past bytes the host already has.
    const store = memoryStore();
    const capped: RoutedTranscriptStore = {
      appendAtOffset: (m, s, t, o, bytes) => store.appendAtOffset(m, s, t, o, bytes, 10),
    };
    const handler = createRoutedTranscriptHandler(capped);
    await handler(req(body({ bytes: b64('0123456789') })));

    const replay = await handler(req(body({ bytes: b64('0123456789') })));
    expect(replay.status).toBe(200);
    expect((replay.body as { action: string }).action).toBe('replay');
  });

  test('BOUND: a GAP probe at the cap still discloses the authoritative size', async () => {
    const store = memoryStore();
    const capped: RoutedTranscriptStore = {
      appendAtOffset: (m, s, t, o, bytes) => store.appendAtOffset(m, s, t, o, bytes, 10),
    };
    const handler = createRoutedTranscriptHandler(capped);
    await handler(req(body({ bytes: b64('0123456789') })));

    const probe = await handler(req(body({ base_offset: 500, bytes: b64('x') })));
    expect(probe.status).toBe(409);
    expect((probe.body as { size: number }).size).toBe(10);
  });

  test('BOUND (fs store): a stale tally recounts from disk before refusing — GC-freed space is honored', async () => {
    // The cache GC prunes trees without going through the store, so the tally
    // can only drift ABOVE the truth. An apparent over-cap must recount before
    // refusing: a stale number may delay one append by a recount, but must
    // never refuse a member the disk would accept.
    const teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rt-cap-'));
    const saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;
    try {
      const store = createFsRoutedTranscriptStore();
      const m = 'alice_a1b2c3d4';
      expect(store.appendAtOffset(m, 's1', 'tx_1', 0, Buffer.from('0123456789'), 10).action).toBe('append');
      // Simulate the GC: remove the tree out-of-band. The store's tally still
      // says 10 bytes.
      fs.rmSync(path.join(resolveRoutedTranscriptsDir(), m, 's1'), { recursive: true, force: true });
      // At the cap by the stale tally; the recount finds the disk empty and the
      // append is accepted.
      const after = store.appendAtOffset(m, 's2', 'tx_2', 0, Buffer.from('0123456789'), 10);
      expect(after.action).toBe('append');
      expect(after.accepted).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = saved;
      fs.rmSync(teamHome, { recursive: true, force: true });
    }
  });

  test('the production bound is wired: the default store is called with the constant', async () => {
    // The cap only exists if the handler passes it. Pin the wiring, not just
    // the store behavior — a handler that stopped passing the constant would
    // leave every test above green while production ran unbounded.
    let seenCap: number | undefined;
    const spy: RoutedTranscriptStore = {
      appendAtOffset: (m, s, t, o, bytes, cap) => {
        seenCap = cap;
        return { accepted: true, action: 'append', size: bytes.length };
      },
    };
    await createRoutedTranscriptHandler(spy)(req(body()));
    expect(seenCap).toBe(MAX_ROUTED_TRANSCRIPT_MEMBER_BYTES);
  });
});
