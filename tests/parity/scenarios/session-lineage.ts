import { launchParentSession } from '@myco/member/session-lineage.js';
import { expect } from 'bun:test';
import { sessionLineage, type SessionLineage } from '@myco-server-worker/read/lineage.js';
import { listSessionActivity, type SessionActivityRow } from '@myco-server-worker/read/session-activity.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The reads' statements and bound values, captured over a store that holds the named session and nothing else. */
async function issued(projectId: string, sessionId: string): Promise<Array<{ sql: string; binds: unknown[] }>> {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, binds: [] as unknown[] };
      statements.push(record);
      const statement = {
        bind(...values: unknown[]) { record.binds = values; return statement; },
        all: async () => ({ results: statements.length === 1
          ? [{ session_id: sessionId, agent: null, title: null, first_prompt: null, started_at: 1, ended_at: null, parent_session_id: null, parent_reason: null, launch_parent_session_id: null }]
          : [] }),
      } as unknown as PreparedStatement;
      return statement;
    },
  } as unknown as RelationalStore;
  await sessionLineage(db, { projectId }, sessionId);
  await listSessionActivity(db, { projectId }, sessionId, { type: 'child_session' });
  await listSessionActivity(db, { projectId }, sessionId, { type: 'continuation' });
  return statements;
}

/** A statement with its bound values written in, for `EXPLAIN QUERY PLAN` on a target. */
const inlined = ({ sql, binds }: { sql: string; binds: unknown[] }): string => {
  let next = 0;
  return sql.replace(/\?/g, () => {
    const value = binds[next++];
    return typeof value === 'number' ? String(value) : lit(String(value));
  });
};

/** Launch and continuation parents recorded by `session.start`, read back as a family and as agent activity on both front doors. */
export const sessionLineageParity: ParityScenario = {
  name: 'session lineage: launch and continuation parents, unresolved parents, children reads on their indexes',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const id = (name: string) => `parity-lineage-${name}-${stamp}`;
    const start = async (name: string, at: number, payload: Record<string, unknown>) => {
      const response = await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: id(name), kind: 'session.start', createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: at, ...payload } }),
      });
      await expectPersisted(response, `session.start ${name}`);
    };
    const read = async <T>(name: string, path: string): Promise<T> => {
      const response = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${encodeURIComponent(id(name))}/${path}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return await response.json() as T;
    };

    const launched = (name: string, parent: string) => ({
      launchParentSessionId: launchParentSession(id(name), { BAGGAGE: 'other=kept,gen_ai.conversation.id=' + encodeURIComponent(id(parent)) }),
    });
    await start('root', stamp, launched('root', 'not-captured'));
    await start('worker', stamp + 1, launched('worker', 'root'));
    await start('worker', stamp + 5, launched('worker', 'later-value'));
    await start('next', stamp + 2, { ...launched('next', 'root'), parentSessionId: id('worker'), parentReason: 'compact continuation' });
    await start('fixer', stamp + 3, launched('fixer', 'worker'));

    expect(await target.sql(`SELECT session_id, launch_parent_session_id, parent_session_id FROM sessions
      WHERE project_id = ${lit(target.projectId)} AND session_id IN (${['worker', 'next'].map((name) => lit(id(name))).join(',')}) ORDER BY started_at`))
      .toEqual([
        { session_id: id('worker'), launch_parent_session_id: id('root'), parent_session_id: null },
        { session_id: id('next'), launch_parent_session_id: id('root'), parent_session_id: id('worker') },
      ]);
    const lineage = await read<SessionLineage>('worker', 'lineage');
    expect(lineage.nodes.map((node) => [node.sessionId, node.depth, node.captured, node.current, node.placedUnder?.kind ?? null])).toEqual([
      [id('not-captured'), 0, false, false, null],
      [id('root'), 1, true, false, 'launched'],
      [id('worker'), 2, true, true, 'launched'],
      [id('fixer'), 3, true, false, 'launched'],
      [id('next'), 2, true, false, 'launched'],
    ]);
    expect(lineage.edges).toContainEqual({ parentId: id('worker'), childId: id('next'), kind: 'continuation', reason: 'compact continuation' });
    expect(lineage.truncated).toBe(false);

    const activity = await read<{ rows: SessionActivityRow[] }>('worker', 'activity');
    expect(activity.rows.map((row) => [row.type, row.sessionId, row.detail])).toEqual([
      ['child_session', id('fixer'), 'Child of this session'],
      ['continuation', id('next'), 'Continues this session’s conversation · compact continuation'],
    ]);

    const statements = await issued(target.projectId, id('worker'));
    const plan = async (marker: string) => {
      const statement = statements.find((s) => s.sql.includes(marker));
      expect(statement).toBeDefined();
      return (await target.sql(`EXPLAIN QUERY PLAN ${inlined(statement!)}`)).map((row) => String(row.detail)).join('\n');
    };
    for (const [column, index] of [['launch_parent_session_id', 'idx_sessions_launch_parent'], ['parent_session_id', 'idx_sessions_parent']] as const) {
      const children = await plan(`s.${column} IN (`);
      expect(children).toContain(`SEARCH s USING COVERING INDEX ${index} (project_id=? AND ${column}=?)`);
      expect(children).not.toMatch(/SCAN s\b|TEMP B-TREE/);
      const edges = await plan(`r.${column} = ?`);
      expect(edges).toContain(`SEARCH r USING INDEX ${index} (project_id=? AND ${column}=?)`);
      expect(edges).not.toMatch(/SCAN [rs]\b/);
    }
  },
};
