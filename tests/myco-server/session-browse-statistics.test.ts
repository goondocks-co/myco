/**
 * The session list across Projects, what a Project holds, and the repositories machines could not capture: paging that
 * never skips or repeats a row, counters that agree with the rows they summarise, `building` instead of a false zero,
 * and the live state every list reads. What these reads cost as history grows is `polled-reads-cost.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { projectStatistics } from '@myco-server-worker/db/sessions/statistics.js';
import { decodeUncapturedCursor, getUncaptured, listUncaptured } from '@myco-server-worker/db/sessions/uncaptured-roots.js';
import { archiveProject } from '@myco-server-worker/db/storage/s2a3.js';
import { sessionQuietBefore } from '@myco-server-worker/core/session-quiet.js';
import {
  sessions_getSession as getSession,
  sessions_listSessionSummaries as listSessionSummaries,
  sessions_listSessionSummariesAcross as listAcross,
} from '@myco-server-worker/read/catalog/sessions.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/constants.js';
import { issueMemberToken } from './helpers/member-token.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const MINUTE = 60_000;

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

  it('reads a session as live while heard from within the idle close or resumed after its end, as ended once quiet past it with no end sent, alike in every list', async () => {
    const r = rig();
    const quietBefore = await sessionQuietBefore(r.serverEnv, NOW);
    r.session('proj_1', 'talking', { at: NOW - MINUTE, endedAt: null });
    r.session('proj_1', 'ended', { at: NOW - MINUTE });
    r.session('proj_1', 'quiet', { at: quietBefore, endedAt: null });
    r.session('proj_1', 'resumed', { at: NOW - 2 * MINUTE, endedAt: NOW - DAY });
    r.sqlite.run(`UPDATE sessions SET started_at = ?, working_since = ? WHERE session_id = 'resumed'`, [NOW - 2 * DAY, NOW - 4 * 60 * MINUTE]);
    const read = async (state?: 'open' | 'ended') => (await listSessionSummaries(r.db, { projectId: 'proj_1' }, { state, quietBefore }, NOW)).rows.map(row => [row.sessionId, row.live, row.liveUntil]);
    const open = [['talking', true, 2 * NOW - MINUTE - quietBefore], ['resumed', true, 2 * NOW - 2 * MINUTE - quietBefore]], ended = [['ended', false, null], ['quiet', false, null]];
    expect({ all: await read(), open: await read('open'), ended: await read('ended') }).toEqual({ all: [open[0], ended[0], ended[1], open[1]], open, ended });
    const across = async (filters: { state?: 'open'; since?: number }) => (await listAcross(r.db, { all: true }, { ...filters, window: 'activity', quietBefore }, NOW)).rows.map(row => row.sessionId);
    expect({ liveNow: await across({ state: 'open' }), today: await across({ since: NOW - 60 * MINUTE }) }).toEqual({ liveNow: ['talking', 'resumed'], today: ['talking', 'ended', 'resumed'] });
    expect(await getSession(r.db, { projectId: 'proj_1' }, 'quiet', NOW, quietBefore)).toMatchObject({ endedAt: null, live: false, liveUntil: null });
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
});

describe('the repositories machines could not capture', () => {
  it('pages ties by machine and root without skipping or repeating one, for an administrator and for a member, from machines in contact alone', async () => {
    const r = rig();
    for (const id of ['mem_a', 'mem_b']) r.sqlite.run(`INSERT INTO members (id, role, created_at) VALUES (?, 'member', 1)`, [id]);
    for (const machineId of ['m1', 'm2']) await issueMemberToken(r.db, { memberId: 'mem_a', machineId }, NOW);
    await issueMemberToken(r.db, { memberId: 'mem_a', machineId: 'm_former' }, NOW - MEMBER_TOKEN_TTL_MS);
    const root = (machine: string, key: string, member: string, seen: number) => r.sqlite.run(`INSERT INTO uncaptured_roots
      (machine_id, root_key, member_id, label, remote, reason, misses, held, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'repo', NULL, 'no_remote', 1, 'held', 1, ?)`, [machine, key, member, seen]);
    root('m2', 'k1', 'mem_a', 100); root('m1', 'k2', 'mem_a', 100); root('m1', 'k1', 'mem_a', 100); root('m1', 'k3', 'mem_b', 50); root('m_former', 'k4', 'mem_a', 200);
    const walk = async (scope: Parameters<typeof listUncaptured>[1]) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listUncaptured(r.db, scope, NOW, cursor === undefined ? {} : { cursor });
        seen.push(...page.rows.map(row => `${row.machineId}/${row.rootKey}`));
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      return seen;
    };
    expect(await walk({ all: true })).toEqual(['m2/k1', 'm1/k2', 'm1/k1', 'm1/k3']);
    expect(await walk({ all: false, memberId: 'mem_a' })).toEqual(['m2/k1', 'm1/k2', 'm1/k1']);
    await issueMemberToken(r.db, { memberId: 'mem_a', machineId: 'm_former' }, NOW);
    expect(await walk({ all: false, memberId: 'mem_a' })).toEqual(['m_former/k4', 'm2/k1', 'm1/k2', 'm1/k1']);
    expect(await getUncaptured(r.db, 'm1', 'k3')).toMatchObject({ machineId: 'm1', rootKey: 'k3', lastSeenAt: 50 });
    expect(await getUncaptured(r.db, 'm1', 'absent')).toBeNull();
  });

  it('refuses a cursor it did not issue', async () => {
    expect(decodeUncapturedCursor('p1:1:proj:id')).toBeNull();
    expect(decodeUncapturedCursor('u1:notanumber:m:r')).toBeNull();
    expect(decodeUncapturedCursor('u1:5:machine%3Awith%3Acolon:root')).toEqual({ lastSeenAt: 5, machineId: 'machine:with:colon', rootKey: 'root' });
  });
});
