import { describe, expect, it } from 'bun:test';
import { BackupApplyError, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteEnv } from './helpers/fixtures.js';

async function reportArtifact(count = 60) {
  const source = sqliteEnv();
  try {
    source.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_restore', 'a', 'built-in', 1, 1)`);
    source.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
      VALUES ('proj_1', 'run_restore', 'agent_restore', 'completed', 1)`);
    const insert = source.sqlite.prepare(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at)
      VALUES ('proj_1', 'run_restore', 'agent_restore', 'note', ?, 1)`);
    for (let i = 0; i < count; i++) insert.run(`report ${i}`);
    const backup = await createBackup(source.db, source.bucket, { producer: 'fixture', now: 1 });
    return new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
  } finally { source.sqlite.close(); }
}

const reports = (fixture: ReturnType<typeof sqliteEnv>) => fixture.sqlite
  .query<{ id: number; summary: string }, []>('SELECT id, summary FROM agent_reports ORDER BY id').all();

describe('insertion-ordered restore continuation', () => {
  it('resumes after a failed chunk, committing its rows and cursor atomically', async () => {
    const text = await reportArtifact();
    const target = sqliteEnv();
    try {
      const interrupted: RelationalStore = { ...target.db, batch: async (statements) => {
        if (reports(target).length === 20) {
          return target.db.batch([...statements, target.db.prepare('SELECT * FROM missing_restore_fixture')]);
        }
        return target.db.batch(statements);
      } };
      await expect(restoreArtifact(interrupted, { text, allowForeignLineage: true })).rejects.toThrow(BackupApplyError);
      expect(reports(target)).toHaveLength(20);
      expect(target.sqlite.query(`SELECT next_row FROM backup_restore_progress WHERE table_name = 'agent_reports'`).get()).toEqual({ next_row: 20 });

      const result = await restoreArtifact(target.db, { text, allowForeignLineage: true });
      expect(result.tables.agent_reports).toEqual({ rows: 60, inserted: 40 });
      expect(reports(target)).toEqual(Array.from({ length: 60 }, (_, i) => ({ id: i + 1, summary: `report ${i}` })));
      const repeated = await restoreArtifact(target.db, { text, allowForeignLineage: true });
      expect(repeated.tables.agent_reports).toEqual({ rows: 60, inserted: 0 });
    } finally { target.sqlite.close(); }
  });

  it('refuses another artifact and preserves unrelated occupied history', async () => {
    const text = await reportArtifact();
    const target = sqliteEnv();
    try {
      const interrupted: RelationalStore = { ...target.db, batch: async (statements) => {
        if (reports(target).length === 20) throw new Error('storage unavailable');
        return target.db.batch(statements);
      } };
      await expect(restoreArtifact(interrupted, { text, allowForeignLineage: true })).rejects.toThrow('storage unavailable');
      const before = reports(target);
      const different = text.replace('report 21', 'another artifact');
      const refused = await restoreArtifact(target.db, { text: different, allowForeignLineage: true });
      expect(refused.tables.agent_reports.skipped).toContain('insertion-ordered');
      expect(reports(target)).toEqual(before);

      target.sqlite.run('DELETE FROM backup_restore_progress');
      const unowned = await restoreArtifact(target.db, { text, allowForeignLineage: true });
      expect(unowned.tables.agent_reports.skipped).toContain('insertion-ordered');
      expect(reports(target)).toEqual(before);
    } finally { target.sqlite.close(); }
  });

  it('rolls back a chunk that collides with a concurrent history writer', async () => {
    const text = await reportArtifact();
    const target = sqliteEnv();
    try {
      let insertedConflict = false;
      const concurrent: RelationalStore = { ...target.db, batch: async (statements) => {
        if (!insertedConflict && reports(target).length === 20) {
          insertedConflict = true;
          target.sqlite.run(`INSERT INTO agent_reports (id, project_id, run_id, agent_id, action, summary, created_at)
            VALUES (25, 'proj_1', 'run_restore', 'agent_restore', 'note', 'unrelated history', 1)`);
        }
        return target.db.batch(statements);
      } };
      await expect(restoreArtifact(concurrent, { text, allowForeignLineage: true })).rejects.toThrow('backup_restore_rows_match');
      expect(reports(target)).toHaveLength(21);
      expect(reports(target).at(-1)).toEqual({ id: 25, summary: 'unrelated history' });
      expect(target.sqlite.query(`SELECT next_row FROM backup_restore_progress WHERE table_name = 'agent_reports'`).get()).toEqual({ next_row: 20 });
    } finally { target.sqlite.close(); }
  });

  it('allows concurrent callers of the same artifact without duplicate rows or cursor regression', async () => {
    const text = await reportArtifact();
    const target = sqliteEnv();
    try {
      const results = await Promise.all([
        restoreArtifact(target.db, { text, allowForeignLineage: true }),
        restoreArtifact(target.db, { text, allowForeignLineage: true }),
      ]);
      expect(results.reduce((sum, result) => sum + result.tables.agent_reports.inserted, 0)).toBe(60);
      expect(reports(target)).toHaveLength(60);
      expect(target.sqlite.query(`SELECT next_row FROM backup_restore_progress WHERE table_name = 'agent_reports'`).get()).toEqual({ next_row: 60 });
    } finally { target.sqlite.close(); }
  });

  it('refuses changed committed history and can restore the artifact again into an empty table', async () => {
    const text = await reportArtifact();
    const target = sqliteEnv();
    try {
      await restoreArtifact(target.db, { text, allowForeignLineage: true });
      target.sqlite.run('DELETE FROM agent_reports WHERE id = 1');
      await expect(restoreArtifact(target.db, { text, allowForeignLineage: true })).rejects.toThrow('previously restored rows changed');
      expect(reports(target)).toHaveLength(59);
      target.sqlite.run('DELETE FROM agent_reports');
      const recovered = await restoreArtifact(target.db, { text, allowForeignLineage: true });
      expect(recovered.tables.agent_reports).toEqual({ rows: 60, inserted: 60 });
      expect(reports(target)).toHaveLength(60);
    } finally { target.sqlite.close(); }
  });
});
