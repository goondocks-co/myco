/**
 * One row of title work per session and mode: what makes a session owed a title, when it becomes ready, how the
 * counters follow, and that what a pass reads does not grow with the sessions a Deployment holds.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import {
  deferTitleWork,
  takeTitleCandidates,
  takeTitleRequests,
  titleWorkOwed,
  TITLE_WORK_PROMOTE_PAGE,
  TITLE_WORK_RECHECK_MS,
} from '@myco-server-worker/db/sessions/title-work.js';
import { measuredStore } from './helpers/read-budget.js';
import { runningEnv } from './helpers/running-env.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const window = (now = NOW, imported = true) => ({ now, idleBefore: now - 2 * HOUR, freshAfter: now - DAY, imported });

function rig() {
  const e = runningEnv();
  const session = (id: string, over: { endedAt?: number | null; lastReceivedAt?: number; title?: string; titledAt?: number; prompts?: number; imported?: boolean; transcript?: boolean; requested?: number } = {}) => {
    const endedAt = over.endedAt === undefined ? NOW - 1000 : over.endedAt;
    const last = over.lastReceivedAt ?? endedAt ?? NOW - 1000;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title, titled_at, titling_requested_at)
      VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?, ?, ?)`, [id, last - 10_000, last, last - 10_000, endedAt, over.title ?? null, over.titledAt ?? null, over.requested ?? null]);
    e.sqlite.run(`INSERT INTO session_documents (project_id, session_id, state, generation, user_prompts, updated_at) VALUES ('proj_1', ?, 'live', 1, ?, 1)`, [id, over.prompts ?? 1]);
    if (over.transcript !== false) {
      e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id, imported_at)
        VALUES ('proj_1', ?, ?, 'm1', 100, 100, ?, ?, 'tok_1', ?)`, [`tx_${id}`, id, last, last, over.imported === false ? null : last]);
      e.sqlite.run(`INSERT INTO transcript_publication (project_id, transcript_id, generation, session_id, published_offset, record_scheme, parser_version, updated_at)
        VALUES ('proj_1', ?, 1, ?, 100, 'source-record-v1', 1, 1)`, [`tx_${id}`, id]);
    }
  };
  const row = (id: string, mode = 'claim') => e.sqlite.query(`SELECT ready, waits, cohort FROM session_title_work WHERE session_id = ? AND mode = ?`).get(id, mode) as { ready: number; waits: string; cohort: string } | null;
  return { ...e, session, row };
}

const ready = (candidates: { sessionId: string }[]) => candidates.map((candidate) => candidate.sessionId);

describe('a session\'s title work', () => {
  it('has one claim row while it is untitled, and none once it is titled or deleted', () => {
    const r = rig();
    r.session('open', { endedAt: null });
    r.session('ended');
    r.session('titled', { title: 'Named', titledAt: NOW });
    expect(r.row('open')).toMatchObject({ ready: 0, waits: 'quiet' });
    expect(r.row('ended')).toMatchObject({ ready: 0, waits: 'timer' });
    expect(r.row('titled')).toBeNull();
    r.sqlite.run(`UPDATE sessions SET title = 'Later' WHERE session_id = 'ended'`);
    expect(r.row('ended')).toBeNull();
    r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'open', NULL, ?, 'mem_1')`, [NOW]);
    expect(r.row('open')).toBeNull();
  });

  it('becomes ready when promoted, in its cohort, and the counters follow', async () => {
    const r = rig();
    r.session('live', { imported: false, endedAt: NOW - 1000 });
    r.session('imported', { endedAt: NOW - 2000 });
    r.session('no-prompts', { prompts: 0, imported: false });
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 0, imported: 0 });
    const candidates = await takeTitleCandidates(r.serverEnv.db, window(), 10);
    expect(ready(candidates.freshClaims)).toEqual(['live', 'imported']);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 1, imported: 1 });
    expect(r.row('no-prompts')).toMatchObject({ ready: 0, waits: 'material' });
    // A session the backfill switch does not admit stays out of the page, not out of the count.
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(NOW, false), 10)).freshClaims)).toEqual(['live']);
    r.sqlite.run(`UPDATE sessions SET title = 'Done' WHERE session_id = 'live'`);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 0, imported: 1 });
  });

  it('re-decides a ready session when its transcript changes class, so the backfill switch still holds', async () => {
    const r = rig();
    r.session('flips', { imported: false });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).freshClaims)).toEqual(['flips']);
    r.sqlite.run(`UPDATE transcripts SET imported_at = ? WHERE session_id = 'flips'`, [NOW]);
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(NOW + 1, false), 10)).freshClaims)).toEqual([]);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 0, imported: 1 });
  });

  it('takes the session that just went quiet ahead of an older backlog', async () => {
    const r = rig();
    for (let i = 0; i < 120; i += 1) r.session(`old-${i}`, { endedAt: null, lastReceivedAt: NOW - 30 * DAY + i, imported: false });
    r.session('fresh', { endedAt: null, lastReceivedAt: NOW - 3 * HOUR, imported: false });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).freshClaims)).toEqual(['fresh']);
  });

  it('wakes a claim parked for want of material when its document gains a prompt', async () => {
    const r = rig();
    r.session('silent', { prompts: 0, imported: false });
    await takeTitleCandidates(r.serverEnv.db, window(), 10);
    expect(r.row('silent')).toMatchObject({ ready: 0, waits: 'material' });
    r.sqlite.run(`UPDATE session_documents SET user_prompts = 1 WHERE session_id = 'silent'`);
    expect(r.row('silent')).toMatchObject({ waits: 'timer' });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).freshClaims)).toEqual(['silent']);
  });

  it('moves an open session out of the ready order as soon as it is active again', async () => {
    const r = rig();
    r.session('open', { endedAt: null, lastReceivedAt: NOW - 3 * HOUR, imported: false });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).backlogClaims)).toEqual([]);
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).freshClaims)).toEqual(['open']);
    r.sqlite.run(`UPDATE sessions SET last_received_at = ? WHERE session_id = 'open'`, [NOW]);
    expect(r.row('open')).toMatchObject({ ready: 0, waits: 'quiet' });
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 0, imported: 0 });
  });

  it('sleeps a row a pass found no longer takeable, so it never holds the head of the ready order', async () => {
    const r = rig();
    r.session('a', { imported: false });
    await takeTitleCandidates(r.serverEnv.db, window(), 10);
    await deferTitleWork(r.serverEnv.db, { projectId: 'proj_1', sessionId: 'a', mode: 'claim' }, NOW);
    expect(r.row('a')).toMatchObject({ ready: 0, waits: 'timer' });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(NOW + 1), 10)).freshClaims)).toEqual([]);
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(NOW + TITLE_WORK_RECHECK_MS), 10)).freshClaims)).toEqual(['a']);
  });

  it('waits longer each time it finds a session\'s capture still unsettled, and is ready as soon as a look finds it settled', async () => {
    const r = rig();
    r.session('a', { imported: false });
    r.sqlite.run(`UPDATE transcript_publication SET published_offset = 40 WHERE session_id = 'a'`);
    const due = () => (r.sqlite.query(`SELECT due_at FROM session_title_work WHERE session_id = 'a'`).get() as { due_at: number }).due_at;
    await takeTitleCandidates(r.serverEnv.db, window(), 10);
    expect(due()).toBe(NOW + TITLE_WORK_RECHECK_MS);
    await takeTitleCandidates(r.serverEnv.db, window(NOW + TITLE_WORK_RECHECK_MS), 10);
    expect(due()).toBe(NOW + 3 * TITLE_WORK_RECHECK_MS);
    r.sqlite.run(`UPDATE transcript_publication SET published_offset = 100 WHERE session_id = 'a'`);
    const settled = await takeTitleCandidates(r.serverEnv.db, window(NOW + 3 * TITLE_WORK_RECHECK_MS), 10);
    expect(ready(settled.freshClaims)).toEqual(['a']);
  });

  it('holds an end request until its session settles, oldest request first', async () => {
    const r = rig();
    r.session('early', { imported: false, requested: NOW - 5000, endedAt: NOW - 40_000 });
    r.session('later', { imported: false, requested: NOW - 1000, endedAt: NOW - 40_000 });
    r.session('settling', { imported: false, requested: NOW - 500, endedAt: NOW - 100 });
    expect(await takeTitleRequests(r.serverEnv.db, window(), 10)).toEqual([
      { projectId: 'proj_1', sessionId: 'early' }, { projectId: 'proj_1', sessionId: 'later' },
    ]);
    expect(await takeTitleRequests(r.serverEnv.db, window(NOW + 40_000), 10)).toHaveLength(3);
  });

  it('keeps a refresh row only past the prompt threshold, and clears it when a written title takes the prompts', async () => {
    const r = rig();
    r.session('fresh', { endedAt: null, lastReceivedAt: NOW - 1000, title: 'Named', titledAt: NOW - 5 * HOUR, prompts: 9, imported: false });
    expect(r.row('fresh', 'refresh')).toBeNull();
    r.sqlite.run(`UPDATE session_documents SET user_prompts = 12 WHERE session_id = 'fresh'`);
    expect(r.row('fresh', 'refresh')).toMatchObject({ ready: 0, waits: 'timer' });
    expect(ready((await takeTitleCandidates(r.serverEnv.db, window(), 10)).freshRefreshes)).toEqual(['fresh']);
    r.sqlite.run(`UPDATE session_documents SET titled_user_prompts = user_prompts WHERE session_id = 'fresh'`);
    expect(r.row('fresh', 'refresh')).toBeNull();
  });

  it('withholds the totals while the seed walks existing sessions, then answers them, and a replay changes nothing', async () => {
    const r = rig();
    r.session('s1', { imported: false, endedAt: NOW - 10 * HOUR });
    r.session('s2', { endedAt: NOW - 11 * HOUR });
    r.sqlite.run(`DELETE FROM session_title_work`);
    r.sqlite.run(`DELETE FROM session_title_work_counts`);
    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'session_title_work'`);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: true, live: null, imported: null });
    for (let i = 0; i < 3 && (await catchUpProjections(r.serverEnv.db, { clock: () => NOW })).more; i += 1);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 1, imported: 1 });
    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'session_title_work'`);
    for (let i = 0; i < 3 && (await catchUpProjections(r.serverEnv.db, { clock: () => NOW })).more; i += 1);
    expect(await titleWorkOwed(r.serverEnv.db)).toEqual({ building: false, live: 1, imported: 1 });
  });

  it('reads the same rows for a pass however many sessions are held, on the store the Deployment runs on', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
    try {
      const d1 = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
      const seed = async (project: string, size: number) => {
        await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
        const ids = JSON.stringify(Array.from({ length: size }, (_, n) => n));
        await d1.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,ended_at)
          SELECT ?1,'s'||value,'m1','tok_1',?2,?2,'claude-code',?2 FROM json_each(?3)`).bind(project, NOW - 10_000 * HOUR, ids).run();
        await d1.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,user_prompts,updated_at) SELECT ?1,'s'||value,'live',1,1,1 FROM json_each(?2)`).bind(project, ids).run();
      };
      const measured = measuredStore(d1);
      const pass = async () => { measured.reset(); await takeTitleCandidates(measured.db, window(), 5); return measured.reads(); };
      await seed('proj_small', 400);
      const small = await pass();
      for (let i = 0; i < 8; i += 1) await pass();
      const settledSmall = await pass();
      await d1.batch([d1.prepare('DELETE FROM session_documents'), d1.prepare('DELETE FROM sessions')]);
      await seed('proj_large', 4000);
      const large = await pass();
      for (let i = 0; i < 50; i += 1) await pass();
      const settledLarge = await pass();
      expect(large).toBe(small);
      expect(settledLarge).toBe(settledSmall);
      expect(TITLE_WORK_PROMOTE_PAGE).toBeLessThan(400);
    } finally { await mf.dispose(); }
  }, 120_000);
});
