import { expect } from 'bun:test';
import type { SessionActivityRow } from '@myco-server-worker/read/session-activity.js';
import { documentsPublished, expectPersisted, lit, type ParityScenario } from '../harness.ts';

/** Stored result reasons, metadata filters and success upgrades, read from the session's document through both front doors. */
export const sessionActivityParity: ParityScenario = {
  name: 'session activity: stored reasons, scoped keyset filters, prompt targets and success upgrade',
  async run(target) {
    const stamp = Date.now();
    const session = `parity-activity-${stamp}`;
    const prompt = crypto.randomUUID();
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const post = async (kind: string, at: number, payload: Record<string, unknown>) => {
      const response = await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(response, kind);
    };
    const read = async (query = '') => {
      const response = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/activity${query}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return await response.json() as { rows: SessionActivityRow[]; cursor: string | null; tools: string[] };
    };
    await post('session.start', stamp, { agent: 'claude-code', startedAt: stamp });
    await post('prompt', stamp + 1, { promptId: prompt, origin: 'user', text: 'Inspect activity' });
    const reasons = ['reported', 'no_result', 'pending_limit', 'no_result', 'no_result'] as const;
    for (const [index, resultReason] of reasons.entries()) {
      await post('tool.use', stamp + index + 2, { toolCallId: ids[index], promptId: index === 0 ? prompt : undefined, toolName: index === 0 ? 'Read' : 'Bash', input: { secret: 'activity input secret' }, output: 'activity output secret', success: false, resultReason });
    }
    await documentsPublished(target, session);
    const full = await read();
    expect(full.rows.map(row => row.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(full.rows.at(-1)?.promptId).toBe(prompt);
    expect(full.rows.slice(0, -1).every(row => row.promptId === null && row.detail.includes('Not placed on a turn'))).toBe(true);
    expect(full.rows.map(row => row.resultReason)).toEqual(['no_result', 'no_result', 'pending_limit', 'no_result', 'reported']);
    expect(full.tools).toEqual(['Bash', 'Read']);
    expect(JSON.stringify(full)).not.toMatch(/activity input secret|activity output secret/);
    expect((await read('?tool=Read&type=failure&failed=true')).rows.map(row => row.id)).toEqual([ids[0]]);
    expect((await read('?type=no_result')).rows.map(row => row.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
    expect((await read('?failed=false')).rows).toEqual([]);
    await post('tool.use', stamp + 20, { toolCallId: ids[1], toolName: 'Bash', input: {}, output: 'success', success: true });
    await documentsPublished(target, session);
    expect((await read()).rows.map(row => row.id)).not.toContain(ids[1]);
  },
};
