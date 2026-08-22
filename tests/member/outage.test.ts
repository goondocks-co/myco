/**
 * Offline capture is never lost: 1 000 events across sessions, driven through
 * a server that fails in every way the classifier knows (transport errors,
 * 503 with retry-after, 429, connect timeouts) and a 30-day clock skip, drain
 * to rows == events with zero duplicates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { unboundedBudget } from '@myco/member/budget.js';
import { MEMBER_SPOOL_QUARANTINE_MS } from '@myco/member/constants.js';
import { mintId, promptEvent, toolUseEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { normalizeHookInput } from '@myco/hooks/normalize.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const TOTAL = 1_000;
const SESSIONS = 8;

describe('outage convergence', () => {
  it('1 000 events across outage/503/429/timeout and a 30-day skip → rows == events, zero duplicates', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessions = Array.from({ length: SESSIONS }, (_, i) => `sess-outage-${i}`);
    const ctxs = new Map(sessions.map((s) => [s, { agent: 'claude-code', sessionId: s, stage: spool.stagerFor(s), version: '2.0.0-test' } as EnvelopeContext]));

    // Write-ahead: every event is appended before any drain.
    const ids = new Set<string>();
    for (let i = 0; i < TOTAL; i++) {
      const sessionId = sessions[i % SESSIONS];
      const ctx = ctxs.get(sessionId)!;
      const ev = i % 3 === 0
        ? toolUseEvent(ctx, normalizeHookInput({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: `/f${i}` }, tool_output: 'ok' }))
        : promptEvent(ctx, { promptId: mintId(), text: `prompt ${i} ${i % 7 === 0 ? 'z'.repeat(250_000) : ''}` });
      ids.add(ev.envelope.eventId);
      spool.append(sessionId, ev);
    }

    // A server that misbehaves on a schedule: every 9th call throws, every 17th
    // answers 503 with retry-after, every 23rd answers 429, every 29th hangs
    // past the request timeout. Every failure ends the pass it happens in.
    let calls = 0;
    let failures = 0;
    const faulty: FetchLike = async (input, init) => {
      calls += 1;
      if (calls % 29 === 0) { failures += 1; return new Promise((_r, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }); }
      if (calls % 23 === 0) { failures += 1; return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'retry-after': '1', 'x-myco-protocol': '1' } }); }
      if (calls % 17 === 0) { failures += 1; return new Response(JSON.stringify({ persisted: false, code: 'unavailable', reason: 'unavailable' }), { status: 503, headers: { 'retry-after': '1', 'x-myco-protocol': '1' } }); }
      if (calls % 9 === 0) { failures += 1; throw new Error('ECONNRESET'); }
      return rig.fetch(input, init);
    };
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, faulty);

    // Repeated drains under a fast-moving clock (the latch backs off between passes); the 30-day skip happens midway.
    let t = 1_700_000_000_000;
    const now = () => t;
    const fastBudget = { ...unboundedBudget(), connectTimeoutMs: 20, requestTimeoutMs: 40 };
    let passes = 0;
    for (; passes < 3_000; passes++) {
      const results = await spool.drainAll(client, fastBudget, { now, force: true });
      if (results.every((r) => r.remaining === 0) && spool.sessionIds().length === 0) break;
      if (passes === 20) t += MEMBER_SPOOL_QUARANTINE_MS + 1; // the 30-day skip
      t += 60_000;
    }
    expect(failures).toBeGreaterThan(50);

    expect(spool.sessionIds()).toEqual([]);
    expect(rig.rows('events')).toBe(TOTAL);
    const distinct = (rig.env.sqlite.query('SELECT COUNT(DISTINCT event_id) c FROM events').get() as { c: number }).c;
    expect(distinct).toBe(TOTAL);
    const stored = new Set((rig.env.sqlite.query('SELECT event_id FROM events').all() as Array<{ event_id: string }>).map((r) => r.event_id));
    expect(stored).toEqual(ids);
    expect(spool.readRefused()).toEqual([]);
    expect(passes).toBeGreaterThan(1);
  });
});
