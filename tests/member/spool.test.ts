/**
 * The spool: write-ahead append, the wire carries only the seven envelope
 * fields, the drain's high-water on acked and refused, deletion of a fully
 * acknowledged file via deleteIfSync with the state reset inside the lock,
 * the per-session lease (two concurrent drains → each event once), the
 * offline latch, the protocol-mismatch diagnostic, and the refusal log's
 * content and cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_TOKEN_BYTE_QUOTA } from '@myco-server-worker/constants.js';
import { unboundedBudget, resolveHookBudget } from '@myco/member/budget.js';
import { MEMBER_PROTOCOL, OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS, PROJECT_HEADER, REFUSED_LOG_MAX_BYTES } from '@myco/member/constants.js';
import { mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool, WIRE_FIELDS, toWire, type SpoolRecord } from '@myco/member/spool.js';
import { shipTranscriptSegments } from '@myco/member/transcript.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch } from './helpers/hooks.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const clientFor = (rig: MemberRig, fetch: FetchLike = rig.fetch, token = rig.token) => new ServerClient({ serverUrl: 'https://s', token, projectId: 'proj_1' }, fetch);
const ctxFor = (spool: MemberSpool, sessionId: string): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });
const prompts = (ctx: EnvelopeContext, n: number) => Array.from({ length: n }, (_, i) => promptEvent(ctx, { promptId: mintId(), text: `p${i}` }));

describe('member spool', () => {
  it('appends before sending and the wire carries only the seven envelope fields — never a sidecar or the buffer timestamp', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-wire');
    const big = promptEvent(ctx, { promptId: mintId(), text: 'z'.repeat(300_000) });
    spool.append('sess-wire', big);
    const records = spool.readRecords('sess-wire') as SpoolRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]._memberProtocol).toBe(MEMBER_PROTOCOL);
    expect(records[0]._blobSource?.sha256).toBe(big.blobSource!.sha256);
    expect((records[0] as unknown as Record<string, unknown>).timestamp).toBeDefined();
    expect(Object.keys(toWire(records[0])).sort()).toEqual([...WIRE_FIELDS].sort());

    const { fetch, requests } = recordingFetch(rig.fetch);
    const result = await spool.drainSession('sess-wire', clientFor(rig, fetch), unboundedBudget());
    expect(result).toMatchObject({ acked: 1, refused: 0, remaining: 0, endedBy: 'drained' });
    const eventPost = requests.find((r) => r.path === '/events')!;
    expect(Object.keys(JSON.parse(eventPost.body!)).sort()).toEqual([...WIRE_FIELDS].sort());
    expect(requests.map((r) => r.path)).toEqual([`/blobs/${big.blobSource!.sha256}`, '/events']);
    // A credential is Deployment-wide, so the Project rides on every request the member
    // makes — the blob upload as much as the event. Without it the server refuses each
    // one `no_project` and nothing this member captures is ever admitted.
    expect(requests.map((r) => r.headers[PROJECT_HEADER])).toEqual(['proj_1', 'proj_1']);
    expect(rig.rows('events')).toBe(1);
    // Fully acknowledged: the file is gone and the high-water reset to 0.
    expect(fs.existsSync(path.join(spool.dir, 'sess-wire.jsonl'))).toBe(false);
    expect(readSessionState(spool.dir, 'sess-wire').highWater).toBe(0);
  });

  it('advances the high-water on acked and refused, logs refusals without payloads, and deletes the file only when all are acknowledged', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-hw');
    const [a, b, c] = prompts(ctx, 3);
    b.envelope.kind = 'made.up' as never; // a terminal refusal in the middle
    for (const e of [a, b, c]) spool.append('sess-hw', e);
    const r = await spool.drainSession('sess-hw', clientFor(rig), unboundedBudget());
    expect(r).toMatchObject({ sent: 3, acked: 2, refused: 1, remaining: 0 });
    expect(rig.rows('events')).toBe(2);
    const refused = spool.readRefused();
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0]).sort()).toEqual(['at', 'code', 'eventId', 'kind', 'reason', 'sessionId']);
    expect(refused[0]).toMatchObject({ eventId: b.envelope.eventId, kind: 'made.up', code: 'unknown_kind' });
    expect(JSON.stringify(refused)).not.toContain('p1');
    expect(fs.existsSync(path.join(spool.dir, 'sess-hw.jsonl'))).toBe(false);
  });

  it('a pass that ends on retry leaves the tail spooled, sets the latch, and the next pass (probe) resumes from the high-water without duplicates', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-retry');
    for (const e of prompts(ctx, 5)) spool.append('sess-retry', e);
    let calls = 0;
    const flaky: FetchLike = async (input, init) => {
      calls += 1;
      if (calls === 3) throw new Error('ECONNRESET');
      return rig.fetch(input, init);
    };
    const now = { t: 1_000_000 };
    const first = await spool.drainSession('sess-retry', clientFor(rig, flaky), unboundedBudget(), { now: () => now.t });
    expect(first).toMatchObject({ acked: 2, remaining: 3, endedBy: 'retry' });
    expect(spool.readLatch()).toMatchObject({ since: now.t, nextProbeAt: now.t + OFFLINE_BACKOFF_INITIAL_MS, backoffMs: OFFLINE_BACKOFF_INITIAL_MS });
    // While latched, a plain hook drain does not dial.
    const latched = await spool.drainSession('sess-retry', clientFor(rig), unboundedBudget(), { now: () => now.t + 1 });
    expect(latched.skipped).toBe('latched');
    // A probe (Stop/SessionEnd) dials; the tail lands; the latch clears; rows == events, no duplicates.
    const probe = await spool.drainSession('sess-retry', clientFor(rig), unboundedBudget(), { now: () => now.t + 1, force: true });
    expect(probe).toMatchObject({ acked: 3, remaining: 0 });
    expect(spool.readLatch()).toBeNull();
    expect(rig.rows('events')).toBe(5);
    expect((rig.env.sqlite.query('SELECT COUNT(DISTINCT event_id) c FROM events').get() as { c: number }).c).toBe(5);
  });

  it('the latch backs off 30 s → ×2 → 10 min and honours a longer retry-after', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    let t = 0;
    let backoff = OFFLINE_BACKOFF_INITIAL_MS;
    for (let i = 0; i < 8; i++) {
      const latch = spool.markOffline(t);
      expect(latch.backoffMs).toBe(backoff);
      expect(latch.nextProbeAt).toBe(t + backoff);
      expect(spool.shouldDial(t + backoff - 1)).toBe(false);
      expect(spool.shouldDial(t + backoff)).toBe(true);
      t += backoff;
      backoff = Math.min(backoff * 2, OFFLINE_BACKOFF_MAX_MS);
    }
    expect(spool.readLatch()!.backoffMs).toBe(OFFLINE_BACKOFF_MAX_MS);
    const stretched = spool.markOffline(t, OFFLINE_BACKOFF_MAX_MS * 3);
    expect(stretched.nextProbeAt).toBe(t + OFFLINE_BACKOFF_MAX_MS * 3);
    expect(spool.shouldDial(t, true)).toBe(true);
  });

  it('parked ends the pass with the quota line on stderr and keeps every event spooled; nothing reaches refused.jsonl', async () => {
    const rig = await memberRig();
    rig.env.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, rig.tokenId);
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-parked');
    for (const e of prompts(ctx, 3)) spool.append('sess-parked', e);
    const r = await spool.drainSession('sess-parked', clientFor(rig), unboundedBudget());
    expect(r).toMatchObject({ sent: 1, acked: 0, refused: 0, remaining: 3, endedBy: 'parked' });
    expect(stderrLines.join('')).toContain('write quota exceeded — capture parked');
    expect(spool.readRefused()).toEqual([]);
  });

  it('a 401 without the header ends the pass as unauthorized; a 429 without the header after a 401 in the same pass is unauthorized too', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-401');
    for (const e of prompts(ctx, 2)) spool.append('sess-401', e);
    const r = await spool.drainSession('sess-401', clientFor(rig, rig.fetch, 'x'.repeat(43)), unboundedBudget());
    expect(r).toMatchObject({ endedBy: 'unauthorized', remaining: 2 });
    expect(stderrLines.join('')).toContain('member token refused — re-provision');
    // onUnauthorized supplies a good record once: the pass continues on it.
    stderrLines.length = 0;
    const retried = await spool.drainSession('sess-401', clientFor(rig, rig.fetch, 'x'.repeat(43)), unboundedBudget(), {
      onUnauthorized: async () => ({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }),
      clientFor: (record) => new ServerClient(record, rig.fetch),
    });
    expect(retried).toMatchObject({ acked: 2, remaining: 0 });
    // 429-after-401 in one pass: the unknown token is answered 401, then the source bucket refuses.
    for (const e of prompts(ctx, 1)) spool.append('sess-401', e);
    let n = 0;
    const limitedAfter401: FetchLike = async (input, init) => {
      n += 1;
      if (n === 1) return rig.fetch(input, init);
      return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'retry-after': '60' } });
    };
    const bad = new ServerClient({ serverUrl: 'https://s', token: 'y'.repeat(43), projectId: 'proj_1' }, limitedAfter401);
    const twice = await spool.drainSession('sess-401', bad, unboundedBudget(), {
      onUnauthorized: async () => ({ serverUrl: 'https://s', token: 'y'.repeat(43), projectId: 'proj_1' }),
      clientFor: () => bad,
    });
    expect(twice.endedBy).toBe('unauthorized');
    expect(spool.readLatch()).toBeNull();
  });

  it('a protocol mismatch on a spool record is a named diagnostic and is not drained; a 409 names the server window', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-proto');
    const [e] = prompts(ctx, 1);
    spool.append('sess-proto', e);
    const file = path.join(spool.dir, 'sess-proto.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(`"_memberProtocol":${MEMBER_PROTOCOL}`, '"_memberProtocol":77'), { mode: 0o600 });
    const r = await spool.drainSession('sess-proto', clientFor(rig), unboundedBudget());
    expect(r).toMatchObject({ sent: 0, remaining: 1, endedBy: 'protocol_mismatch' });
    expect(stderrLines.join('')).toContain(`produced by member protocol 77; this build speaks ${MEMBER_PROTOCOL}`);
    const old = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch, { protocol: 999 });
    spool.append('sess-proto2', e);
    const r2 = await spool.drainSession('sess-proto2', old, unboundedBudget());
    expect(r2.endedBy).toBe('protocol');
    expect(stderrLines.join('')).toContain('server_protocol=1, min_compat_member_protocol=1');
  });

  it('two concurrent drains of one session: the lease admits one; every event is sent once', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-lease');
    for (const e of prompts(ctx, 6)) spool.append('sess-lease', e);
    const posts = new Map<string, number>();
    const slow: FetchLike = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/events') {
        const id = (JSON.parse(await req.clone().text()) as { eventId: string }).eventId;
        posts.set(id, (posts.get(id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
      }
      return rig.fetch(req);
    };
    const [a, b] = await Promise.all([
      spool.drainSession('sess-lease', clientFor(rig, slow), unboundedBudget()),
      spool.drainSession('sess-lease', clientFor(rig, slow), unboundedBudget()),
    ]);
    const winner = a.skipped ? b : a;
    const loser = a.skipped ? a : b;
    expect(loser.skipped).toBe('lease');
    expect(winner).toMatchObject({ acked: 6, remaining: 0 });
    expect([...posts.values()].every((n) => n === 1)).toBe(true);
    expect(posts.size).toBe(6);
    expect(rig.rows('events')).toBe(6);
  });

  it('the refused log holds {eventId, sessionId, kind, code, reason, at} only and stays under its cap', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const big = 'r'.repeat(4096);
    for (let i = 0; i < 400; i++) spool.appendRefused({ eventId: mintId(), sessionId: 's', kind: 'prompt', code: 'refused', reason: big, at: i });
    const file = path.join(spool.dir, 'refused.jsonl');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(REFUSED_LOG_MAX_BYTES);
    for (const line of fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['at', 'code', 'eventId', 'kind', 'reason', 'sessionId']);
    }
  });

  it('the transcript-segment path ends its passes through the same policy: route_missing latches and names itself', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-ship';
    const file = path.join(mycoHome, 'ship.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n');
    updateSessionState(spool.dir, sessionId, (s) => {
      s.transcript = { path: file, transcriptId: `tx_${'b'.repeat(32)}`, inode: fs.statSync(file).ino, nextOffset: 0, parsedSize: 0 };
    });
    // A 401 WITH the protocol header on a capture route: `route_missing`. The
    // event path latches and names it; before the policy was shared, the
    // segment path did neither.
    const client = new ServerClient({ serverUrl: 'https://s/v9', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' };

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget());

    expect(result).toEqual({ shipped: 0, endedBy: 'route_missing' });
    expect(spool.readLatch()).not.toBeNull();
    expect(stderrLines.join('')).toContain('contract bug');
  });

  it('the transcript pointer moves only its own transcript: a value committed mid-flight does not regress', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-cas-1';
    const file = path.join(mycoHome, 'cas.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n{"type":"assistant"}\n');
    const transcriptId = `tx_${'c'.repeat(32)}`;
    updateSessionState(spool.dir, sessionId, (s) => {
      s.transcript = { path: file, transcriptId, inode: fs.statSync(file).ino, nextOffset: 0, parsedSize: 0 };
    });
    // Another hook's committer advances `parsedSize` while the segment is in
    // flight; the ship path holds a snapshot that still says 0.
    const parsed = fs.statSync(file).size;
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/events') {
        updateSessionState(spool.dir, sessionId, (s) => { if (s.transcript) s.transcript.parsedSize = parsed; });
      }
      return rig.fetch(request);
    });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' };

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget());

    expect(result).toEqual({ shipped: 1, endedBy: 'done' });
    const stored = readSessionState(spool.dir, sessionId).transcript!;
    expect(stored.parsedSize).toBe(parsed);
    expect(stored.nextOffset).toBe(parsed);
    expect(stored.transcriptId).toBe(transcriptId);
  });

  it('the transcript pointer moves only its own transcript: a rotation committed mid-flight survives untouched', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-cas-2';
    const file = path.join(mycoHome, 'cas2.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n{"type":"assistant"}\n');
    const before = { path: file, transcriptId: `tx_${'d'.repeat(32)}`, inode: fs.statSync(file).ino, nextOffset: 0, parsedSize: 0 };
    const rotated = { path: file, transcriptId: `tx_${'e'.repeat(32)}`, inode: before.inode + 1, nextOffset: 0, parsedSize: 0 };
    updateSessionState(spool.dir, sessionId, (s) => { s.transcript = before; });
    // The transcript rotates while the segment is in flight: another hook
    // commits a pointer for the NEW file, under a new id.
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/events') {
        updateSessionState(spool.dir, sessionId, (s) => { s.transcript = rotated; });
      }
      return rig.fetch(request);
    });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' };

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget());

    expect(result.endedBy).toBe('done');
    // The rotated pointer is exactly as committed: this path's offset, which
    // belongs to the old transcript, never reaches it.
    expect(readSessionState(spool.dir, sessionId).transcript).toEqual(rotated);
  });

  it('drainAll stops at the first outcome that will answer the same way for every other session', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    for (const sessionId of ['sess-a', 'sess-b', 'sess-c']) {
      spool.append(sessionId, promptEvent(ctxFor(spool, sessionId), { promptId: mintId(), text: 'x' }));
    }
    const seen: string[] = [];
    const client = new ServerClient({ serverUrl: 'https://s/v9', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      seen.push(new URL(new Request(input, init).url).pathname);
      return rig.fetch(input, init);
    });

    const results = await spool.drainAll(client, unboundedBudget(), { force: true });

    expect(results).toHaveLength(1);
    expect(results[0].endedBy).toBe('route_missing');
    expect(seen).toHaveLength(1);
    expect(spool.sessionIds()).toHaveLength(3);
  });

  it('a hook budget stops the pass before the deadline and leaves the rest spooled', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-budget');
    for (const e of prompts(ctx, 4)) spool.append('sess-budget', e);
    const start = 1_000_000;
    let t = start;
    const ticking: FetchLike = async (input, init) => { t += 1_500; return rig.fetch(input, init); };
    const budget = resolveHookBudget('claude-code', 'user-prompt-submit', { startedAt: start }); // 4 000 ms budget, connect 1 333
    const r = await spool.drainSession('sess-budget', clientFor(rig, ticking), budget, { now: () => t });
    expect(r.endedBy).toBe('budget');
    expect(r.acked + r.remaining).toBe(4);
    expect(r.remaining).toBeGreaterThan(0);
    expect(await spool.drainSession('sess-budget', clientFor(rig), unboundedBudget())).toMatchObject({ remaining: 0 });
    expect(rig.rows('events')).toBe(4);
  });
});
