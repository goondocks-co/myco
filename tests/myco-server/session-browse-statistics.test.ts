/**
 * The session list across Projects, what a Project holds, and the repositories machines could not capture: paging that
 * never skips or repeats a row, counters that agree with the rows they summarise, `building` instead of a false zero,
 * and reads that do not grow with the sessions a Deployment holds.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { projectStatistics } from '@myco-server-worker/db/sessions/statistics.js';
import { decodeUncapturedCursor, getUncaptured, listUncaptured } from '@myco-server-worker/db/sessions/uncaptured-roots.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { archiveProject } from '@myco-server-worker/db/storage/s2a3.js';
import {
  sessions_listSessionSummaries as listSessionSummaries,
  sessions_listSessionSummariesAcross as listAcross,
} from '@myco-server-worker/read/catalog/sessions.js';
import { measuredStore } from './helpers/read-budget.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function rig() {
  const e = sqliteEnv();
  const session = (project: string, id: string, over: { at?: number; endedAt?: number | null; agent?: string; occurredAt?: number } = {}) => {
    const at = over.at ?? NOW;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, occurred_started_at)
      VALUES (?, ?, 'm1', 'tok_1', ?, ?, ?, ?, ?, ?)`, [project, id, at, at, over.agent ?? 'claude-code', at, over.endedAt === undefined ? at : over.endedAt, over.occurredAt ?? null]);
  };
  const document = (project: string, id: string, prompts: number, toolCalls: number, state = 'live') =>
    e.sqlite.run(`INSERT INTO session_documents (project_id, session_id, state, generation, prompts, tool_calls, user_prompts, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 1)`, [project, id, state, prompts, toolCalls, prompts]);
  const attachment = (project: string, session: string, id: string) =>
    e.sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at) VALUES (?, ?, ?, ?, 'b', 'image/png', 1, 1, 't', 1)`, [project, id, session, id]);
  const plan = (project: string, key: string, session: string) =>
    e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content, content_hash, status, created_at, updated_at, token_id, received_at) VALUES (?, ?, ?, 'ep', 'm1', '- [ ] a', 'h', 'active', 1, 1, 't', 1)`, [project, key, session]);
  const tombstone = (project: string, session: string) =>
    e.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'mem_1')`, [project, session, NOW]);
  return { ...e, session, document, attachment, plan, tombstone };
}

async function catchUp(db: Parameters<typeof catchUpProjections>[0]): Promise<void> {
  for (let i = 0; i < 20 && (await catchUpProjections(db, { clock: () => NOW })).more; i += 1);
}

describe('the session list across Projects', () => {
  it('orders by the instant, the Project and the id, and pages one row at a time without skipping or repeating a tie', async () => {
    const r = rig();
    for (const project of ['proj_1', 'proj_2']) for (const id of ['a', 'b']) r.session(project, id);
    r.session('proj_1', 'older', { at: NOW - 10 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAcross(r.db, { all: true }, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }, NOW);
      seen.push(...page.rows.map(row => `${row.projectId}/${row.sessionId}`));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(['proj_2/b', 'proj_2/a', 'proj_1/b', 'proj_1/a', 'proj_1/older']);
  });

  it('never skips or repeats a row when sessions arrive between two pages', async () => {
    const r = rig();
    for (const id of ['a', 'b', 'c']) r.session('proj_1', id, { at: NOW - 100 });
    const first = await listAcross(r.db, { all: true }, { limit: 2 }, NOW);
    r.session('proj_2', 'newer', { at: NOW });
    r.session('proj_2', 'same-instant', { at: NOW - 100 });
    const rest = await listAcross(r.db, { all: true }, { limit: 50, cursor: first.cursor! }, NOW);
    expect(first.rows.map(row => row.sessionId)).toEqual(['c', 'b']);
    expect(rest.rows.map(row => row.sessionId)).toEqual(['a']);
  });

  it('reads nothing for a cursor from before the list ordered by the Project first', async () => {
    const r = rig();
    r.session('proj_1', 'a');
    expect(await listAcross(r.db, { all: true }, { cursor: `p1:${NOW}:proj_1:a` }, NOW)).toEqual({ rows: [], cursor: null });
  });

  it('keeps what each view always showed: no deleted session, archived Projects out of the all-Projects view, imported sessions in, a named Project in', async () => {
    const r = rig();
    r.session('proj_1', 'live');
    r.session('proj_1', 'deleted');
    r.tombstone('proj_1', 'deleted');
    r.session('proj_1', 'imported', { occurredAt: NOW - DAY });
    r.session('proj_2', 'archived');
    await archiveProject(r.db, 'proj_2', 'mem_1', NOW);
    const ids = (rows: readonly { sessionId: string }[]) => rows.map(row => row.sessionId);
    expect(ids((await listAcross(r.db, { all: true }, {}, NOW)).rows)).toEqual(['live', 'imported']);
    expect(ids((await listAcross(r.db, { all: false, projectIds: ['proj_1', 'proj_2'] }, {}, NOW)).rows).sort()).toEqual(['archived', 'imported', 'live']);
    expect(ids((await listSessionSummaries(r.db, { projectId: 'proj_1' }, {}, NOW)).rows)).toEqual(['live', 'imported']);
  });
});

describe('what a Project holds', () => {
  it('counts sessions, open sessions, days, prompts, tool calls, plans and attachments from rows on every source change', async () => {
    const r = rig();
    r.session('proj_1', 'open', { endedAt: null });
    r.document('proj_1', 'open', 2, 3);
    r.session('proj_1', 'ended');
    r.document('proj_1', 'ended', 4, 5);
    r.session('proj_1', 'old', { at: NOW - 30 * DAY });
    r.session('proj_1', 'occurred-old', { occurredAt: NOW - 30 * DAY });
    r.session('proj_2', 'elsewhere', { endedAt: null });
    r.attachment('proj_1', 'open', 'a1');
    r.attachment('proj_1', 'open', 'a2');
    r.plan('proj_1', 'plan-1', 'open');
    const read = () => projectStatistics(r.db, 'proj_1', NOW);
    expect(await read()).toEqual({ state: 'ready', sessions: 4, openSessions: 1, sessionsLast7d: 2, prompts: 6, toolCalls: 8, plans: 1, attachments: 2, lastActivityAt: NOW });

    r.sqlite.run(`UPDATE sessions SET ended_at = ? WHERE project_id = 'proj_1' AND session_id = 'open'`, [NOW]);
    r.sqlite.run(`UPDATE session_documents SET prompts = 7, tool_calls = 1 WHERE project_id = 'proj_1' AND session_id = 'open'`);
    r.sqlite.run(`DELETE FROM attachments WHERE project_id = 'proj_1' AND attachment_id = 'a2'`);
    expect(await read()).toMatchObject({ openSessions: 0, prompts: 11, toolCalls: 6, attachments: 1 });

    r.sqlite.run(`UPDATE session_documents SET state = 'convert' WHERE project_id = 'proj_1' AND session_id = 'open'`);
    expect(await read()).toMatchObject({ prompts: 4, toolCalls: 5 });
    r.sqlite.run(`UPDATE session_documents SET state = 'live' WHERE project_id = 'proj_1' AND session_id = 'open'`);

    r.tombstone('proj_1', 'open');
    expect(await read()).toMatchObject({ sessions: 3, openSessions: 0, sessionsLast7d: 1, prompts: 4, toolCalls: 5, attachments: 0 });
  });

  it('counts the seven UTC days through today, however late in the day it is read', async () => {
    const r = rig();
    const dayStart = Math.floor(NOW / DAY) * DAY;
    r.session('proj_1', 'six-days-ago', { at: dayStart - 6 * DAY });
    r.session('proj_1', 'seven-days-ago', { at: dayStart - 7 * DAY + 1 });
    expect(await projectStatistics(r.db, 'proj_1', dayStart + DAY - 1)).toMatchObject({ sessionsLast7d: 1 });
  });

  it('counts an attachment that arrives before its document, and a session whose document arrives later', async () => {
    const r = rig();
    r.session('proj_1', 's');
    r.attachment('proj_1', 's', 'a');
    expect(await projectStatistics(r.db, 'proj_1', NOW)).toMatchObject({ prompts: 0, attachments: 1 });
    r.document('proj_1', 's', 3, 1);
    expect(await projectStatistics(r.db, 'proj_1', NOW)).toMatchObject({ prompts: 3, toolCalls: 1, attachments: 1 });
  });

  it('says building, never zero, until existing rows have been counted, and counts each once when writes land during the catch-up', async () => {
    const r = rig();
    for (let i = 0; i < 120; i += 1) { r.session('proj_1', `s${i}`, { endedAt: i < 3 ? null : NOW }); r.document('proj_1', `s${i}`, 1, 2); }
    r.attachment('proj_1', 's0', 'a');
    r.sqlite.run(`DELETE FROM session_statistics`);
    r.sqlite.run(`DELETE FROM session_attachment_counts`);
    r.sqlite.run(`UPDATE project_session_counts SET open_sessions = 0, prompts = 0, tool_calls = 0, attachments = 0`);
    r.sqlite.run(`DELETE FROM project_session_days`);
    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'project_statistics'`);
    expect(await projectStatistics(r.db, 'proj_1', NOW)).toEqual({ state: 'building' });

    await catchUpProjections(r.db, { budget: { calls: 8, wallMs: 60_000 }, clock: () => NOW });
    expect(await projectStatistics(r.db, 'proj_1', NOW)).toEqual({ state: 'building' });
    r.session('proj_1', 'during');
    r.document('proj_1', 'during', 10, 20);
    r.sqlite.run(`UPDATE sessions SET ended_at = NULL WHERE project_id = 'proj_1' AND session_id = 's100'`);
    await catchUp(r.db);

    expect(await projectStatistics(r.db, 'proj_1', NOW)).toMatchObject({ state: 'ready', sessions: 121, openSessions: 4, prompts: 130, toolCalls: 260, attachments: 1 });

    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'project_statistics'`);
    await catchUp(r.db);
    expect(await projectStatistics(r.db, 'proj_1', NOW)).toMatchObject({ state: 'ready', sessions: 121, openSessions: 4, prompts: 130, toolCalls: 260, attachments: 1 });
  });

  it('reads the same rows for one Project however many sessions it holds, on the store the Deployment runs on', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
    try {
      const d1 = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
      const seed = async (project: string, size: number, at: number) => {
        await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
        const ids = JSON.stringify(Array.from({ length: size }, (_, n) => n));
        await d1.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,ended_at)
          SELECT ?1,'s'||value,'m1','tok_1',?2,?2,'claude-code',?2 FROM json_each(?3)`).bind(project, at, ids).run();
        await d1.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,user_prompts,prompts,tool_calls,updated_at) SELECT ?1,'s'||value,'live',1,1,1,1,1 FROM json_each(?2)`).bind(project, ids).run();
      };
      const measured = measuredStore(d1);
      const cost = async (read: () => Promise<unknown>) => { measured.reset(); await read(); return measured.reads(); };
      const stats = (project: string) => cost(() => projectStatistics(measured.db, project, NOW));
      const page = (project: string) => cost(() => listSessionSummaries(measured.db, { projectId: project }, { limit: 50 }, NOW));
      const across = () => cost(() => listAcross(measured.db, { all: true }, { limit: 50 }, NOW));
      await seed('proj_small', 100, NOW);
      await seed('proj_zzz', 1, NOW);
      const acrossBefore = await across();
      await seed('proj_large', 3000, NOW - DAY);
      expect(await stats('proj_large')).toBe(await stats('proj_small'));
      expect(await page('proj_large')).toBe(await page('proj_small'));
      expect(await across()).toBe(acrossBefore);
    } finally { await mf.dispose(); }
  }, 120_000);
});

describe('the repositories machines could not capture', () => {
  it('pages ties by machine and root without skipping or repeating one, for an administrator and for a member', async () => {
    const r = rig();
    for (const id of ['mem_a', 'mem_b']) r.sqlite.run(`INSERT INTO members (id, role, created_at) VALUES (?, 'member', 1)`, [id]);
    const root = (machine: string, key: string, member: string, seen: number) => r.sqlite.run(`INSERT INTO uncaptured_roots
      (machine_id, root_key, member_id, label, remote, reason, misses, held, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'repo', NULL, 'no_remote', 1, 'held', 1, ?)`, [machine, key, member, seen]);
    root('m2', 'k1', 'mem_a', 100); root('m1', 'k2', 'mem_a', 100); root('m1', 'k1', 'mem_a', 100); root('m1', 'k3', 'mem_b', 50);
    const walk = async (scope: Parameters<typeof listUncaptured>[1]) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listUncaptured(r.db, scope, cursor === undefined ? {} : { cursor });
        seen.push(...page.rows.map(row => `${row.machineId}/${row.rootKey}`));
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      return seen;
    };
    expect(await walk({ all: true })).toEqual(['m2/k1', 'm1/k2', 'm1/k1', 'm1/k3']);
    expect(await walk({ all: false, memberId: 'mem_a' })).toEqual(['m2/k1', 'm1/k2', 'm1/k1']);
    expect(await getUncaptured(r.db, 'm1', 'k3')).toMatchObject({ machineId: 'm1', rootKey: 'k3', lastSeenAt: 50 });
    expect(await getUncaptured(r.db, 'm1', 'absent')).toBeNull();
  });

  it('refuses a cursor it did not issue', async () => {
    expect(decodeUncapturedCursor('p1:1:proj:id')).toBeNull();
    expect(decodeUncapturedCursor('u1:notanumber:m:r')).toBeNull();
    expect(decodeUncapturedCursor('u1:5:machine%3Awith%3Acolon:root')).toEqual({ lastSeenAt: 5, machineId: 'machine:with:colon', rootKey: 'root' });
  });
});
