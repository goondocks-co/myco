/**
 * The backup engine: table dispositions drift-guarded against the DDL, the
 * round trip, the refusal gates, and the retention rule.
 */
import { describe, expect, it } from 'bun:test';
import {
  BACKUP_TABLES, BackupLineageError, BackupSchemaError, createBackup, deploymentId,
  EMPTY_ONLY_TABLES, EXCLUDED_TABLES, listBackups, previewRestore, pruneBackups,
  restoreBackup, retentionVictims, setBackupPinned, type BackupIndexRow,
} from '@myco-server-worker/core/backup.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { sqliteVectorStore } from '@myco-server-worker/platform/bun/vectors.js';

const seeded = () => {
  const fixture = sqliteEnv();
  const now = Date.now();
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_bk', 'proj_bk', ?)`).run(now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_bk', 'sess_1', 'm1', 'mt_seed', ?, ?)`).run(now, now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_bk', 'a', 'built-in', 1, ?)`).run(now);
  return { ...fixture, now };
};

describe('table dispositions', () => {
  it('GATE: every DDL table is named in exactly one disposition', async () => {
    const ddlTables = new Set<string>();
    for (const s of SCHEMA_DDL) {
      const m = /CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?(\w+)/.exec(s);
      if (m) ddlTables.add(m[1]!);
    }
    const fixture = sqliteEnv();
    await sqliteVectorStore(fixture.sqlite).query({ projectId: 'proj_1', modelKey: 'fixture' }, { values: [1], topK: 1 });
    for (const row of fixture.sqlite.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) ddlTables.add(row.name);
    fixture.sqlite.close();
    const named = new Set<string>([...BACKUP_TABLES, ...EXCLUDED_TABLES]);
    expect([...ddlTables].filter((t) => !named.has(t)).sort()).toEqual([]);
    expect([...named].filter((t) => !ddlTables.has(t)).sort()).toEqual([]);
    expect(BACKUP_TABLES.filter((t) => EXCLUDED_TABLES.has(t))).toEqual([]);
    for (const t of EMPTY_ONLY_TABLES) expect(BACKUP_TABLES).toContain(t);
  });
});

describe('artifact keys', () => {
  it('keys every artifact by its own id, so same-instant creates never share an object', async () => {
    const { db, bucket, now } = seeded();
    const first = await createBackup(db, bucket, { producer: 'test', now });
    const second = await createBackup(db, bucket, { producer: 'test', now });
    expect(first.key === second.key).toBe(false);
    expect(bucket.objects.has(first.key) && bucket.objects.has(second.key)).toBe(true);
  });
});

describe('create, list, preview', () => {
  it('writes the artifact and its index row, lists it verified, and previews from the header without executing', async () => {
    const { db, bucket, now } = seeded();
    const row = await createBackup(db, bucket, { producer: 'test', now });
    expect(row.key.startsWith('backups/')).toBe(true);
    const counts = JSON.parse(row.counts_json) as Record<string, number>;
    expect(counts.projects).toBeGreaterThanOrEqual(1);
    expect(counts.sessions).toBe(1);

    const listed = await listBackups(db, bucket);
    expect(listed.map((l) => ({ id: l.id, present: l.present }))).toEqual([{ id: row.id, present: true }]);

    const preview = await previewRestore(db, bucket, row.id);
    expect({ foreign: preview!.foreignLineage, sessions: preview!.header.counts.sessions }).toEqual({ foreign: false, sessions: 1 });

    bucket.objects.delete(row.key);
    const gone = await listBackups(db, bucket);
    expect(gone[0]!.present).toBe(false);
  });
});

