import { expect } from 'bun:test';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { MEMBER_ID, type ParityScenario } from '../harness.ts';

/** The deployed native and Cloudflare stores expose the same retired schema boundary. */
export const retiredSchema: ParityScenario = {
  name: 'retired schema: generated skills and digests have no tables, FTS objects or embedding source',
  async run(target) {
    expect(await target.sql(`SELECT value FROM schema_meta WHERE key = 'version'`))
      .toEqual([{ value: String(SERVER_SCHEMA_VERSION) }]);
    expect(await target.sql(`SELECT name FROM sqlite_master WHERE name LIKE 'skill_%' OR name LIKE 'digest_extract%' ORDER BY name`))
      .toEqual([]);
    const view = await target.sql(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'embedding_sources'`);
    expect(view).toHaveLength(1);
    expect(String(view[0]!.sql)).not.toContain('skill_records');
    await target.sql(`SELECT record_id FROM embedding_sources LIMIT 1`);

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
    const retired = ['skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage', 'digest_extracts', 'digest_extract_revisions'];
    const header = {
      format: 'myco-backup/1', deploymentId: meta[0]!.value, schemaVersion: 85, createdAt: 1, producer: 'parity',
      counts: { projects: 1, ...Object.fromEntries(retired.map((table) => [table, 1])) },
    };
    const artifact = [
      header,
      { t: 'projects', r: { project_id: project, name: project, created_at: 1 } },
      ...retired.map((table) => ({ t: table, r: { project_id: project, id: `retired_${table}` } })),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n';
    try {
      for (const inserted of [1, 0]) {
        const response = await fetch(`${target.url}/api/backups/restore-upload`, {
          method: 'POST', headers: owner, body: JSON.stringify({ artifact }),
        });
        const body = await response.json() as { applied?: boolean; tables?: Record<string, { inserted: number }> };
        expect({ status: response.status, applied: body.applied, inserted: body.tables?.projects?.inserted })
          .toEqual({ status: 200, applied: true, inserted });
        expect(await target.sql(`SELECT project_id FROM projects WHERE project_id = '${project}'`))
          .toEqual([{ project_id: project }]);
      }
    } finally {
      await target.sql(`DELETE FROM projects WHERE project_id = '${project}'`);
    }
  },
};
