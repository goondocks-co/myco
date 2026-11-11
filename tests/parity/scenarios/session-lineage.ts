import { launchParentSession } from '@myco/member/session-lineage.js';
import { expect } from 'bun:test';
import {
  lineage_sessionLineage as sessionLineage,
  type lineage_SessionLineage as SessionLineage,
} from '@myco-server-worker/read/catalog/lineage.js';
import { type session_activity_SessionActivityRow as SessionActivityRow } from '@myco-server-worker/read/catalog/session-activity.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

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
  },
};
