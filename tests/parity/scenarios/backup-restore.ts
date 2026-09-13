import { expect } from 'bun:test';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';
import { bootSelfhosted } from '../targets/selfhosted.ts';

// State-changing owner routes hold a same-origin line; a scenario names its own origin the way a browser would.
const ownerJson = (target: ParityTarget) => ({ ...target.ownerHeaders(), 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', origin: target.url });

async function ownerPost<T>(target: ParityTarget, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${target.url}${path}`, { method: 'POST', headers: ownerJson(target), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

export const restoreContinuation: ParityScenario = {
  name: 'backup: interrupted report restore resumes through the owner HTTP route',
  async run(target) {
    await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (${lit(target.projectId)}, 'parity', 1)`);
    await target.sql(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_restore', 'restore', 'built-in', 1, 1)`);
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
      VALUES (${lit(target.projectId)}, 'run_restore', 'agent_restore', 'completed', 1)`);
    const meta = await target.sql(`SELECT key, value FROM schema_meta WHERE key IN ('deployment_id', 'version')`);
    const header = {
      format: 'myco-backup/1', deploymentId: meta.find((row) => row.key === 'deployment_id')!.value,
      schemaVersion: Number(meta.find((row) => row.key === 'version')!.value),
      createdAt: 1, producer: 'parity', counts: { agent_reports: 60 },
    };
    const rows = Array.from({ length: 60 }, (_, i) => ({
      t: 'agent_reports', r: { id: i + 1, project_id: target.projectId, run_id: 'run_restore',
        agent_id: 'agent_restore', action: 'note', summary: `report ${i}`, created_at: 1 },
    }));
    const artifact = [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
    await target.sql(`CREATE TRIGGER restore_fixture_interruption BEFORE INSERT ON agent_reports
      WHEN NEW.id = 21 BEGIN SELECT RAISE(ABORT, 'restore fixture interruption'); END`);
    try {
      const failed = await ownerPost<{ reason: string }>(target, '/api/backups/restore-upload', { artifact });
      expect(failed.status).toBe(400);
      expect(failed.body.reason).toContain('restore fixture interruption');
      expect(await target.sql(`SELECT COUNT(*) AS n FROM agent_reports WHERE run_id = 'run_restore'`)).toEqual([{ n: 20 }]);
      expect(await target.sql(`SELECT next_row FROM backup_restore_progress WHERE table_name = 'agent_reports'`)).toEqual([{ next_row: 20 }]);
      await target.sql('DROP TRIGGER restore_fixture_interruption');
      const restored = await ownerPost<{ applied: boolean; tables: Record<string, { rows: number; inserted: number }> }>(target, '/api/backups/restore-upload', { artifact });
      expect({ status: restored.status, applied: restored.body.applied, reports: restored.body.tables.agent_reports })
        .toEqual({ status: 200, applied: true, reports: { rows: 60, inserted: 40 } });
      expect(await target.sql(`SELECT id, summary FROM agent_reports WHERE run_id = 'run_restore' ORDER BY id`))
        .toEqual(rows.map(({ r }) => ({ id: r.id, summary: r.summary })));
    } finally {
      await target.sql('DROP TRIGGER IF EXISTS restore_fixture_interruption');
      await target.sql(`DELETE FROM agent_reports WHERE run_id = 'run_restore'`);
      await target.sql(`DELETE FROM backup_restore_progress WHERE table_name = 'agent_reports'`);
      await target.sql(`DELETE FROM agent_runs WHERE id = 'run_restore'`);
      await target.sql(`DELETE FROM agents WHERE id = 'agent_restore'`);
    }
  },
};

/**
 * The backup story on one target, then across targets: create, list verified,
 * preview, additive restore that converges, and an artifact carried to a
 * SIBLING deployment — refused as foreign until deliberately adopted.
 */
export const backupRestore: ParityScenario = {
  name: 'backup: create, verified list, preview, converging restore, and cross-deployment adoption',
  async run(target) {
    await target.sql(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (${lit(target.projectId)}, 'sess_backup', 'm_parity', 'mt_parity', 1, 1)`);

    const created = await ownerPost<{ backup: { id: string } }>(target, '/api/backups', {});
    expect(created.status).toBe(200);
    const id = created.body.backup.id;

    const listed = await fetch(`${target.url}/api/backups`, { headers: ownerJson(target) });
    const list = (await listed.json()) as { backups: Array<{ id: string; present: boolean }> };
    expect(list.backups.find((b) => b.id === id)?.present).toBe(true);

    const preview = await ownerPost<{ foreignLineage: boolean; header: { counts: Record<string, number> } }>(target, `/api/backups/${id}/restore-preview`, {});
    expect({ status: preview.status, foreign: preview.body.foreignLineage }).toEqual({ status: 200, foreign: false });
    expect(preview.body.header.counts.sessions).toBeGreaterThanOrEqual(1);

    const restored = await ownerPost<{ applied: boolean; tables: Record<string, { inserted: number }> }>(target, `/api/backups/${id}/restore`, {});
    expect({ status: restored.status, applied: restored.body.applied }).toEqual({ status: 200, applied: true });
    const again = await ownerPost<{ tables: Record<string, { inserted: number }> }>(target, `/api/backups/${id}/restore`, {});
    expect(Object.values(again.body.tables).every((t) => t.inserted === 0)).toBe(true);

    // Across deployments: the artifact travels; a sibling refuses it as foreign until adopted.
    const artifact = await fetch(`${target.url}/api/backups/${id}/artifact`, { headers: ownerJson(target) });
    expect(artifact.status).toBe(200);
    const text = await artifact.text();

    const sibling = await bootSelfhosted();
    try {
      const refused = await ownerPost<{ error: string }>(sibling, '/api/backups/restore-upload', { artifact: text });
      expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 409, error: 'foreign_lineage' });

      const adopted = await ownerPost<{ applied: boolean }>(sibling, '/api/backups/restore-upload', { artifact: text, allowForeignLineage: true });
      expect({ status: adopted.status, applied: adopted.body.applied }).toEqual({ status: 200, applied: true });
      const rows = await sibling.sql(`SELECT COUNT(*) AS c FROM sessions WHERE session_id = 'sess_backup'`);
      expect(Number((rows[0] as { c: unknown }).c)).toBe(1);

      // The reverse direction: the sibling's own backup lands here under the same adoption rule.
      const siblingBackup = await ownerPost<{ backup: { id: string } }>(sibling, '/api/backups', {});
      const siblingArtifact = await fetch(`${sibling.url}/api/backups/${siblingBackup.body.backup.id}/artifact`, { headers: ownerJson(sibling) });
      const back = await ownerPost<{ applied: boolean }>(target, '/api/backups/restore-upload', { artifact: await siblingArtifact.text(), allowForeignLineage: true });
      expect({ status: back.status, applied: back.body.applied }).toEqual({ status: 200, applied: true });
    } finally {
      await sibling.stop();
    }
  },
};
