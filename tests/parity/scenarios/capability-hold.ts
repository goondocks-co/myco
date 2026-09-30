import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/** How far other queued runs, and other workers' last contact, are moved back while this scenario asks, and forward again afterwards. */
const PARK_MS = 86_400_000;

/**
 * The worker capability a queued map run waits for, named alike on both targets (#1475, #1481): the fleet's gap,
 * read from every worker heard from lately rather than from the worker asking. Asked through the worker's own route.
 */
export const capabilityHold: ParityScenario = {
  name: 'capability hold: a queued map run names the capability no worker heard from lately reports',
  async run(target: ParityTarget) {
    const now = Date.now();
    const runId = `run_parity_capability_${now}`;
    await target.sql(`INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (${lit(target.projectId)}, 'Capability parity', ${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    const parked = (await target.sql(`SELECT id FROM agent_runs WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL`))
      .map((r) => String((r as { id: string }).id));
    const others = (await target.sql(`SELECT credential_id AS id FROM worker_contacts`)).map((r) => String((r as { id: string }).id));
    const shift = async (by: number) => {
      if (parked.length > 0) await target.sql(`UPDATE agent_runs SET queued_at = queued_at + (${by}) WHERE id IN (${parked.map(lit).join(', ')})`);
      if (others.length > 0) await target.sql(`UPDATE worker_contacts SET last_seen_at = last_seen_at - (${by}) WHERE credential_id IN (${others.map(lit).join(', ')})`);
    };
    const claim = async (capabilities: string[]) => {
      const res = await fetch(`${target.url}/worker/claim`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ harnesses: [{ id: 'claude-code', authenticated: true }], capabilities }),
      });
      const answer = await res.json() as { claimed: boolean; reason?: string };
      return { status: res.status, claimed: answer.claimed, reason: answer.reason ?? null };
    };
    const holder = async () => (await target.sql(`SELECT held_by AS heldBy FROM agent_runs WHERE id = ${lit(runId)}`))[0];

    await shift(PARK_MS);
    try {
      await target.sql(
        `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context)
         VALUES (${lit(target.projectId)}, ${lit(runId)}, 'myco-agent', 'canopy-map', 'queued', ${now}, 'worker',
                 ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120, params: {} }))}, ${lit(JSON.stringify({ timeoutSeconds: 120 }))})`,
      );
      // The only worker heard from checks nothing out: the run waits for one that can.
      expect(await claim([])).toEqual({ status: 200, claimed: false, reason: 'no_work' });
      expect(await holder()).toEqual({ heldBy: 'repository-checkout' });
      // It now checks out but writes no digest listing: the run waits for an up-to-date worker.
      expect(await claim(['repository-checkout'])).toEqual({ status: 200, claimed: false, reason: 'no_work' });
      expect(await holder()).toEqual({ heldBy: 'repository-digests' });
    } finally {
      await target.sql(`DELETE FROM agent_runs WHERE id = ${lit(runId)}`);
      await shift(-PARK_MS);
    }
  },
};
