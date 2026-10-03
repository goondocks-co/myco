/**
 * A session working now (#1531): a turn opens when its prompt asks the Deployment for context and closes when the
 * turn's end reaches it, so a long turn that sends nothing until it stops still reads as working.
 *
 * The stamp is written past the answer and never costs the prompt its context; an end older than the turn it would
 * close leaves the turn open; a turn open past `WORKING_CAP_MS` reads as working no longer; and a session the
 * Deployment does not hold yet has no turn to open.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { handlePromptContext } from '@myco-server-worker/api/recall.js';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { turnStartedAt } from '@myco-server-worker/ingest/turns.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { WORKING_CAP_MS } from '@myco-server-worker/read/sessions.js';
import { MAX_CLOCK_SKEW_MS } from '@myco-server-worker/constants.js';
import { blobPost, envelope, memberHeaders, memberPost, recordingDeferred, sqliteEnv, uuid } from './helpers/fixtures.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { FEATURES_HEADER, featuresNamed, TURN_END_HEADER } from '@goondocks/myco-shared/member-protocol';
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
  const event = async (over: Record<string, unknown>, as = token, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(memberPost(as, envelope({ eventId: uuid(next += 1), ...over }), '/events', headers), e.env, e.deferred);
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
  /** A transcript segment of `sessionId`: sent by its own turn-end hook when `turnEnd`, and by any other pass when not. */
  const offsets = new Map<string, number>();
  const segment = async (sessionId: string, createdAt: number, turnEnd: boolean, channel = 'cli', text?: string) => {
    const bytes = utf8(text ?? `{"at":${createdAt},"session":"${sessionId}"}\n`);
    const baseOffset = offsets.get(sessionId) ?? 0;
    offsets.set(sessionId, baseOffset + bytes.byteLength);
    const key = await sha256HexOf(bytes);
    await worker.fetch(blobPost(token, key, bytes), e.env, e.deferred);
    return event({ kind: 'transcript.segment', sessionId, createdAt, channel, payload: { transcriptId: `tx_${(await sha256HexOf(utf8(sessionId))).slice(0, 32)}`, agent: 'claude-code', baseOffset, length: bytes.byteLength, blob: key } },
      token, turnEnd ? { [TURN_END_HEADER]: '1' } : {});
  };
  const workingRow = (sessionId: string) => e.sqlite.query(`SELECT working_since, last_turn_end_at FROM sessions WHERE project_id = 'proj_1' AND session_id = ?`).get(sessionId);
  return { e, now, token, other: other.token, event, prompt, workingSince, get, segment, workingRow };
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

  it('opens no turn on a prompt id whose instant is not a v7\'s, or stands more than the skew bound from the Deployment\'s clock either way', async () => {
    const now = 1_800_000_000_000;
    expect(turnStartedAt(promptIdAt(now - 5_000), now)).toBe(now - 5_000);
    expect(turnStartedAt(promptIdAt(now + MAX_CLOCK_SKEW_MS), now)).toBe(now + MAX_CLOCK_SKEW_MS);
    expect(turnStartedAt(promptIdAt(now - MAX_CLOCK_SKEW_MS), now)).toBe(now - MAX_CLOCK_SKEW_MS);
    for (const id of ['p1', uuid(2), promptIdAt(now + MAX_CLOCK_SKEW_MS + 1), promptIdAt(now - MAX_CLOCK_SKEW_MS - 1), promptIdAt(now - 5_000).replace(/-7abc-/, '-4abc-')]) {
      expect({ id, at: turnStartedAt(id, now) }).toEqual({ id, at: null });
    }
    const r = await rig();
    // A member clock far ahead or far behind opens nothing: the session reads as Live through its receipts alone.
    await r.prompt('sess_1', promptIdAt(Date.now() + 2 * MAX_CLOCK_SKEW_MS));
    expect(r.workingSince('sess_1')).toBeNull();
    await r.prompt('sess_1', promptIdAt(Date.now() - 2 * 24 * 60 * 60_000));
    expect(r.workingSince('sess_1')).toBeNull();
    await r.prompt('sess_1', 'not-a-uuid');
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('closes a turn by its own session\'s turn-end transcript alone: another pass shipping a segment, of this session or another, closes nothing', async () => {
    const r = await rig();
    await r.event({ kind: 'session.start', sessionId: 'sess_2', createdAt: r.now - 120_000, payload: { agent: 'claude-code', startedAt: r.now - 120_000 } });
    const a = r.now - 60_000;
    await r.prompt('sess_1', promptIdAt(a));
    await r.prompt('sess_2', promptIdAt(r.now - 50_000));
    // Session 2's Stop ships its own transcript as its turn end, and walks session 1's backlog: that segment is shipped now.
    await r.segment('sess_2', r.now - 20_000, true);
    await r.segment('sess_1', r.now - 20_000, false);
    expect(r.workingSince('sess_1')).toBe(a);
    expect(r.workingSince('sess_2')).toBeNull();
    // A drain or an import of session 1's transcript closes nothing either.
    await r.segment('sess_1', r.now - 10_000, false);
    await r.segment('sess_1', r.now - 5_000, true, 'import');
    expect(r.workingSince('sess_1')).toBe(a);
    // Session 1's own turn end does.
    await r.segment('sess_1', r.now - 1_000, true);
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('leaves a turn open while the parse reads its transcript: a reply the turn is still writing, shipped by another pass, ends nothing', async () => {
    const r = await rig();
    const at = r.now - 60_000;
    await r.prompt('sess_1', promptIdAt(at));
    const iso = (t: number) => new Date(t).toISOString();
    // Session A's transcript as another session's backlog walk ships it mid-turn: the prompt, and a reply begun before a tool call.
    const lines = [
      { type: 'user', uuid: 'u1', promptId: 'p1', sessionId: 'sess_1', timestamp: iso(at), message: { role: 'user', content: 'run the long loop' } },
      { type: 'assistant', uuid: 'a1', sessionId: 'sess_1', timestamp: iso(at + 5_000), message: { role: 'assistant', content: [{ type: 'text', text: 'Running the loop now.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 150' } }], stop_reason: 'tool_use' } },
    ];
    await r.segment('sess_1', at + 10_000, false, 'cli', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    for (let pass = 0; pass < 5; pass += 1) if ((await parseTranscripts(r.e.serverEnv, Date.now())).changed === 0) break;
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM responses WHERE session_id = 'sess_1'`).get()).toEqual({ n: 1 });
    expect(r.workingSince('sess_1')).toBe(at);
  });

  it('opens nothing for a stamp arriving after its own turn\'s end, and closes a turn by an end at its exact start', async () => {
    const r = await rig();
    const at = r.now - 30_000;
    // The turn's end reaches the Deployment first; its own prompt's stamp, written later, opens nothing.
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: at + 1_000, payload: { responseId: uuid(50), promptId: uuid(2), text: 'done' } });
    expect(r.workingRow('sess_1')).toEqual({ working_since: null, last_turn_end_at: at + 1_000 });
    // An older end drained after it leaves the recorded end where it stands.
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: at - 5_000, payload: { responseId: uuid(53), promptId: uuid(2), text: 'earlier' } });
    expect(r.workingRow('sess_1')).toEqual({ working_since: null, last_turn_end_at: at + 1_000 });
    await r.prompt('sess_1', promptIdAt(at));
    expect(r.workingSince('sess_1')).toBeNull();
    // A later turn opens, and an end at its very instant closes it.
    const next = r.now - 10_000;
    await r.prompt('sess_1', promptIdAt(next));
    expect(r.workingSince('sess_1')).toBe(next);
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: next, payload: { responseId: uuid(51), promptId: uuid(2), text: 'done' } });
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('lists a session working after its recorded end as open alone, and as ended again once its turn ends', async () => {
    const r = await rig();
    await r.event({ kind: 'session.end', sessionId: 'sess_1', createdAt: r.now - 60_000, payload: { endedAt: r.now - 60_000 } });
    await r.prompt('sess_1', promptIdAt(r.now - 30_000));
    const since = Date.now() - 15 * 60_000;
    const ids = async (state: string, window = '') => ((await r.get(`/api/sessions?state=${state}${window}`)).rows as Array<{ sessionId: string }>).map((row) => row.sessionId);
    expect({ open: await ids('open', `&window=activity&since=${since}`), ended: await ids('ended', `&window=activity&since=${since}`), endedAll: await ids('ended') })
      .toEqual({ open: ['sess_1'], ended: [], endedAll: [] });
    await r.event({ kind: 'response', sessionId: 'sess_1', createdAt: r.now - 20_000, payload: { responseId: uuid(52), promptId: uuid(2), text: 'done' } });
    expect({ open: await ids('open', `&window=activity&since=${since}`), ended: await ids('ended') }).toEqual({ open: [], ended: ['sess_1'] });
  });

  it('reads a turn older than the recorded end as no turn, on the row and the live list, whatever the column holds', async () => {
    const r = await rig();
    // A turn and an end the store holds out of order: the end is newer, so the session is not working.
    r.e.sqlite.run(`UPDATE sessions SET working_since = ?, ended_at = ?, last_received_at = ? WHERE session_id = 'sess_1'`, [r.now - 30_000, r.now - 10_000, r.now - 60 * 60_000]);
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session).toMatchObject({ working: false, workingSince: null });
    expect((await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}`)).rows).toEqual([]);
  });

  it('merges the working sessions into the live page once each, in the page\'s order', async () => {
    const r = await rig();
    // Three sessions, all working, started in a known order: the oldest and newest receiving now, the middle one read
    // through its open turn alone.
    for (const [id, started] of [['sess_a', r.now - 300_000], ['sess_b', r.now - 200_000], ['sess_c', r.now - 100_000]] as const) {
      await r.event({ kind: 'session.start', sessionId: id, createdAt: started, payload: { agent: 'claude-code', startedAt: started } });
      await r.prompt(id, promptIdAt(r.now - 5_000));
    }
    r.e.sqlite.run(`UPDATE sessions SET last_received_at = ? WHERE session_id IN ('sess_b', 'sess_1')`, [r.now - 60 * 60_000]);
    const live = await r.get(`/api/sessions?window=activity&since=${Date.now() - 15 * 60_000}&state=open`);
    // sess_a and sess_c are in both reads, and listed once; sess_b falls between them, and the page reads newest start first.
    expect((live.rows as Array<{ sessionId: string }>).map((row) => row.sessionId)).toEqual(['sess_c', 'sess_b', 'sess_a']);
  });

  it('opens the turn though the answer is never composed: the stamp is registered first and waits on nothing the answer reads', async () => {
    // A client that stops waiting mid-compose, or a compose that never ends, must not cost the session its turn. Every
    // statement but the stamp hangs, so nothing the answer reads (settings, the capability, spores) ever lands.
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
    const now = Date.now();
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 0)`);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_1', 'machine_1', 'tok', ?, ?)`, [now, now]);
    const bun = serverEnvFromBunConfig({ sqlite, blobDir: mkdtempSync(join(tmpdir(), 'myco-blobs-')) });
    const inner = bun.db;
    const never = new Promise<never>(() => {});
    const hung = (statement: ReturnType<typeof inner.prepare>) => {
      const stalled = { ...statement, all: () => never, first: () => never, run: () => never, raw: () => never };
      return { ...stalled, bind: (...values: unknown[]) => ({ ...statement.bind(...values), all: () => never, first: () => never, run: () => never, raw: () => never }) };
    };
    const db = { ...inner, prepare: (sql: string) => (/SET working_since = \?/.test(sql) ? inner.prepare(sql) : hung(inner.prepare(sql))), batch: () => never };
    const at = now - 1_000;
    let answered = false;
    void handlePromptContext({ ...bun, db } as never, {
      projectId: 'proj_1', memberId: 'mem_1', machineId: 'machine_1', tokenId: 'tok', expiresAt: now + 60_000, lineageRoot: 'tok', lineageStartedAt: now,
      runtime: { runtimeLabel: null, runtimeKind: null }, body: JSON.stringify({ sessionId: 'sess_1', promptId: promptIdAt(at), text: 'keep going' }), bodyBytes: 10, now, origin: 'https://s',
    }).then(() => { answered = true; });
    await bun.settle();
    expect(answered).toBe(false);
    expect((sqlite.query(`SELECT working_since FROM sessions WHERE session_id = 'sess_1'`).get() as { working_since: number }).working_since).toBe(at);
  });

  it('on the self-hosted target, writes the stamp before the answer\'s reads, and composes the answer as before', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
    const now = Date.now();
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 0)`);
    sqlite.run(`INSERT INTO members (id, label, created_at) VALUES ('mem_1', 'm', 0)`);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_1', 'machine_1', 'tok', ?, ?)`, [now, now]);
    // Recall on, and a prompt with planning intent, so composing the answer runs statements of its own.
    sqlite.run(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`, [now]);
    const bun = serverEnvFromBunConfig({ sqlite, blobDir: mkdtempSync(join(tmpdir(), 'myco-blobs-')) });
    const order: string[] = [];
    const inner = bun.db;
    const db = { ...inner, prepare: (sql: string) => { order.push(sql); return inner.prepare(sql); }, batch: inner.batch.bind(inner) };
    const at = now - 1_000;
    const answer = await handlePromptContext({ ...bun, db } as never, {
      projectId: 'proj_1', memberId: 'mem_1', machineId: 'machine_1', tokenId: 'tok', expiresAt: now + 60_000, lineageRoot: 'tok', lineageStartedAt: now,
      runtime: { runtimeLabel: null, runtimeKind: null }, body: JSON.stringify({ sessionId: 'sess_1', promptId: promptIdAt(at), text: 'draft the implementation plan' }), bodyBytes: 10, now, origin: 'https://s',
    });
    expect(answer.status).toBe(200);
    await bun.settle();
    const stamp = order.findIndex((sql) => /SET working_since = \?/.test(sql));
    // The stamp is registered before anything is read, and on this target deferred work starts at once.
    expect(stamp).toBe(0);
    expect(order.some((sql) => /session_injections/.test(sql))).toBe(true);
    expect((sqlite.query(`SELECT working_since FROM sessions WHERE session_id = 'sess_1'`).get() as { working_since: number }).working_since).toBe(at);
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

/**
 * The `turn` event (advertised as the `turn` feature): a member that ships its turn's start and end as events, from a
 * spool, dates each by its own `createdAt`, so a start or an end drained late still opens or closes the turn it
 * belongs to and no other.
 */
describe('a turn the member ships as events', () => {
  const turn = (phase: string, createdAt: number, over: Record<string, unknown> = {}) =>
    ({ kind: 'turn', sessionId: 'sess_1', createdAt, payload: { phase }, ...over });

  it('names the turn feature on every answer to an authenticated member, refusals and context answers included, and on none to anyone else', async () => {
    const r = await rig();
    const res = await worker.fetch(memberPost(r.token, envelope({ eventId: uuid(900), ...turn('start', r.now - 1_000) }), '/events'), r.e.env, r.e.deferred);
    expect({ status: res.status, features: featuresNamed(res.headers.get(FEATURES_HEADER)) }).toEqual({ status: 200, features: ['turn'] });
    // A refusal names it too: a member reads its Deployment's features from whatever answer it gets.
    const refused = await worker.fetch(memberPost(r.token, envelope({ eventId: uuid(901), ...turn('start', r.now - 1_000) }), '/events', { 'x-myco-protocol': '999' }), r.e.env, r.e.deferred);
    expect({ status: refused.status, features: featuresNamed(refused.headers.get(FEATURES_HEADER)) }).toEqual({ status: 409, features: ['turn'] });
    const context = await worker.fetch(new Request('https://s/context/prompt', {
      method: 'POST', headers: memberHeaders(r.token), body: JSON.stringify({ sessionId: 'sess_1', promptId: promptIdAt(r.now - 1_000), text: 'let us keep going' }),
    }), r.e.env, r.e.deferred);
    await r.e.deferred.settle();
    expect({ status: context.status, features: featuresNamed(context.headers.get(FEATURES_HEADER)) }).toEqual({ status: 200, features: ['turn'] });
    const anonymous = await worker.fetch(new Request('https://s/health'), r.e.env, r.e.deferred);
    expect(anonymous.headers.get(FEATURES_HEADER)).toBeNull();
  });

  it('reads the same in any delivery order: a start drained late never dates the open turn back for an earlier end to close', async () => {
    const r = await rig();
    const t1 = r.now - 60_000;
    const t2 = r.now - 50_000;
    const t3 = r.now - 40_000;
    // Turn 3's start lands first; turn 1's start and end, held in the spool, drain after it.
    await r.event(turn('start', t3));
    await r.event(turn('start', t1));
    expect(r.workingSince('sess_1')).toBe(t3);
    await r.event(turn('end', t2));
    expect(r.workingSince('sess_1')).toBe(t3);
  });

  it('keeps a context request\'s late stamp from dating the open turn back, with no end between them', async () => {
    const r = await rig();
    const earlier = r.now - 60_000;
    const later = r.now - 40_000;
    await r.event(turn('start', later));
    await r.prompt('sess_1', promptIdAt(earlier));
    expect(r.workingSince('sess_1')).toBe(later);
  });

  it('opens the turn at the start\'s own instant and closes it at the end\'s, with no context request at all', async () => {
    const r = await rig();
    const started = r.now - 60_000;
    expect(await r.event(turn('start', started))).toMatchObject({ persisted: true });
    expect(r.workingSince('sess_1')).toBe(started);
    expect((await r.get('/api/projects/proj_1/sessions/sess_1')).session).toMatchObject({ working: true, workingSince: started });
    expect(await r.event(turn('end', started + 20_000))).toMatchObject({ persisted: true });
    expect(r.workingRow('sess_1')).toEqual({ working_since: null, last_turn_end_at: started + 20_000 });
  });

  it('never closes a later turn with an end drained late, and never reopens a turn its end already closed', async () => {
    const r = await rig();
    const first = r.now - 60_000;
    const second = r.now - 30_000;
    await r.event(turn('start', first));
    // The first turn's end sat in the spool; the next turn's start reached the Deployment before it.
    await r.event(turn('start', second));
    await r.event(turn('end', first + 5_000));
    expect(r.workingSince('sess_1')).toBe(second);
    await r.event(turn('end', second + 5_000));
    expect(r.workingSince('sess_1')).toBeNull();
    // A start older than the last end reached opens nothing.
    await r.event(turn('start', second + 1_000));
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('opens a session\'s first turn even before its start event lands, on the session row its receipt opens', async () => {
    const r = await rig();
    const at = r.now - 5_000;
    await r.event(turn('start', at, { sessionId: 'sess_new' }));
    expect(r.workingSince('sess_new')).toBe(at);
  });

  it('opens nothing for a start further from the Deployment\'s clock than the skew bound, for an import, or for a duplicate delivery', async () => {
    const r = await rig();
    await r.event(turn('start', r.now - MAX_CLOCK_SKEW_MS - 60_000));
    expect(r.workingSince('sess_1')).toBeNull();
    await r.event(turn('start', r.now - 1_000, { channel: 'import' }));
    expect(r.workingSince('sess_1')).toBeNull();
    // A delivery that stores nothing opens nothing: the start lands, the turn is set aside, and the same event comes again.
    const replayed = envelope({ eventId: uuid(950), ...turn('start', r.now - 2_000) });
    await worker.fetch(memberPost(r.token, replayed, '/events'), r.e.env, r.e.deferred);
    expect(r.workingSince('sess_1')).toBe(r.now - 2_000);
    r.e.sqlite.run(`UPDATE sessions SET working_since = NULL WHERE session_id = 'sess_1'`);
    const again = (await (await worker.fetch(memberPost(r.token, replayed, '/events'), r.e.env, r.e.deferred)).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ persisted: true, duplicate: true });
    expect(r.workingSince('sess_1')).toBeNull();
  });

  it('closes nothing with an end an import carries, and refuses a turn naming no phase or one it does not know', async () => {
    const r = await rig();
    const started = r.now - 60_000;
    await r.event(turn('start', started));
    await r.event(turn('end', started + 1_000, { channel: 'import' }));
    expect(r.workingSince('sess_1')).toBe(started);
    expect(await r.event({ kind: 'turn', sessionId: 'sess_1', createdAt: r.now, payload: {} })).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(await r.event(turn('paused', r.now))).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(r.workingSince('sess_1')).toBe(started);
  });

  it('keeps the context request\'s stamp beside the event: either opens the turn, and the event\'s end closes what the request opened', async () => {
    const r = await rig();
    const at = r.now - 40_000;
    await r.prompt('sess_1', promptIdAt(at));
    expect(r.workingSince('sess_1')).toBe(at);
    await r.event(turn('end', at + 10_000));
    expect(r.workingSince('sess_1')).toBeNull();
  });
});