describe('restore', () => {
  it('round-trips into a foreign store under explicit adoption, is additive with the target winning, and a re-run converges', async () => {
    const source = seeded();
    const backup = await createBackup(source.db, source.bucket, { producer: 'test', now: source.now });
    const artifact = source.bucket.objects.get(backup.key)!;

    const target = sqliteEnv();
    target.bucket.objects.set(backup.key, artifact);
    target.sqlite.query(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned)
        VALUES (?, ?, ?, ?, ?, ?, 'copied', 0)`)
      .run(backup.id, backup.key, backup.created_at, backup.size_bytes, backup.counts_json, backup.schema_version);

    await expect(restoreBackup(target.db, target.bucket, { id: backup.id })).rejects.toThrow(BackupLineageError);

    // The target's own row under the same key stays as it is: additive, target wins.
    target.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_bk', 'THEIRS', 1)`).run();
    const outcome = await restoreBackup(target.db, target.bucket, { id: backup.id, allowForeignLineage: true });
    expect(outcome!.tables.sessions).toEqual({ rows: 1, inserted: 1 });
    expect(outcome!.tables.projects!.inserted).toBeLessThan(outcome!.tables.projects!.rows);
    const kept = target.sqlite.query(`SELECT name FROM projects WHERE project_id = 'proj_bk'`).get() as { name: string };
    expect(kept.name).toBe('THEIRS');
    expect((await deploymentId(target.db)) === (await deploymentId(source.db))).toBe(false);

    const again = await restoreBackup(target.db, target.bucket, { id: backup.id, allowForeignLineage: true });
    expect(Object.values(again!.tables).every((t) => t.inserted === 0)).toBe(true);
  });

  it('refuses a dump from a newer schema, and skips an insertion-ordered table that already holds rows, by name', async () => {
    const source = seeded();
    source.sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at) VALUES ('proj_bk', 'run_bk', 'agent_bk', 'completed', ?)`).run(source.now);
    source.sqlite.query(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_bk', 'run_bk', 'agent_bk', 'note', 's', ?)`).run(source.now);
    const backup = await createBackup(source.db, source.bucket, { producer: 'test', now: source.now });

    const artifactText = new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
    const lines = artifactText.split('\n');
    const header = JSON.parse(lines[0]!) as { schemaVersion: number };
    header.schemaVersion = header.schemaVersion + 1;
    const doctored = [JSON.stringify(header), ...lines.slice(1)].join('\n');
    const doctoredKey = 'backups/doctored.jsonl';
    source.bucket.objects.set(doctoredKey, { ...source.bucket.objects.get(backup.key)!, bytes: new TextEncoder().encode(doctored) });
    source.sqlite.query(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned)
        VALUES ('bk_doctored', ?, 1, 1, '{}', 999, 'test', 0)`).run(doctoredKey);
    await expect(restoreBackup(source.db, source.bucket, { id: 'bk_doctored' })).rejects.toThrow(BackupSchemaError);

    // agent_reports already holds a row, so its restore is a named skip, never a silent drop.
    const outcome = await restoreBackup(source.db, source.bucket, { id: backup.id });
    expect(outcome!.tables.agent_reports!.skipped).toContain('insertion-ordered');
    expect(outcome!.tables.agent_reports!.inserted).toBe(0);
  });
});

describe('retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // A PINNED clock: epoch weeks roll at a fixed weekday, so a wall-clock "now"
  // makes the bucket layout depend on the day the suite runs.
  const NOW = 1000 * 7 * DAY + 5 * DAY + DAY / 2;
  const row = (id: string, ageDays: number, pinned = 0): BackupIndexRow => ({
    id, key: `backups/${id}.jsonl`, created_at: NOW - ageDays * DAY, size_bytes: 1,
    counts_json: '{}', schema_version: 13, producer: 'test', pinned,
  });

  it('keeps the newest keepDaily, one per week for keepWeekly weeks, and pinned rows exempt without consuming a slot', () => {
    const rows = [row('a', 0), row('b', 1), row('c', 2), row('p', 3, 1), row('d', 9), row('e', 16), row('f', 30), row('g', 31)];
    const victims = retentionVictims(rows, 2, 3).map((v) => v.id).sort();
    // a,b kept daily; weeks of a/b, d, e kept weekly (newest each); pinned p never a victim.
    expect(victims).toEqual(['c', 'f', 'g']);
    expect(retentionVictims(rows, 0, 0).map((v) => v.id)).not.toContain('p');
  });

  it('prunes object-first through the store and FAILS CLOSED when the store errors', async () => {
    const { db, bucket, now } = seeded();
    const old = await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    const fresh = await createBackup(db, bucket, { producer: 'test', now });
    const pruned = await pruneBackups(db, bucket, { keepDaily: 1, keepWeekly: 1 });
    expect({ pruned: pruned.pruned, deleted: bucket.deletes }).toEqual({ pruned: 1, deleted: [old.key] });
    expect((await listBackups(db, bucket)).map((l) => l.id)).toEqual([fresh.id]);

    await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    const failing = { ...bucket, delete: async () => { throw new Error('store outage'); } };
    const held = await pruneBackups(db, failing, { keepDaily: 1, keepWeekly: 1 });
    expect({ pruned: held.pruned, rows: (await listBackups(db, bucket)).length }).toEqual({ pruned: 0, rows: 2 });
  });

  it('pin exempts a row from retention until unpinned', async () => {
    const { db, bucket, now } = seeded();
    const old = await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    await createBackup(db, bucket, { producer: 'test', now });
    expect(await setBackupPinned(db, old.id, true)).toBe(true);
    expect((await pruneBackups(db, bucket, { keepDaily: 1, keepWeekly: 1 })).pruned).toBe(0);
    expect(await setBackupPinned(db, old.id, false)).toBe(true);
    expect((await pruneBackups(db, bucket, { keepDaily: 1, keepWeekly: 1 })).pruned).toBe(1);
  });
});

describe('apply refusals', () => {
  it('names the table when an artifact row cannot be applied, and refuses a column name outside the grammar', async () => {
    const { db, bucket, now } = seeded();
    const header = JSON.stringify({ format: 'myco-backup/1', deploymentId: await deploymentId(db), schemaVersion: 13, createdAt: now, producer: 'test', counts: {} });
    const orphanReport = JSON.stringify({ t: 'agent_reports', r: { project_id: 'proj_bk', run_id: 'run_ghost', agent_id: 'agent_bk', action: 'a', summary: 's', created_at: now } });
    const { restoreArtifact, BackupApplyError } = await import('@myco-server-worker/core/backup.js');
    await expect(restoreArtifact(db, { text: `${header}\n${orphanReport}\n` })).rejects.toThrow(BackupApplyError);
    await expect(restoreArtifact(db, { text: `${header}\n${orphanReport}\n` })).rejects.toThrow(/agent_reports/);

    const crafted = JSON.stringify({ t: 'projects', r: { 'project_id, name) VALUES (1,2); --': 'x' } });
    await expect(restoreArtifact(db, { text: `${header}\n${crafted}\n` })).rejects.toThrow(/column name outside the store grammar/);
  });
});
