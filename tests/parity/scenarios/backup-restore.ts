import { expect } from 'bun:test';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';
import { bootSelfhosted } from '../targets/selfhosted.ts';

// State-changing owner routes hold a same-origin line; a scenario names its own origin the way a browser would.
const ownerJson = (target: ParityTarget) => ({ ...target.ownerHeaders(), 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', origin: target.url });

async function ownerPost<T>(target: ParityTarget, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${target.url}${path}`, { method: 'POST', headers: ownerJson(target), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

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
