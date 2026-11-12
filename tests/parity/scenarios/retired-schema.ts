import { expect } from 'bun:test';
import { MEMBER_ID, lit, type ParityScenario } from '../harness.ts';

/** The deployed native and Cloudflare stores expose the same retired schema boundary. */
export const retiredSchema: ParityScenario = {
  name: 'retired schema: generated skills and digests have no tables, FTS objects or embedding source',
  async run(target) {
    const owner = { ...target.ownerHeaders(), 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', origin: target.url };
    const selection = await target.sql(`SELECT member_id FROM deployment_ownership WHERE id = 1`);
    if (selection[0]?.member_id === null) {
      await target.sql(`UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1`);
      const preview = await fetch(`${target.url}/api/ownership`, { headers: owner });
      expect(preview.status).toBe(200);
      const revision = (await preview.json() as { revision: string }).revision;
      const selected = await fetch(`${target.url}/api/ownership`, {
        method: 'POST', headers: owner, body: JSON.stringify({ ownerMemberId: MEMBER_ID, revision }),
      });
      expect(selected.status).toBe(200);
    }

    const project = `retire_parity_${Date.now()}`;
    const meta = await target.sql(`SELECT value FROM schema_meta WHERE key = 'deployment_id'`);
    const retired = ['skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage', 'digest_extracts', 'digest_extract_revisions', 'cortex_instructions'];
    const retiredReleaseRows = ['skill_records', 'digest_extracts'].map((namespace) => ({
      t: 'knowledge_release_state', r: {
        project_id: project, id: `release_${namespace}`, identity_key: `${project}:${namespace}:retired`,
        namespace, record_id: 'retired', state: 'draft', confidence: 'high', checked_at: 1, created_at: 1,
      },
    }));
    const header = {
      format: 'myco-backup/1', deploymentId: meta[0]!.value, schemaVersion: 85, createdAt: 1, producer: 'parity',
      counts: { projects: 1, ...Object.fromEntries(retired.map((table) => [table, 1])), knowledge_release_state: retiredReleaseRows.length },
    };
    const artifact = [
      header,
      { t: 'projects', r: { project_id: project, name: project, created_at: 1 } },
      ...retired.map((table) => ({ t: table, r: { project_id: project, id: `retired_${table}` } })),
      ...retiredReleaseRows,
    ].map((row) => JSON.stringify(row)).join('\n') + '\n';
    try {
      for (const inserted of [1, 0]) {
        const response = await fetch(`${target.url}/api/backups/restore-upload`, {
          method: 'POST', headers: owner, body: JSON.stringify({ artifact }),
        });
        const body = await response.json() as { applied?: boolean; tables?: Record<string, { rows: number; inserted: number; skipped?: string }> };
        expect({ status: response.status, applied: body.applied, inserted: body.tables?.projects?.inserted })
          .toEqual({ status: 200, applied: true, inserted });
        for (const table of retired) expect(body.tables?.[table])
          .toEqual({ rows: 1, inserted: 0, skipped: 'retired' });
        expect(body.tables?.knowledge_release_state)
          .toEqual({ rows: retiredReleaseRows.length, inserted: 0, skipped: 'retired' });
        expect(await target.sql(`SELECT project_id FROM projects WHERE project_id = '${project}'`))
          .toEqual([{ project_id: project }]);
        expect(await target.sql(`SELECT namespace FROM knowledge_release_state WHERE project_id = ${lit(project)}`)).toEqual([]);
      }
      const unknown = [{ ...header, counts: { skill_recordz: 1 } }, { t: 'skill_recordz', r: { project_id: project, id: 'typo' } }]
        .map((row) => JSON.stringify(row)).join('\n') + '\n';
      const refused = await fetch(`${target.url}/api/backups/restore-upload`, {
        method: 'POST', headers: owner, body: JSON.stringify({ artifact: unknown }),
      });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain('skill_recordz');
    } finally {
      await target.sql(`DELETE FROM projects WHERE project_id = '${project}'`);
    }

    // A restore rebuilds every projection, and this target is shared with the scenarios that follow.
    const building = async () => Number((await target.sql('SELECT COUNT(*) AS n FROM projection_catchup WHERE done = 0'))[0]!.n);
    for (let wake = 0; wake < 100 && await building() > 0; wake += 1) await target.clockWake();
    expect(await building()).toBe(0);
  },
};
