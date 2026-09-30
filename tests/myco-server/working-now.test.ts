/**
 * A session working now (#1531): a turn opens when its prompt asks the Deployment for context and closes when the
 * turn's end reaches it, so a long turn that sends nothing until it stops still reads as working.
 *
 * The stamp is written past the answer and never costs the prompt its context; an end older than the turn it would
 * close leaves the turn open; a turn open past `WORKING_CAP_MS` reads as working no longer; and a session the
 * Deployment does not hold yet has no turn to open.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { turnStartedAt } from '@myco-server-worker/ingest/turns.js';
import { WORKING_CAP_MS } from '@myco-server-worker/read/sessions.js';
import { envelope, memberHeaders, memberPost, recordingDeferred, sqliteEnv, uuid } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

/** A prompt id as the member mints one: a UUIDv7 whose timestamp is `at`. */
const promptIdAt = (at: number): string => {
  const hex = at.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, '0')}`;
};

async function rig() {
  const e = sqliteEnv();
  const now = Date.now();
  const { token } = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
  let next = 100;
  const event = async (over: Record<string, unknown>, as = token) => {
    const res = await worker.fetch(memberPost(as, envelope({ eventId: uuid(next += 1), ...over })), e.env, e.deferred);
    await e.deferred.settle();
    return (await res.json()) as Record<string, unknown>;
  };
  const prompt = async (sessionId: string, promptId: string, over: { as?: string; env?: unknown; deferred?: ReturnType<typeof recordingDeferred> } = {}) => {
    const deferred = over.deferred ?? e.deferred;
    const res = await worker.fetch(new Request('https://s/context/prompt', {
      method: 'POST', headers: memberHeaders(over.as ?? token), body: JSON.stringify({ sessionId, promptId, text: 'let us keep going' }),
    }), (over.env ?? e.env) as never, deferred);
    const body = (await res.json()) as Record<string, unknown>;
    await deferred.settle();
    return { status: res.status, body };
  };
  const workingSince = (sessionId: string): number | null | undefined =>
    (e.sqlite.query(`SELECT working_since FROM sessions WHERE project_id = 'proj_1' AND session_id = ?`).get(sessionId) as { working_since: number | null } | null)?.working_since;
  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), { ...e.env, ...OWNER_ENV });
    return (await res.json()) as Record<string, any>;
  };
  // A session the member registered, and a prompt of it a response can answer.
  await event({ kind: 'session.start', sessionId: 'sess_1', createdAt: now - 120_000, payload: { agent: 'claude-code', startedAt: now - 120_000 } });
  await event({ sessionId: 'sess_1', createdAt: now - 110_000, payload: { promptId: uuid(2), text: 'hi', origin: 'user' } });
  return { e, now, token, other: other.token, event, prompt, workingSince, get };
}

describe('a session working now', () => {
  it('opens its turn at the prompt\'s own instant, past the answer, and reads as working however long since its last receipt', async () => {
    const r = await rig();
    const at = r.now - 60_000;
    const asked = await r.prompt('sess_1', promptIdAt(at));
    expect(asked.status).toBe(200);
    expect(r.workingSince('sess_1')).toBe(at);
    // A receipt far older than the live window, and still working.
    r.e.sqlite.run(`UPDATE sessions SET last_received_at = ? WHERE session_id = 'sess_1'`, [r.now - 60 * 60_000]);
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session).toMatchObject({ working: true, workingSince: at });
    const live = await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}&state=open`);
    expect(live.rows.map((row: { sessionId: string; working: boolean }) => [row.sessionId, row.working])).toEqual([['sess_1', true]]);
  });

  it('closes its turn by the turn\'s end, and never by an end older than the turn, as a spool drained at the next prompt carries', async () => {
    const r = await rig();
    const first = r.now - 60_000;
    await r.prompt('sess_1', promptIdAt(first));
    // The turn ends: its response lands, made after the turn started.
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: first + 5_000, payload: { responseId: uuid(30), promptId: uuid(2), text: 'done' } });
    expect(r.workingSince('sess_1')).toBeNull();
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session.working).toBe(false);

    // The next turn opens; the previous turn's end, spooled while the Deployment is out of reach, drains after it.
    const second = r.now - 30_000;
    await r.prompt('sess_1', promptIdAt(second));
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: second - 10_000, payload: { responseId: uuid(31), promptId: uuid(2), text: 'late' } });
    expect(r.workingSince('sess_1')).toBe(second);
    // Its own end closes it.
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: second + 1_000, payload: { responseId: uuid(32), promptId: uuid(2), text: 'done again' } });
    expect(r.workingSince('sess_1')).toBeNull();

    // The session's end closes a turn too, and a prompt older than the end opens none.
    await r.prompt('sess_1', promptIdAt(r.now - 20_000));
    await r.event({ kind: 'session.end', sessionId: 'sess_1', createdAt: r.now - 10_000, payload: { endedAt: r.now - 10_000 } });
    expect(r.workingSince('sess_1')).toBeNull();
    await r.prompt('sess_1', promptIdAt(r.now - 15_000));
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('reads a session resumed after its recorded end as working and live while its turn is open, and leaves the end as recorded', async () => {
    const r = await rig();
    // `claude -p` ends its session as it exits; `--continue` or `--resume` runs the next turn in the same session.
    await r.event({ kind: 'session.end', sessionId: 'sess_1', createdAt: r.now - 60_000, payload: { endedAt: r.now - 60_000 } });
    const resumed = r.now - 30_000;
    await r.prompt('sess_1', promptIdAt(resumed));
    expect(r.workingSince('sess_1')).toBe(resumed);
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session).toMatchObject({ working: true, workingSince: resumed, endedAt: r.now - 60_000 });
    r.e.sqlite.run(`UPDATE sessions SET last_received_at = ? WHERE session_id = 'sess_1'`, [r.now - 60 * 60_000]);
    const live = await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}&state=open`);
    expect(live.rows.map((row: { sessionId: string; working: boolean }) => [row.sessionId, row.working])).toEqual([['sess_1', true]]);
    // Its turn's end closes it, and the session reads ended again as recorded.
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: resumed + 5_000, payload: { responseId: uuid(40), promptId: uuid(2), text: 'done' } });
    expect(r.workingSince('sess_1')).toBeNull();
    expect((await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}&state=open`)).rows).toEqual([]);
  });

  it('reads a turn open past the cap as working no longer, and leaves it off the live list', async () => {
    const r = await rig();
    await r.prompt('sess_1', promptIdAt(r.now - 1_000));
    r.e.sqlite.run(`UPDATE sessions SET working_since = ?, last_received_at = ? WHERE session_id = 'sess_1'`, [Date.now() - WORKING_CAP_MS - 60_000, r.now - 60 * 60_000]);
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session.working).toBe(false);
    expect((await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}&state=open`)).rows).toEqual([]);
  });

  it('opens no turn for a session the Deployment does not hold yet, nor for another machine\'s session', async () => {
    const r = await rig();
    // The first prompt of a session whose start has not reached the Deployment: no row is written for it.
    await r.prompt('sess_new', promptIdAt(r.now - 1_000));
    expect(r.workingSince('sess_new')).toBeUndefined();
    // Another machine's credential cannot mark this machine's session working.
    await r.prompt('sess_1', promptIdAt(r.now - 1_000), { as: r.other });
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('takes the Deployment\'s clock for a prompt id that carries no instant it can trust', async () => {
    const now = 1_800_000_000_000;
    expect(turnStartedAt(promptIdAt(now - 5_000), now)).toBe(now - 5_000);
    expect(turnStartedAt('p1', now)).toBe(now);
    expect(turnStartedAt(uuid(2), now)).toBe(now);
    expect(turnStartedAt(promptIdAt(now - 2 * 24 * 60 * 60_000), now)).toBe(now);
    expect(turnStartedAt(promptIdAt(now - 5_000).replace(/-7abc-/, '-4abc-'), now)).toBe(now);
    const r = await rig();
    const before = Date.now();
    await r.prompt('sess_1', 'not-a-uuid');
    const stamped = r.workingSince('sess_1')!;
    expect(stamped >= before && stamped <= Date.now()).toBe(true);
  });

  it('answers the prompt without waiting on the stamp, which may never finish', async () => {
    const r = await rig();
    const inner = r.e.env.MYCO_DB;
    const never = new Promise<never>(() => {});
    const hanging = { ...r.e.env, MYCO_DB: { ...inner, batch: inner.batch.bind(inner), prepare: (sql: string) => {
      const statement = inner.prepare(sql);
      if (!/SET working_since = \?/.test(sql)) return statement;
      const held = { ...statement, bind: (...values: unknown[]) => ({ ...statement.bind(...values), run: () => never }) };
      return held;
    } } };
    const deferred = recordingDeferred();
    const res = await Promise.race([
      worker.fetch(new Request('https://s/context/prompt', {
        method: 'POST', headers: memberHeaders(r.token), body: JSON.stringify({ sessionId: 'sess_1', promptId: promptIdAt(r.now - 1_000), text: 'still going' }),
      }), hanging as never, deferred).then((answer) => answer.status),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000)),
    ]);
    expect(res).toBe(200);
    expect(deferred.pending).toHaveLength(1);
  });

  it('answers the prompt whatever becomes of the stamp: a store that refuses it, or work that cannot be deferred', async () => {
    const r = await rig();
    const inner = r.e.env.MYCO_DB;
    const failing = { ...r.e.env, MYCO_DB: { ...inner, batch: inner.batch.bind(inner), prepare: (sql: string) => { if (/SET working_since = \?/.test(sql)) throw new Error('D1_ERROR: storage is unavailable'); return inner.prepare(sql); } } };
    const refusing = { ...recordingDeferred(), waitUntil: () => { throw new Error('no deferral here'); } };
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const refused = await r.prompt('sess_1', promptIdAt(r.now - 1_000), { env: failing });
      expect({ status: refused.status, persisted: refused.body.persisted }).toEqual({ status: 200, persisted: true });
      expect(r.workingSince('sess_1')).toBeNull();
      const undeferred = await r.prompt('sess_1', promptIdAt(r.now - 1_000), { deferred: refusing });
      expect({ status: undeferred.status, persisted: undeferred.body.persisted }).toEqual({ status: 200, persisted: true });
    } finally {
      console.log = log;
    }
    const unrecorded = logged.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).filter((event) => event.kind === 'turn_start_unrecorded');
    expect(unrecorded).toEqual([
      { kind: 'turn_start_unrecorded', projectId: 'proj_1', tokenId: expect.any(String), error: expect.any(String) },
      { kind: 'turn_start_unrecorded', projectId: 'proj_1', tokenId: expect.any(String), error: expect.any(String) },
    ]);
  });
});
