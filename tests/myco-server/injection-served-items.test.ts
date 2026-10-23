import { describe, expect, it } from 'bun:test';
import { BACKUP_FORMAT, BACKUP_TABLES, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { receiptPlans } from '@myco-server-worker/read/injection-served-items.js';
import { sqliteEnv } from './helpers/fixtures.js';

const scope = { projectId: 'proj_1' };
const request = [{ receiptId: 'receipt', planIds: ['saved', 'legacy', 'missing', 'unavailable'] }];

function rig() {
  const fixture = sqliteEnv();
  fixture.sqlite.exec(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES ('proj_1', 'receiver', 'machine', 'token', 1, 1), ('proj_1', 'source', 'machine', 'token', 1, 1);
    INSERT INTO spore_injections (project_id, session_id, id, prompt_id, prompt_hash, spore_ids, plan_ids, created_at)
      VALUES ('proj_1', 'receiver', 'receipt', 'hint', 'hash', '[]', '["saved","legacy","missing","unavailable"]', 1);
    INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'legacy', 'source', 'event', 'machine', 'Live title', 'body', 'live-hash', 'active', 1, 1, 'token', 1),
        ('proj_1', 'unavailable', 'source', 'event2', 'machine', 'Must not replace snapshot', 'body', 'other-hash', 'active', 1, 1, 'token', 1);
    INSERT INTO injection_served_items (project_id, receipt_id, kind, item_id, title, session_id, content_hash, unavailable)
      VALUES ('proj_1', 'receipt', 'plan', 'saved', 'Served title', 'source', 'served-hash', 0),
        ('proj_1', 'receipt', 'plan', 'unavailable', NULL, NULL, NULL, 1)`);
  return fixture;
}

describe('receipt plan snapshots', () => {
  it('keeps receipt order and metadata, uses exact legacy keys, and does not replace unavailable snapshots', async () => {
    const fixture = rig();
    try {
      expect(fixture.sqlite.query('SELECT plan_key FROM plans ORDER BY plan_key').all()).toEqual([{ plan_key: 'legacy' }, { plan_key: 'unavailable' }]);
      expect((await receiptPlans(fixture.db, scope, request)).get('receipt')).toEqual([
        { planKey: 'saved', title: 'Served title', sessionId: 'source', contentHash: 'served-hash', unavailable: false },
        { planKey: 'legacy', title: 'Live title', sessionId: 'source', contentHash: 'live-hash', unavailable: false },
        { planKey: 'unavailable', title: null, sessionId: null, contentHash: null, unavailable: true },
      ]);
      expect((await receiptPlans(fixture.db, { projectId: 'proj_2' }, request)).get('receipt')).toEqual([]);
      expect(await receiptPlans(fixture.db, scope, [])).toEqual(new Map());
    } finally { fixture.sqlite.close(); }
  });

  it('restores snapshots after their receipts, redacts source tombstones, and removes them with the receiving session', async () => {
    const source = rig();
    const target = sqliteEnv();
    try {
      const tables = ['sessions', 'spore_injections', 'injection_served_items'] as const;
      expect(BACKUP_TABLES.indexOf('injection_served_items')).toBeGreaterThan(BACKUP_TABLES.indexOf('spore_injections'));
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(target.db), schemaVersion: 97,
        createdAt: 2, producer: 'test', counts: Object.fromEntries(tables.map(table => [table, source.sqlite.query(`SELECT * FROM ${table}`).all().length])) };
      const artifact = [header, ...tables.flatMap(table => source.sqlite.query(`SELECT * FROM ${table}`).all().map(row => ({ t: table, r: row })))];
      await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact.map(row => JSON.stringify(row)).join('\n') + '\n' });
      const before = (await receiptPlans(target.db, scope, request)).get('receipt')![0];
      expect(before).toMatchObject({ title: 'Served title', sessionId: 'source', contentHash: 'served-hash', unavailable: false });
      await tombstoneSession({ db: target.db }, scope, 'source', 'test', 3);
      expect((await receiptPlans(target.db, scope, request)).get('receipt')![0]).toEqual({
        planKey: before!.planKey, title: null, sessionId: null, contentHash: null, unavailable: true,
      });
      expect(target.sqlite.query('SELECT plan_ids FROM spore_injections').get()).toEqual({ plan_ids: '["saved","legacy","missing","unavailable"]' });
      expect(target.sqlite.query('SELECT count(*) AS n FROM injection_served_items').get()).toEqual({ n: 2 });
      await tombstoneSession({ db: target.db }, scope, 'receiver', 'test', 4);
      expect(target.sqlite.query('SELECT * FROM injection_served_items').all()).toEqual([]);
    } finally { source.sqlite.close(); target.sqlite.close(); }
  });

  it('redacts source snapshots in the tombstone batch and leaves another Project untouched', async () => {
    const fixture = rig();
    try {
      fixture.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES ('proj_2', 'receiver', 'machine', 'token', 1, 1), ('proj_2', 'source', 'machine', 'token', 1, 1)`);
      fixture.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, id, prompt_id, prompt_hash, spore_ids, plan_ids, created_at)
        VALUES ('proj_2', 'receiver', 'other-receipt', 'hint', 'hash', '[]', '["saved"]', 1)`);
      fixture.sqlite.run(`INSERT INTO injection_served_items (project_id, receipt_id, kind, item_id, title, session_id, content_hash, unavailable)
        VALUES ('proj_2', 'other-receipt', 'plan', 'saved', 'Other Project title', 'source', 'other-hash', 0)`);
      fixture.sqlite.exec(`CREATE TRIGGER refuse_snapshot_redaction BEFORE UPDATE ON injection_served_items
        WHEN NEW.project_id = 'proj_1' AND NEW.unavailable = 1 BEGIN SELECT RAISE(ABORT, 'redaction failed'); END`);
      try {
        await expect(tombstoneSession({ db: fixture.db }, scope, 'source', 'test', 3)).rejects.toThrow('redaction failed');
        expect(fixture.sqlite.query('SELECT * FROM session_tombstones').all()).toEqual([]);
        expect(fixture.sqlite.query("SELECT count(*) AS n FROM plans WHERE project_id = 'proj_1'").get()).toEqual({ n: 2 });
        expect((await receiptPlans(fixture.db, scope, request)).get('receipt')![0]).toMatchObject({
          title: 'Served title', sessionId: 'source', contentHash: 'served-hash', unavailable: false,
        });
      } finally { fixture.sqlite.exec('DROP TRIGGER refuse_snapshot_redaction'); }
      await tombstoneSession({ db: fixture.db }, scope, 'source', 'test', 4);
      expect((await receiptPlans(fixture.db, scope, request)).get('receipt')![0]).toMatchObject({
        title: null, sessionId: null, contentHash: null, unavailable: true,
      });
      expect(fixture.sqlite.query("SELECT title, session_id, content_hash, unavailable FROM injection_served_items WHERE project_id = 'proj_2'").get())
        .toEqual({ title: 'Other Project title', session_id: 'source', content_hash: 'other-hash', unavailable: 0 });
    } finally { fixture.sqlite.close(); }
  });
});
