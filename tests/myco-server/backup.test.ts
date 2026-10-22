/**
 * The backup engine: table dispositions drift-guarded against the DDL, the
 * round trip, the refusal gates, and the retention rule.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  BACKUP_FORMAT, BACKUP_TABLES, backupArtifact, BackupAdmissionError, BackupIntegrityError, BackupLineageError, BackupSchemaError, BackupTooLargeError, MAX_BACKUP_BYTES, createBackup, deploymentId,
  EMPTY_ONLY_TABLES, EXCLUDED_TABLES, RETIRED_TABLES, listBackups, previewRestore, pruneBackups,
  restoreBackup, restoreArtifact, retentionVictims, setBackupPinned, type BackupIndexRow,
} from '@myco-server-worker/core/backup.js';
import { SCHEMA_DDL, SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { renderMigrationFile } from '@myco-server-worker/db/migrate.js';
import { journaled, sqliteEnv } from './helpers/fixtures.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { sqliteVectorStore } from '@myco-server-worker/platform/bun/vectors.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';

const seeded = () => {
  const fixture = sqliteEnv();
  const now = Date.now();
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_bk', 'proj_bk', ?)`).run(now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_bk', 'sess_1', 'm1', 'mt_seed', ?, ?)`).run(now, now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_bk', 'a', 'built-in', 1, ?)`).run(now);
  return { ...fixture, now };
};

describe('table dispositions', () => {
  it('GATE: every current schema table is named in exactly one disposition', async () => {
    const ddlTables = new Set<string>();
    const fixture = sqliteEnv();
    await sqliteVectorStore(fixture.sqlite).query({ projectId: 'proj_1', modelKey: 'fixture' }, { values: [1], topK: 1 });
    for (const row of fixture.sqlite.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) ddlTables.add(row.name);
    fixture.sqlite.close();
    const dispositions = [...BACKUP_TABLES, ...EXCLUDED_TABLES, ...RETIRED_TABLES.keys()];
    const named = new Set<string>(dispositions);
    expect(dispositions.length).toBe(named.size);
    const droppedHistorically = new Set(SCHEMA_DDL.flatMap((statement) => {
      const name = /^DROP TABLE (?:IF EXISTS )?(\w+)/.exec(statement)?.[1];
      return name === undefined ? [] : [name];
    }));
    expect([...ddlTables].filter((t) => !named.has(t)).sort()).toEqual([]);
    expect([...named].filter((t) => !ddlTables.has(t) && !droppedHistorically.has(t)).sort()).toEqual([]);
    expect(BACKUP_TABLES.filter((t) => EXCLUDED_TABLES.has(t))).toEqual([]);
    for (const [table, version] of RETIRED_TABLES) {
      expect(ddlTables.has(table)).toBe(false);
      expect(SCHEMA_STEPS.find(step => step.version === version)?.statements)
        .toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const t of EMPTY_ONLY_TABLES) expect(BACKUP_TABLES).toContain(t);
  });
});

describe('served material lifecycle', () => {
  it('restores served rows after their run, removes a tombstoned session, and cascades run deletion', async () => {
    const source = seeded();
    const target = seeded();
    try {
      source.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
        VALUES ('proj_bk', 'run_served', 'agent_bk', 'completed', ?)`, [source.now]);
      source.sqlite.run(`INSERT INTO run_served_material
        (project_id, served_id, run_id, session_id, instance_id, record_id, source_transcript_id, source_offset, source_end, served_at)
        VALUES ('proj_bk', 'served_1', 'run_served', 'sess_1', NULL, 'record_1', NULL, NULL, NULL, ?)`, [source.now]);

      expect(BACKUP_TABLES.indexOf('run_served_material')).toBe(BACKUP_TABLES.indexOf('agent_runs') + 1);
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(target.db),
        schemaVersion: Number((target.sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string }).value),
        createdAt: source.now, producer: 'test', counts: { agent_runs: 1, run_served_material: 1 } };
      const artifact = [header, ...(['agent_runs', 'run_served_material'] as const).map((table) => ({
        t: table, r: source.sqlite.query(`SELECT * FROM ${table}`).get(),
      }))].map((row) => JSON.stringify(row)).join('\n') + '\n';
      await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact });
      const rows = () => target.sqlite.query(`SELECT served_id FROM run_served_material WHERE project_id = 'proj_bk'`).all();
      expect(rows()).toEqual([{ served_id: 'served_1' }]);

      await tombstoneSession({ db: target.db }, { projectId: 'proj_bk' }, 'sess_1', 'test', source.now + 1);
      expect(rows()).toEqual([]);
      expect(target.sqlite.query(`SELECT id FROM agent_runs WHERE project_id = 'proj_bk'`).all()).toEqual([{ id: 'run_served' }]);

      target.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES ('proj_bk', 'sess_2', 'm1', 'mt_seed', ?, ?)`, [source.now, source.now]);
      target.sqlite.run(`INSERT INTO run_served_material
        (project_id, served_id, run_id, session_id, instance_id, record_id, source_transcript_id, source_offset, source_end, served_at)
        VALUES ('proj_bk', 'served_2', 'run_served', 'sess_2', NULL, 'record_2', NULL, NULL, NULL, ?)`, [source.now]);
      target.sqlite.run(`DELETE FROM agent_runs WHERE project_id = 'proj_bk' AND id = 'run_served'`);
      expect(rows()).toEqual([]);
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });
});

describe('portable machine identities', () => {
  it('refuses unknown artifact tables in rows and header counts before restoring retained rows', async () => {
    const target = sqliteEnv();
    try {
      for (const headerOnly of [false, true]) {
        const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(target.db), schemaVersion: 85,
          createdAt: 1, producer: 'test', counts: { projects: 1, ...(headerOnly ? { proejcts: 1 } : {}) } };
        const rows = [{ t: 'projects', r: { project_id: 'unknown_backup', name: 'kept out', created_at: 1 } },
          ...(headerOnly ? [] : [{ t: 'proejcts', r: {} }])];
        const text = [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n';
        await expect(restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text }))
          .rejects.toThrow('unknown artifact table');
        const key = `backups/unknown-${headerOnly}.jsonl`;
        await target.bucket.put(key, new Response(text).body);
        target.sqlite.run(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned)
          VALUES(?,?,1,?,'{}',85,'test',0)`, [key, key, new TextEncoder().encode(text).byteLength]);
        await expect(previewRestore(target.db, target.bucket, key)).rejects.toThrow('unknown artifact table');
        expect(target.sqlite.query("SELECT project_id FROM projects WHERE project_id='unknown_backup'").all()).toEqual([]);
      }
    } finally { target.sqlite.close(); }
  });

  it('restores retained rows twice from a pre-v86 artifact carrying retired skill and digest rows', async () => {
    const source = new Database(':memory:');
    const target = sqliteEnv();
    try {
      for (const step of SCHEMA_STEPS.filter(({ version }) => version <= 85)) source.exec(renderMigrationFile(step));
      source.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_bk','Project',1);
        INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent_old_backup','Agent','built-in',1,1);
        INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_bk','sess_1','t',1,1);
        INSERT INTO skill_candidates(project_id,id,agent_id,topic,rationale,created_at,updated_at)
          VALUES('proj_bk','c','agent_old_backup','topic','reason',1,1);
        INSERT INTO skill_records(project_id,id,agent_id,name,display_name,description,candidate_id,path,created_at,updated_at)
          VALUES('proj_bk','r','agent_old_backup','name','Name','description','c','skills/name',1,1);
        INSERT INTO skill_lineage(project_id,id,skill_id,generation,action,rationale,content_snapshot,created_at)
          VALUES('proj_bk','l','r',1,'create','reason','content',1);
        INSERT INTO skill_usage(project_id,id,skill_id,session_id,detected_at) VALUES('proj_bk','u','r','sess_1',1);
        INSERT INTO digest_extracts(project_id,id,agent_id,tier,content,generated_at)
          VALUES('proj_bk','d','agent_old_backup',1,'digest',1);
        INSERT INTO digest_extract_revisions(project_id,agent_id,tier,content,created_at)
          VALUES('proj_bk','agent_old_backup',1,'digest',1);
        INSERT INTO cortex_instructions(project_id,id,agent_id,content,input_hash,generated_at)
          VALUES('proj_bk','instructions','agent_old_backup','old instructions','hash',1);`);
      source.exec(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
        VALUES('proj_bk','old_skill_release','old_skill_release','skill_records','r','released','high',1,1),
              ('proj_bk','old_digest_release','old_digest_release','digest_extracts','d','released','high',1,1),
              ('proj_bk','kept_release','kept_release','sessions','sess_1','released','high',1,1);`);
      const retained = ['projects', 'agents', 'sessions', 'knowledge_release_state'];
      const retired = ['skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage', 'digest_extracts', 'digest_extract_revisions', 'cortex_instructions'];
      const tables = [...retained, ...retired];
      const rows = tables.flatMap((table) => source.query(`SELECT * FROM ${table} WHERE ${table === 'agents' ? "id='agent_old_backup'" : "project_id='proj_bk'"}`).all().map((r) => ({ t: table, r })));
      expect(rows).toHaveLength(tables.length + 2);
      const header = {
        format: BACKUP_FORMAT, deploymentId: await deploymentId(target.db), schemaVersion: 85,
        createdAt: 1, producer: 'pre-v86', counts: Object.fromEntries(tables.map((table) => [table, table === 'knowledge_release_state' ? 3 : 1])),
      };
      const oldArtifact = [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
      const expectedSkips = Object.fromEntries(retired.map((table) => [table, { rows: 1, inserted: 0, skipped: 'retired' }]));
      const key = 'backups/pre-v86.jsonl';
      await target.bucket.put(key, new Response(oldArtifact).body);
      target.sqlite.run(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned)
        VALUES('pre-v86',?,1,?,? ,85,'pre-v86',0)`, [key, new TextEncoder().encode(oldArtifact).byteLength, JSON.stringify(header.counts)]);
      expect((await previewRestore(target.db, target.bucket, 'pre-v86'))).toMatchObject({
        tables: { ...expectedSkips, knowledge_release_state: { rows: 2, inserted: 0, skipped: 'retired' } },
        retiredNotice: "This backup includes older data this version no longer keeps (generated skills, digests, old instructions). It won't be restored.",
      });
      for (let repeat = 0; repeat < 2; repeat++) {
        const outcome = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: oldArtifact, allowForeignLineage: true });
        expect(outcome.tables).toMatchObject({
          ...expectedSkips, knowledge_release_state: { rows: 3, inserted: repeat === 0 ? 1 : 0, skipped: 'retired' },
        });
        expect(target.sqlite.query("SELECT namespace FROM knowledge_release_state WHERE project_id='proj_bk'").all()).toEqual([{ namespace: 'sessions' }]);
        expect(target.sqlite.query(`SELECT project_id FROM projects WHERE project_id='proj_bk'`).all()).toEqual([{ project_id: 'proj_bk' }]);
        expect(target.sqlite.query(`SELECT session_id FROM sessions WHERE project_id='proj_bk'`).all()).toEqual([{ session_id: 'sess_1' }]);
        expect(target.sqlite.query(`SELECT id FROM agents WHERE id='agent_old_backup'`).all()).toEqual([{ id: 'agent_old_backup' }]);
      }
    } finally { source.close(); target.sqlite.close(); }
  });

  it('restores prompt answer outcomes, skips and coded contributor failures', async () => {
    const source = seeded();
    const target = seeded();
    try {
      source.sqlite.query(`INSERT INTO prompt_context_answers
        (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
        VALUES ('proj_bk', 'sess_1', 'prompt_1', 'answer_1', 'empty', 0, '[]', '["spores"]', '[{"contributor":"spores","error":"constraint","operation":"record"}]', '{"budgetKept":0}', ?)`).run(source.now);
      const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: source.now });
      const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!;
      await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact.text, allowForeignLineage: true });
      expect(target.sqlite.query('SELECT * FROM prompt_context_answers').all())
        .toEqual(source.sqlite.query('SELECT * FROM prompt_context_answers').all());
    } finally { source.sqlite.close(); target.sqlite.close(); }
  });

  it('exports and restores no cached settings confirmation or sent snapshots', async () => {
    const source = seeded();
    const target = seeded();
    try {
      source.sqlite.query(`INSERT INTO members (id, label, created_at) VALUES ('mem_backup_cache', 'Machine owner', 1)`).run();
      source.sqlite.query(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, settings_cached_revision, settings_cached_values, settings_report_order, settings_contract_supported)
        VALUES ('machine_backup_cache', 'mem_backup_cache', 1, 'm1', '{"capture.plan_dirs":["notes"]}', 5, 1)`).run();
      source.sqlite.query(`INSERT INTO machine_settings_snapshots (machine_id, revision, leaves, sent_order)
        VALUES ('machine_backup_cache', 'm1', '{"capture.plan_dirs":["notes"]}', 1)`).run();
      const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: source.now });
      const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!;
      const lines = artifact.text.trim().split('\n').map((line) => JSON.parse(line) as { t?: string; r?: Record<string, unknown> });
      const identity = lines.find((line) => line.t === 'machine_claims' && line.r?.machine_id === 'machine_backup_cache')!;
      expect(identity.r).not.toHaveProperty('settings_cached_values');
      expect(identity.r).not.toHaveProperty('settings_cached_revision');
      expect(identity.r).not.toHaveProperty('settings_report_order');
      expect(identity.r).not.toHaveProperty('settings_contract_supported');
      expect(lines.some((line) => line.t === 'machine_settings_snapshots')).toBe(false);
      identity.r = { ...identity.r, settings_cached_revision: 'm1', settings_cached_values: '{"capture.plan_dirs":["notes"]}', settings_report_order: 5, settings_contract_supported: 1 };
      await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: lines.map((line) => JSON.stringify(line)).join('\n'), allowForeignLineage: true });
      expect(target.sqlite.query(`SELECT settings_cached_revision, settings_cached_values, settings_report_order, settings_contract_supported FROM machine_claims WHERE machine_id = 'machine_backup_cache'`).get())
        .toEqual({ settings_cached_revision: null, settings_cached_values: null, settings_report_order: -1, settings_contract_supported: 0 });
      expect(target.sqlite.query(`SELECT * FROM machine_settings_snapshots WHERE machine_id = 'machine_backup_cache'`).all()).toEqual([]);
    } finally { source.sqlite.close(); target.sqlite.close(); }
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
  it('records the SHA-256 of the exact bytes stored, and catalogues nothing when the store receives other bytes', async () => {
    const { db, bucket, sqlite, now } = seeded();
    const backup = await createBackup(db, bucket, { producer: 'test', now });
    const stored = bucket.objects.get(backup.key)!.bytes;
    expect(backup.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(sqlite.query('SELECT sha256, size_bytes FROM backups WHERE id = ?').get(backup.id))
      .toEqual({ sha256: backup.sha256, size_bytes: stored.byteLength });
    expect((await listBackups(db, bucket)).map((row) => row.sha256)).toEqual([backup.sha256]);

    const sameLengthChange = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { const changed = chunk.slice(); changed[0] ^= 1; controller.enqueue(changed); },
    });
    const altering = { ...bucket, put: (key: string, value: ReadableStream | null, options?: { sha256?: string }) =>
      bucket.put(key, value === null ? null : value.pipeThrough(sameLengthChange), options) };
    await expect(createBackup(db, altering, { producer: 'test', now })).rejects.toThrow('SHA-256 checksum');
    expect(sqlite.query('SELECT id FROM backups').all()).toEqual([{ id: backup.id }]);
  });

  it('refuses multibyte records past the byte limit without writing an artifact or index', async () => {
    const { db, bucket, sqlite, now } = seeded();
    sqlite.query(`UPDATE projects SET name = ? WHERE project_id = 'proj_bk'`)
      .run('界'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3)));
    await expect(createBackup(db, bucket, { producer: 'test', now })).rejects.toThrow(BackupAdmissionError);
    expect(bucket.objects.size).toBe(0);
    expect(await listBackups(db, bucket)).toEqual([]);
    sqlite.close();
  });

  it('counts the serialized rows when a source row disappears after its snapshot is read', async () => {
    const { db, bucket, sqlite, now } = seeded();
    const liveDb = {
      ...db,
      async batch(statements: Parameters<typeof db.batch>[0]) {
        const results = await db.batch(statements);
        if (results.some((one) => one.results.some((row) => 'snapshot_count' in (row as Record<string, unknown>)))) {
          sqlite.query(`DELETE FROM sessions WHERE session_id = 'sess_1'`).run();
        }
        return results;
      },
    };
    const backup = await createBackup(liveDb, bucket, { producer: 'test', now });
    const text = new TextDecoder().decode(bucket.objects.get(backup.key)!.bytes);
    const [header, ...rows] = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    const actual = Object.fromEntries(BACKUP_TABLES.map((table) => [table, rows.filter((row) => row.t === table).length]));
    expect(header.counts).toEqual(actual);
    expect(JSON.parse(backup.counts_json)).toEqual(actual);
    expect(actual.sessions).toBe(1);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'sess_1'`).get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it('writes the artifact and its index row, lists it verified, and previews without executing rows', async () => {
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

describe('stored artifact integrity', () => {
  const isWrite = (sql: string): boolean => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
  /** The stored bytes with one ASCII field changed, byte length unchanged. */
  const sameLengthChange = (bytes: Uint8Array): Uint8Array => {
    const changed = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('"producer":"test"', '"producer":"TEST"'));
    expect(changed.byteLength).toBe(bytes.byteLength);
    expect(changed).not.toEqual(bytes);
    return changed;
  };

  it('refuses a same-length change to a digest-bearing artifact before preview, restore or download writes anything, and reads it again once intact', async () => {
    const { db, bucket, sqlite, executed, now } = seeded();
    const backup = await createBackup(db, bucket, { producer: 'test', now });
    const original = bucket.objects.get(backup.key)!;
    sqlite.query(`DELETE FROM sessions WHERE session_id = 'sess_1'`).run();
    bucket.objects.set(backup.key, { ...original, bytes: sameLengthChange(original.bytes) });

    const mark = executed.length;
    await expect(previewRestore(db, bucket, backup.id)).rejects.toThrow(BackupIntegrityError);
    await expect(restoreBackup(db, bucket, { authorization: { kind: 'recovery' }, id: backup.id })).rejects.toThrow(`the stored backup artifact ${backup.id} does not match the SHA-256 digest recorded when it was created`);
    await expect(backupArtifact(db, bucket, backup.id)).rejects.toThrow(BackupIntegrityError);
    expect(executed.slice(mark).filter(isWrite)).toEqual([]);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
    expect(sqlite.query(`SELECT * FROM backup_restore_progress`).all()).toEqual([]);
    expect(bucket.deletes).toEqual([]);
    expect((await listBackups(db, bucket)).map((row) => ({ id: row.id, present: row.present, sha256: row.sha256 })))
      .toEqual([{ id: backup.id, present: true, sha256: backup.sha256 }]);

    bucket.objects.set(backup.key, original);
    const read = await backupArtifact(db, bucket, backup.id);
    expect(createHash('sha256').update(read!.text).digest('hex')).toBe(backup.sha256!);
    expect((await previewRestore(db, bucket, backup.id))!.foreignLineage).toBe(false);
    expect((await restoreBackup(db, bucket, { authorization: { kind: 'recovery' }, id: backup.id }))!.tables.sessions).toEqual({ rows: 1, inserted: 1 });
  });

  it('holds every read to the recorded size, counting delivered bytes rather than the declared size, whether or not the row recorded a digest', async () => {
    const { db, bucket, sqlite, now } = seeded();
    const backup = await createBackup(db, bucket, { producer: 'test', now });
    const original = bucket.objects.get(backup.key)!;
    const sizeRefusal = 'does not match the size recorded when it was created';
    const truncated = original.bytes.slice(0, original.bytes.byteLength - 1);
    bucket.objects.set(backup.key, { ...original, bytes: truncated, size: truncated.byteLength });
    await expect(previewRestore(db, bucket, backup.id)).rejects.toThrow(sizeRefusal);

    const longer = new Uint8Array(original.bytes.byteLength + 4096);
    longer.set(original.bytes);
    for (const declared of [original.size, original.bytes.byteLength - 1]) {
      bucket.objects.set(backup.key, { ...original, bytes: longer.subarray(0, declared === original.size ? longer.byteLength : declared), size: declared });
      await expect(restoreBackup(db, bucket, { authorization: { kind: 'recovery' }, id: backup.id })).rejects.toThrow(sizeRefusal);
    }

    sqlite.query(`UPDATE backups SET sha256 = NULL WHERE id = ?`).run(backup.id);
    bucket.objects.set(backup.key, { ...original, bytes: longer, size: original.size });
    await expect(backupArtifact(db, bucket, backup.id)).rejects.toThrow(sizeRefusal);

    sqlite.query(`UPDATE backups SET size_bytes = ? WHERE id = ?`).run(MAX_BACKUP_BYTES + 1, backup.id);
    await expect(backupArtifact(db, bucket, backup.id)).rejects.toThrow(BackupTooLargeError);
    expect(bucket.deletes).toEqual([]);
  });

  it('reads an artifact whose row recorded no digest after its size check alone, as it did before digests were recorded', async () => {
    const { db, bucket, sqlite, now } = seeded();
    const backup = await createBackup(db, bucket, { producer: 'test', now });
    sqlite.query(`UPDATE backups SET sha256 = NULL WHERE id = ?`).run(backup.id);
    sqlite.query(`DELETE FROM sessions WHERE session_id = 'sess_1'`).run();
    const original = bucket.objects.get(backup.key)!;
    expect((await backupArtifact(db, bucket, backup.id))!.text).toBe(new TextDecoder().decode(original.bytes));
    expect((await previewRestore(db, bucket, backup.id))!.foreignLineage).toBe(false);
    expect((await restoreBackup(db, bucket, { authorization: { kind: 'recovery' }, id: backup.id }))!.tables.sessions).toEqual({ rows: 1, inserted: 1 });
    // No digest exists to hold a same-length change to; the size is the only evidence such a row carries.
    bucket.objects.set(backup.key, { ...original, bytes: sameLengthChange(original.bytes) });
    expect((await previewRestore(db, bucket, backup.id))!.header.producer).toBe('TEST');
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

    await expect(restoreBackup(target.db, target.bucket, { authorization: { kind: 'recovery' }, id: backup.id })).rejects.toThrow(BackupLineageError);

    // The target's own row under the same key stays as it is: additive, target wins.
    target.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_bk', 'THEIRS', 1)`).run();
    const outcome = await restoreBackup(target.db, target.bucket, { authorization: { kind: 'recovery' }, id: backup.id, allowForeignLineage: true });
    expect(outcome!.tables.sessions).toEqual({ rows: 1, inserted: 1 });
    expect(outcome!.tables.projects!.inserted).toBeLessThan(outcome!.tables.projects!.rows);
    const kept = target.sqlite.query(`SELECT name FROM projects WHERE project_id = 'proj_bk'`).get() as { name: string };
    expect(kept.name).toBe('THEIRS');
    expect((await deploymentId(target.db)) === (await deploymentId(source.db))).toBe(false);

    const again = await restoreBackup(target.db, target.bucket, { authorization: { kind: 'recovery' }, id: backup.id, allowForeignLineage: true });
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
    const doctoredBytes = new TextEncoder().encode(doctored);
    source.bucket.objects.set(doctoredKey, { ...source.bucket.objects.get(backup.key)!, bytes: doctoredBytes, size: doctoredBytes.byteLength });
    source.sqlite.query(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned)
        VALUES ('bk_doctored', ?, 1, ?, '{}', 999, 'test', 0)`).run(doctoredKey, doctoredBytes.byteLength);
    await expect(restoreBackup(source.db, source.bucket, { authorization: { kind: 'recovery' }, id: 'bk_doctored' })).rejects.toThrow(BackupSchemaError);

    // agent_reports already holds a row, so its restore is a named skip, never a silent drop.
    const outcome = await restoreBackup(source.db, source.bucket, { authorization: { kind: 'recovery' }, id: backup.id });
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
    counts_json: '{}', schema_version: 13, producer: 'test', pinned, sha256: null,
  });

  it('keeps the newest keepDaily, one per week for keepWeekly weeks, and pinned rows exempt without consuming a slot', () => {
    const rows = [row('a', 0), row('b', 1), row('c', 2), row('p', 3, 1), row('d', 9), row('e', 16), row('f', 30), row('g', 31)];
    const victims = retentionVictims(rows, 2, 3).map((v) => v.id).sort();
    // a,b kept daily; weeks of a/b, d, e kept weekly (newest each); pinned p never a victim.
    expect(victims).toEqual(['c', 'f', 'g']);
    expect(retentionVictims(rows, 0, 0).map((v) => v.id)).not.toContain('p');
  });

  it('prunes through the release owner: the victim\'s object is journaled with its row removed, and the drain deletes it only once the store acknowledges', async () => {
    const { db, bucket, sqlite, now } = seeded();
    const old = await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    const fresh = await createBackup(db, bucket, { producer: 'test', now });
    const pruned = await pruneBackups(db, { keepDaily: 1, keepWeekly: 1 }, now);
    expect({ pruned: pruned.pruned, journal: journaled(sqlite), deleted: bucket.deletes }).toEqual({ pruned: 1, journal: [old.key], deleted: [] });
    expect((await listBackups(db, bucket)).map((l) => l.id)).toEqual([fresh.id]);
    expect((await drainObjectReleases({ db, blobs: bucket }, now)).deleted).toBe(1);
    expect({ journal: journaled(sqlite), deleted: bucket.deletes }).toEqual({ journal: [], deleted: [old.key] });

    const again = await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    expect((await pruneBackups(db, { keepDaily: 1, keepWeekly: 1 }, now)).pruned).toBe(1);
    const failing = { ...bucket, delete: async () => { throw new Error('store outage'); } };
    expect(await drainObjectReleases({ db, blobs: failing }, now)).toEqual({ expired: 0, deleted: 0, decided: 0, unacknowledged: 1 });
    expect({ journal: journaled(sqlite), stored: bucket.objects.has(again.key) }).toEqual({ journal: [again.key], stored: true });
  });

  it('pin exempts a row from retention until unpinned', async () => {
    const { db, bucket, now } = seeded();
    const old = await createBackup(db, bucket, { producer: 'test', now: now - 40 * DAY });
    await createBackup(db, bucket, { producer: 'test', now });
    expect(await setBackupPinned(db, old.id, true)).toBe(true);
    expect((await pruneBackups(db, { keepDaily: 1, keepWeekly: 1 }, now)).pruned).toBe(0);
    expect(await setBackupPinned(db, old.id, false)).toBe(true);
    expect((await pruneBackups(db, { keepDaily: 1, keepWeekly: 1 }, now)).pruned).toBe(1);
  });
});

describe('apply refusals', () => {
  it('names the table when an artifact row cannot be applied, and refuses a column name outside the grammar', async () => {
    const { db, bucket, now } = seeded();
    const header = JSON.stringify({ format: 'myco-backup/1', deploymentId: await deploymentId(db), schemaVersion: 13, createdAt: now, producer: 'test', counts: {} });
    const orphanReport = JSON.stringify({ t: 'agent_reports', r: { project_id: 'proj_bk', run_id: 'run_ghost', agent_id: 'agent_bk', action: 'a', summary: 's', created_at: now } });
    const { restoreArtifact, BackupApplyError } = await import('@myco-server-worker/core/backup.js');
    await expect(restoreArtifact(db, { authorization: { kind: 'recovery' }, text: `${header}\n${orphanReport}\n` })).rejects.toThrow(BackupApplyError);
    await expect(restoreArtifact(db, { authorization: { kind: 'recovery' }, text: `${header}\n${orphanReport}\n` })).rejects.toThrow(/agent_reports/);

    const crafted = JSON.stringify({ t: 'projects', r: { 'project_id, name) VALUES (1,2); --': 'x' } });
    await expect(restoreArtifact(db, { authorization: { kind: 'recovery' }, text: `${header}\n${crafted}\n` })).rejects.toThrow(/column name outside the store grammar/);
  });
});
