import { expect } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { listTitleCandidates } from '@myco-server-worker/read/children.js';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

const HOUR = 3_600_000;

/**
 * Sessions that never end (#1684) on both targets: an open session that has sent nothing for the idle bound is
 * titled by a `claim` run while its `ended_at` stays empty; a titled session still open that took enough new
 * prompts afterwards is refreshed by a `refresh` run, once per interval; and every statement the convergence reads
 * candidates with is planned through a partial index on the target's own store.
 */
export const titlingIdleRefresh: ParityScenario = {
  name: 'titling of sessions that never end: an idle open session is titled and stays open, a long open session is refreshed once per interval, and each candidate read uses its index',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = stamp) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'claude-code', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
    };
    /** Wakes until the session has a run, a page at a time: sessions other scenarios left behind take pages of their own. */
    const wakeUntilRun = async (id: string) => {
      for (let wakes = 0; wakes < 12 && (await runsOf(id)).length === 0; wakes += 1) await wake();
    };
    const runsOf = (id: string) => target.sql(`SELECT json_extract(run_context, '$.mode') AS mode, json_extract(dispatch_spec, '$.actor') AS actor FROM agent_runs
      WHERE task = 'title-summary' AND json_extract(run_context, '$.session_id') = ${lit(id)} ORDER BY COALESCE(queued_at, started_at), id`);
    const held = await target.sql(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`);
    const setting = (leaf: string, value: string) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(leaf)}, ${lit(value)}, ${stamp}, ${lit(MEMBER_ID)})`);
    await setting('agent.tasks', JSON.stringify({ 'title-summary': { schedule: { enabled: false, intervalSeconds: 0, maxRunsPerDay: 1000 } } }));
    try {
      // An open session that has sent nothing for three hours is titled; its end stays empty.
      const idle = `parity-idle-${stamp}`;
      await post(idle, 'session.start', { agent: 'codex', startedAt: stamp - 4 * HOUR }, stamp - 4 * HOUR);
      await post(idle, 'prompt', { promptId: crypto.randomUUID(), text: `Work in a pane that was closed ${stamp}`, origin: 'user' }, stamp - 4 * HOUR);
      await target.sql(`UPDATE sessions SET last_received_at = ${stamp - 3 * HOUR} WHERE session_id = ${lit(idle)}`);
      await wakeUntilRun(idle);
      expect(await runsOf(idle)).toEqual([{ mode: 'claim', actor: 'backfill' }]);
      expect(await target.sql(`SELECT ended_at IS NULL AS open, titled_at IS NOT NULL AS attempted FROM sessions WHERE session_id = ${lit(idle)}`)).toEqual([{ open: 1, attempted: 1 }]);

      // A session still open that took twelve prompts after its last titling is refreshed once.
      const live = `parity-live-${stamp}`;
      await post(live, 'session.start', { agent: 'claude-code', startedAt: stamp - 8 * HOUR }, stamp - 8 * HOUR);
      for (let i = 0; i < 12; i += 1) await post(live, 'prompt', { promptId: crypto.randomUUID(), text: `Step ${i} of the long job ${stamp}`, origin: 'user' }, stamp - 60_000 + i);
      await target.sql(`UPDATE sessions SET title = 'A long job', summary = 'It began hours ago.', titled_at = ${stamp - 5 * HOUR} WHERE session_id = ${lit(live)}`);
      await wakeUntilRun(live);
      expect(await runsOf(live)).toEqual([{ mode: 'refresh', actor: 'backfill' }]);
      expect(await target.sql(`SELECT titling_attempts AS attempts FROM sessions WHERE session_id = ${lit(live)}`)).toEqual([{ attempts: 0 }]);
      await wake();
      expect(await runsOf(live)).toHaveLength(1);

      // Each statement the candidate read issues is planned through an index, here on this target's store.
      const statements: Array<{ sql: string; binds: unknown[] }> = [];
      const recorder = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => { statements.push({ sql, binds }); return { all: async () => ({ results: [] }) }; } }) } as unknown as RelationalStore;
      await listTitleCandidates(recorder, { retryBefore: stamp - 600_000, idleBefore: stamp - 2 * HOUR, freshAfter: stamp - 24 * HOUR, refreshBefore: stamp - 4 * HOUR, refreshPrompts: 10, imported: true }, 5);
      const plans: string[] = [];
      for (const statement of statements) {
        let next = 0;
        const inlined = statement.sql.replace(/\?/g, () => String(statement.binds[next++]));
        plans.push((await target.sql(`EXPLAIN QUERY PLAN ${inlined}`)).map((row) => String(row.detail)).join('\n'));
      }
      const using = (index: string) => plans.filter((plan) => plan.includes(`USING INDEX ${index}`));
      expect(using('idx_sessions_untitled_ended')).toHaveLength(2);
      expect(using('idx_sessions_untitled_open')).toHaveLength(2);
      expect(using('idx_sessions_titled_recent')).toHaveLength(1);
      expect(plans.find((plan) => plan.includes('idx_sessions_titled_recent'))).toMatch(/idx_prompt_batches_user_received/);
      for (const plan of plans) expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    } finally {
      if (held.length === 0) await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.tasks'`);
      else await setting('agent.tasks', String(held[0]!.value));
    }
  },
};
