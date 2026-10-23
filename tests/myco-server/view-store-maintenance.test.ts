import { expect, it } from 'bun:test';
import { BLOB_REFERENCES, unreferencedAmong } from '@myco-server-worker/core/blob-references.js';
import { BACKUP_TABLES, EXCLUDED_TABLES, backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { DERIVED_TABLES, tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { acquireRecoveryHold } from '@myco-server-worker/core/object-release.js';
import { captureViewSession, withViewStores } from './helpers/view-stores.js';
import { clearViewInstances, INSTANCE_STATES, seedViewInstance, seedViewState } from './helpers/view-instances.js';
import { memoryBlobStore } from './helpers/fixtures.js';

const PROJECT = 'project';
const SESSION = 'session';
const scope = { projectId: PROJECT };

it('every view blob column holds staged and retired bytes on native and D1', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'view_%' AND name NOT LIKE '%_fts%'").all<{ name: string }>()).results;
    for (const { name } of tables) for (const column of (await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>()).results) {
      if (!column.name.endsWith('blob_key')) continue;
      expect(BLOB_REFERENCES).toContainEqual(expect.objectContaining({ table: name, column: column.name }));
    }
    for (const state of INSTANCE_STATES) {
      const keys = await seedViewInstance(db, { projectId: PROJECT, sessionId: SESSION, instanceId: state, state });
      expect(await unreferencedAmong(db, keys.map(key => ({ projectId: PROJECT, key })))).toEqual([]);
      expect(await unreferencedAmong(db, keys.map(key => ({ projectId: 'other', key })))).toHaveLength(keys.length);
    }
  });
}, 60_000);

it('tombstones every instance and journals its blob candidates atomically on native and D1', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    await captureViewSession(db, 'other');
    const keys: string[] = [];
    for (const state of INSTANCE_STATES) keys.push(...await seedViewInstance(db, { projectId: PROJECT, sessionId: SESSION, instanceId: state, state }));
    keys.push(...await seedViewInstance(db, { projectId: PROJECT, sessionId: SESSION, instanceId: 'tail', state: 'live', parent: 'frozen' }));
    await seedViewState(db, PROJECT, SESSION, 'tail', 'frozen');
    await seedViewInstance(db, { projectId: 'other', sessionId: SESSION, instanceId: 'live', state: 'live' });
    const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'view_%' OR name IN ('session_views','fact_classes','plan_promotions')) AND name NOT LIKE '%_fts%'")
      .all<{ name: string }>()).results.map(row => row.name);
    for (const table of tables) expect(DERIVED_TABLES as readonly string[]).toContain(table);
    let batches = 0;
    const rollback = { ...db, batch: (statements: Parameters<typeof db.batch>[0]) => db.batch(++batches === 2
      ? [...statements, db.prepare("SELECT json_extract('invalid','$')")] : statements) };
    await expect(tombstoneSession({ db: rollback }, scope, SESSION, 'owner', 10)).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session_tombstones').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM blob_release_candidates').first()).toEqual({ n: 0 });
    for (const table of tables) expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).bind(PROJECT).first<{ n: number }>())!.n).toBeGreaterThan(0);
    await acquireRecoveryHold(db, 'view-test', 10);
    const outcome = await tombstoneSession({ db }, scope, SESSION, 'owner', 11);
    expect(outcome.applied).toBe(true);
    expect(outcome.blobsLeft).toBe(keys.length);
    for (const table of tables) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).bind(PROJECT).first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM blob_release_candidates WHERE project_id=?').bind(PROJECT).first()).toEqual({ n: keys.length });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM view_instances WHERE project_id='other'").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM view_prompts_fts WHERE view_prompts_fts MATCH 'viewcanary'").first()).toEqual({ n: 1 });
    expect(await tombstoneSession({ db }, scope, SESSION, 'owner', 12)).toMatchObject({ applied: true, removed: 0 });
    expect(await db.prepare('PRAGMA foreign_key_check').first()).toBeNull();
  });
}, 60_000);

it('backup and restore carry durable metadata and exclude all regenerable instance storage on native and D1', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    await seedViewInstance(db, { projectId: PROJECT, sessionId: SESSION, instanceId: 'live', state: 'live' });
    await seedViewState(db, PROJECT, SESSION, 'live');
    const newTables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'view_%' OR name IN ('session_views','fact_classes','plan_promotions'))")
      .all<{ name: string }>()).results.map(row => row.name);
    for (const table of newTables) {
      const durable = ['fact_classes', 'plan_promotions'].includes(table);
      expect(BACKUP_TABLES.includes(table)).toBe(durable);
      expect(EXCLUDED_TABLES.has(table)).toBe(!durable);
    }
    const blobs = memoryBlobStore();
    const backup = await createBackup(db, blobs, { producer: 'test', now: 10 });
    const artifact = (await backupArtifact(db, blobs, backup.id))!;
    const rows = artifact.text.trim().split('\n').slice(1).map(line => JSON.parse(line) as { t: string; r: Record<string, unknown> });
    expect(rows.filter(row => newTables.includes(row.t)).map(row => row.t).sort()).toEqual(['fact_classes', 'plan_promotions']);
    const readMetadata = () => Promise.all(['fact_classes', 'plan_promotions'].map(table => db.prepare(`SELECT * FROM ${table}`).all().then(result => result.results)));
    const metadata = await readMetadata();
    await clearViewInstances(db, PROJECT, SESSION);
    const excluded = newTables.filter(table => !['fact_classes', 'plan_promotions'].includes(table));
    const empty = await Promise.all(excluded.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()));
    await restoreArtifact(db, { text: artifact.text, authorization: { kind: 'recovery' } });
    expect(await readMetadata()).toEqual(metadata);
    expect(await Promise.all(excluded.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()))).toEqual(empty);
    for (const table of excluded.filter(table => !table.includes('_fts_'))) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    expect(await db.prepare('PRAGMA foreign_key_check').first()).toBeNull();
  });
}, 60_000);
