import { launchParentSession } from '@myco/member/session-lineage.js';
import { expect } from 'bun:test';
import {
  type lineage_SessionLineage as SessionLineage,
} from '@myco-server-worker/read/catalog/lineage.js';
import { type session_activity_SessionActivityRow as SessionActivityRow } from '@myco-server-worker/read/catalog/session-activity.js';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { event } from '../clients/requests.ts';

/** Launch and continuation parents recorded by `session.start`, read back as a family and as agent activity on both front doors. */
export const sessionLineageParity: ParityScenario = {
  name: 'session lineage: launch and continuation parents, unresolved parents, ordered child pages',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const id = (name: string) => `parity-lineage-${name}-${stamp}`;
    const start = (name: string, at: number, payload: Record<string, unknown>) =>
      event(target, id(name), 'session.start', { agent: 'claude-code', startedAt: at, ...payload }, at);
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

    const opened = async (name: string) => {
      const response = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${encodeURIComponent(id(name))}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return (await response.json() as { session: { launchParentSessionId: string | null; parentSessionId: string | null } }).session;
    };
    expect(await opened('worker')).toMatchObject({ launchParentSessionId: id('root'), parentSessionId: null });
    expect(await opened('next')).toMatchObject({ launchParentSessionId: id('root'), parentSessionId: id('worker') });
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

    await start('unicode-\ue000', stamp + 10, launched('unicode-\ue000', 'root'));
    await start('unicode-😀', stamp + 10, launched('unicode-😀', 'root'));
    const first = await read<{ rows: SessionActivityRow[]; cursor: string }>('root', 'activity?limit=1');
    expect(first.rows.map(row => row.sessionId)).toEqual([id('unicode-😀')]);
    const later = await read<{ rows: SessionActivityRow[] }>('root', `activity?limit=1&cursor=${encodeURIComponent(first.cursor)}`);
    expect(later.rows.map(row => row.sessionId)).toEqual([id('unicode-\ue000')]);

  },
};
