/** A restore keeps its backup from retention until every step of it has finished, a refused document step included. */
import { expect, it } from 'bun:test';
import { createBackup, restoreBackup, type RestoreDocuments } from '@myco-server-worker/core/backup.js';
import { pruneBackups } from '@myco-server-worker/core/backup-retention.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { PublicationRestoreBuilding } from '@myco-server-worker/db/documents/readiness.js';
import { sqliteEnv } from './helpers/fixtures.js';

const DAY = 86_400_000;
const NOW = 1000 * 7 * DAY + 5 * DAY + DAY / 2;

it('a restore refused at its documents keeps its backup until the retry completes', async () => {
  const e = sqliteEnv();
  try {
    for (const [leaf, value] of [['backup.retention.keep_daily', 1], ['backup.retention.keep_weekly', 0]] as const) {
      e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(?,?,1,'m') ON CONFLICT(leaf) DO UPDATE SET value=excluded.value`, [leaf, JSON.stringify(value)]);
    }
    e.sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)");
    e.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','s1','m','t',1,1)");
    const restored = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - 2 * DAY });
    await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
    let refuse = true;
    const documents: RestoreDocuments = { plan: async () => ({ summary: { convert: 1, merge: 0 }, apply: async () => {
      if (refuse) throw new PublicationRestoreBuilding('ownership');
    } }) };
    const restore = () => restoreBackup(e.db, e.bucket, { id: restored.id, authorization: { kind: 'recovery' }, documents });
    const held = async () => {
      while ((await catchUpProjections(e.db)).more) { /* retention decides from built week heads */ }
      await pruneBackups(e.db, NOW);
      return (e.sqlite.query('SELECT id FROM backups WHERE id=?').all(restored.id)).length === 1;
    };

    await expect(restore()).rejects.toBeInstanceOf(PublicationRestoreBuilding);
    expect(await held()).toBe(true);
    refuse = false;
    expect(await restore()).not.toBeNull();
    expect(await held()).toBe(false);
  } finally { e.sqlite.close(); }
}, 120_000);
