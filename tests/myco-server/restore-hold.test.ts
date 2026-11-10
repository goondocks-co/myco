/** A restore keeps its backup from retention until every step of it has finished, a refused document step included. */
import { expect, it } from 'bun:test';
import { createBackup, type RestoreDocuments } from '@myco-server-worker/core/backup.js';
import { pruneBackups } from '@myco-server-worker/core/backup-retention.js';
import { acceptRestore, advanceRestore, restoreJobProgress } from '@myco-server-worker/core/restore-job.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { PublicationRestoreBuilding } from '@myco-server-worker/db/documents/readiness.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { sqliteEnv } from './helpers/fixtures.js';

const DAY = 86_400_000;
const NOW = 1000 * 7 * DAY + 5 * DAY + DAY / 2;
const OWNER = 'mem_machine_1';

it('a restore refused at its documents keeps its backup until the retry completes', async () => {
  const e = sqliteEnv();
  try {
    for (const [leaf, value] of [['backup.retention.keep_daily', 1], ['backup.retention.keep_weekly', 0]] as const) {
      e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(?,?,1,'m') ON CONFLICT(leaf) DO UPDATE SET value=excluded.value`, [leaf, JSON.stringify(value)]);
    }
    await bootstrapOwnership(e.db, OWNER, OWNER, '0', NOW);
    e.sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)");
    e.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','s1','m','t',1,1)");
    const restored = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - 2 * DAY });
    await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
    let refuse = true;
    const documents: RestoreDocuments = {
      sessions: () => ['["proj_1","s1"]'],
      plan: async () => ({ summary: { convert: 1, merge: 0 }, decisions: [['["proj_1","s1"]', 'convert']] }),
      apply: async () => {
        if (refuse) throw new PublicationRestoreBuilding('ownership');
        return { sessions: 1, last: null };
      },
    };
    const held = async () => {
      while ((await catchUpProjections(e.db)).more) { /* retention decides from built week heads */ }
      await pruneBackups(e.db, NOW);
      return (e.sqlite.query('SELECT id FROM backups WHERE id=?').all(restored.id)).length === 1;
    };

    const accepted = (await acceptRestore(e.serverEnv, restored.id, { allowForeignLineage: false, memberId: OWNER, now: NOW, documents }))!;
    for (let pass = 0; pass < 20 && (await restoreJobProgress(e.serverEnv, accepted.id))?.retrying === null; pass++) await advanceRestore(e.serverEnv, NOW, undefined, documents);
    expect(await restoreJobProgress(e.serverEnv, accepted.id)).toMatchObject({ state: 'running', retrying: { errorClass: 'publication_restore_building' } });
    expect(await held()).toBe(true);
    refuse = false;
    for (let pass = 0; pass < 20 && (await restoreJobProgress(e.serverEnv, accepted.id))?.state === 'running'; pass++) await advanceRestore(e.serverEnv, NOW, undefined, documents);
    expect((await restoreJobProgress(e.serverEnv, accepted.id))?.state).toBe('complete');
    expect(await held()).toBe(false);
  } finally { e.sqlite.close(); }
}, 120_000);
