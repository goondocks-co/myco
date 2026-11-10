import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { CHECKED_TABLES_SQL, quickCheckSql } from '@myco-server-worker/db/maintenance/store-checks.js';
import { documentsPublished, type ParityScenario } from '../harness.ts';
import { freshSchemaObjects, SCHEMA_OBJECTS_SQL } from '../schema-upgrade.ts';
import { observe, seededDeployment } from '../upgrade-seed/index.ts';
import { event, mcp, owner } from '../upgrade-seed/requests.ts';

/**
 * A Deployment its users populated through its routes, carried to the last release's schema and upgraded with every
 * step since (on Cloudflare through Wrangler's own apply, with its ledger naming every released file; self-hosted
 * through its own migrator), budget completion after: what every user and member read reads back as it did before,
 * the refusals they met are unchanged, the store holds the schema a fresh Deployment holds and passes its checks,
 * and the next writes land.
 */
export const latestSchemaUpgrade: ParityScenario = {
  name: 'schema upgrade: a Deployment populated by its users upgrades from the previous schema with every record, refusal and write unchanged',
  dedicated: { latestSchemaUpgrade: true, sqliteVec: true, timeoutMs: 240_000 },
  async run(target) {
    const version = SCHEMA_STEPS.at(-1)!.version;
    const status = await fetch(`${target.url}/api/status`, { headers: target.ownerHeaders() });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ schema: { expected: version, found: version, matches: true }, budget: { active: true } });
    // On Cloudflare the upgrade applied the checked-in files, so a file that drifted from its step differs here. What the
    // Deployment made at runtime (the native vector table) stands beside them.
    const fresh = await freshSchemaObjects();
    const declared = new Set(fresh.map((object) => `${object.type}:${object.name}`));
    expect((await target.sql(SCHEMA_OBJECTS_SQL)).filter((object) => declared.has(`${object.type}:${object.name}`))).toEqual(fresh);
    expect(await target.sql('PRAGMA foreign_key_check')).toEqual([]);
    const problems: unknown[] = [];
    for (const { name } of await target.sql(CHECKED_TABLES_SQL)) {
      problems.push(...(await target.sql(quickCheckSql(String(name)))).filter((row) => row.quick_check !== 'ok'));
    }
    expect(problems).toEqual([]);

    // The clock catches up on what the upgrade left to rebuild, as a Deployment's own wakes do after a deploy: the Project's
    // statistics, its activity feed and the search index each say when they are ready.
    const rebuilt = async () => {
      const home = (await owner(target, `/api/projects/${target.projectId}/activity`)).body;
      const search = (await owner(target, `/api/projects/${target.projectId}/search?mode=fts&q=upgrade`)).body;
      return { stats: home.stats?.state, feed: home.building === false ? 'ready' : 'building', search: search.coverage?.state };
    };
    const ready = { stats: 'ready', feed: 'ready', search: 'ready' };
    for (let wake = 0; wake < 12 && JSON.stringify(await rebuilt()) !== JSON.stringify(ready); wake += 1) {
      expect((await owner(target, '/api/wake', { method: 'POST' })).status).toBe(200);
    }
    expect(await rebuilt()).toEqual(ready);
    const { observed, ...seeded } = seededDeployment(target.deploymentId);
    expect(await observe(target, seeded)).toEqual(observed);

    // A setting written at the revision read before the upgrade is accepted; the next session turn, spore and plan land.
    const { setting } = seeded.machines;
    expect((await owner(target, `/api/settings/${setting.leaf}`, { method: 'PUT', headers: { 'if-match': setting.revision }, body: JSON.stringify({ value: 4 }) })).status).toBe(200);
    const { sessionId } = seeded.sessions.captured;
    const before = (await owner(target, `/api/projects/${target.projectId}/sessions/${sessionId}/turns`)).body.rows as Array<{ promptId: string; preview: string }>;
    const promptId = crypto.randomUUID();
    await event(target, sessionId, 'prompt', { promptId, text: 'after the upgrade', origin: 'user' }, Date.now());
    await documentsPublished(target, sessionId);
    const turns = await owner(target, `/api/projects/${target.projectId}/sessions/${sessionId}/turns`);
    expect((turns.body.rows as Array<{ promptId: string; preview: string }>).map((row) => [row.promptId, row.preview]))
      .toEqual([...before.map((row) => [row.promptId, row.preview]), [promptId, 'after the upgrade']]);
    const spore = await mcp(target, 'myco_spores', { op: 'save', type: 'discovery', content: 'written after the upgrade', agent_line: 'After an upgrade, new spores save as before.', session_id: sessionId, project: target.projectId });
    expect(await mcp(target, 'myco_spores', { op: 'get', id: String(spore.id) })).toMatchObject({ status: 'active', content: 'written after the upgrade', session_id: sessionId });
    const plan = await mcp(target, 'myco_plans', { op: 'save', session_id: sessionId, plan_key: `after-upgrade-${promptId}`, content: '- [x] upgraded', project: target.projectId });
    expect(await mcp(target, 'myco_plans', { op: 'get', id: String(plan.id) })).toMatchObject({ status: 'active', content: '- [x] upgraded', progress: '1/1' });
  },
};
