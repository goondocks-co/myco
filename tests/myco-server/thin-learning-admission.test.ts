import { expect, it, spyOn } from 'bun:test';
import { withViewStores } from './helpers/view-stores.js';
import { V104_STATEMENTS } from '@myco-server-worker/db/schema-v104.js';
import { assertThinLearningDrained, THIN_LEARNING_ADMISSION_SQL, admitThinLearningRemoval } from '@myco-server-worker/db/thin-learning-admission.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintFile } from '@myco/server/recovery-bundle.js';
import { withRecoveryDatabaseCopy } from '@myco/server/recovery-copy.js';
import { PRIVATE_RECOVERY_COPY_REQUIRED, withPrivateRecoveryCopy, type PrivateRecoveryCopy } from '@myco-server-worker/platform/bun/private-recovery-copy.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { THIN_LEARNING_UPGRADE_REMEDY, THIN_LEARNING_STEPPING_STONE_REQUIRED, THIN_LEARNING_STEPPING_STONE_REMEDY, THIN_LEARNING_RUNS_TABLE_SQL, thinLearningUpgradeAdmission } from '@myco-server-worker/db/thin-learning-admission.js';

it('admits bootstrap only without a run table and requires a classified answer for every existing catalogue', () => {
  const reports: string[] = [];
  const report = (line: string) => reports.push(line);
  const empty = thinLearningUpgradeAdmission(0,104,report);
  expect(empty.next().value).toBe(THIN_LEARNING_RUNS_TABLE_SQL);
  expect(empty.next([]).done).toBe(true);
  for (const from of [102,103]) {
    const check = thinLearningUpgradeAdmission(from,104,report);
    expect(check.next().value).toBe(THIN_LEARNING_ADMISSION_SQL);
    expect(() => check.next([])).toThrow('thin learning admission returned no result');
    const valid = thinLearningUpgradeAdmission(from,104,report);
    valid.next();
    expect(valid.next([{refusal:null}]).done).toBe(true);
  }
  const malformed = thinLearningUpgradeAdmission(0,104,report);
  malformed.next();
  expect(() => malformed.next([{name:'other'}])).toThrow('invalid table result');
  expect(thinLearningUpgradeAdmission(104,104,report).next().done).toBe(true);
  expect(thinLearningUpgradeAdmission(101,103,report).next().done).toBe(true);
  expect(reports).toEqual([]);
  for (const from of [1,6,7,94,101]) {
    const check = thinLearningUpgradeAdmission(from,104,report);
    expect(() => check.next()).toThrow(THIN_LEARNING_STEPPING_STONE_REQUIRED);
  }
  const existing = thinLearningUpgradeAdmission(0,104,report);
  existing.next();
  expect(() => existing.next([{name:'agent_runs'}])).toThrow(THIN_LEARNING_STEPPING_STONE_REQUIRED);
  expect(reports).toEqual(Array(6).fill(THIN_LEARNING_STEPPING_STONE_REMEDY));
});

for (const from of [94, 101, 102, 103]) for (const status of ['running', 'pending', 'queued', 'completed']) {
  it(`refuses native ${from} activation before any schema step with ${status} extraction`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-jump-'));
    const file = path.join(root, 'server.sqlite');
    const report = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = new Database(file);
      let meta: unknown[], run: unknown;
      try {
        for (const step of SCHEMA_STEPS.filter(step => step.version <= from)) for (const sql of step.statements) db.exec(sql);
        db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('thin','Thin',1)");
        db.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('thin','Thin','built-in',1,1)");
        db.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at) VALUES('thin','held','thin','extract-curate',?,1,2)").run(status);
        meta = db.query('SELECT * FROM schema_meta ORDER BY key').all();
        run = db.query("SELECT * FROM agent_runs WHERE id='held'").get();
      } finally { db.close(); }
      if (from >= 102 && status === 'completed') {
        expect(migrateOnly(file)).toBe(104-from);
        return;
      }
      expect(() => migrateOnly(file)).toThrow(from < 102 ? THIN_LEARNING_STEPPING_STONE_REQUIRED : 'thin_learning_not_drained');
      expect(report.mock.calls).toEqual([[from < 102 ? THIN_LEARNING_STEPPING_STONE_REMEDY : THIN_LEARNING_UPGRADE_REMEDY]]);
      const held = new Database(file);
      try {
        expect(held.query('SELECT * FROM schema_meta ORDER BY key').all()).toEqual(meta);
        expect(held.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({value:String(from)});
        expect(held.query("SELECT * FROM agent_runs WHERE id='held'").get()).toEqual(run);
        held.exec("UPDATE agent_runs SET status='completed' WHERE id='held'");
      } finally { held.close(); }
      if (from < 102) {
        expect(() => migrateOnly(file)).toThrow(THIN_LEARNING_STEPPING_STONE_REQUIRED);
        const stepping = new Database(file);
        try {
          for (const step of SCHEMA_STEPS.filter(step => step.version > from && step.version <= 103)) for (const sql of step.statements) stepping.exec(sql);
        } finally { stepping.close(); }
      }
      expect(migrateOnly(file)).toBe(from < 102 ? 1 : 104-from);
      expect(migrateOnly(file)).toBe(0);
    } finally { report.mockRestore(); fs.rmSync(root, {recursive:true,force:true}); }
  });
}

it('admits only drained pre-pause extraction on native and D1, including equal and unknown dispatch boundaries', async () => {
  await withViewStores(async db => {
    await db.prepare("UPDATE schema_meta SET value='100' WHERE key='learning_paused_at'").run();
    await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
    for (const status of ['queued', 'pending', 'running']) for (const [queued, started] of [[99, 101], [100, 101], [null, 100], [null, null]]) {
      await db.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at) VALUES('other','held','agent','extract-curate',?,?,?)")
        .bind(status, queued, started).run();
      const before = (await db.prepare('SELECT * FROM agent_runs').all()).results;
      await expect(assertThinLearningDrained(db)).rejects.toThrow('thin_learning_not_drained');
      await expect(db.batch(V104_STATEMENTS.map(sql => db.prepare(sql)))).rejects.toThrow('thin_learning_not_drained');
      expect((await db.prepare('SELECT * FROM agent_runs').all()).results).toEqual(before);
      expect(await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first()).toEqual({ value: '103' });
      await db.prepare("UPDATE agent_runs SET status='completed' WHERE id='held'").run();
      await assertThinLearningDrained(db);
      await db.prepare("DELETE FROM agent_runs WHERE id='held'").run();
    }
    for (const task of ['title-summary', 'canopy-map', 'extract-curate']) {
      await db.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('project',?,'agent',?,'running',?)")
        .bind(task, task, task === 'extract-curate' ? 101 : 1).run();
    }
    await assertThinLearningDrained(db);
    await db.batch(V104_STATEMENTS.map(sql => db.prepare(sql)));
    await db.batch(V104_STATEMENTS.map(sql => db.prepare(sql)));
    for (const value of ['', 'abc', '100ms', '-1', '0', '1.5', '00100', '9007199254740992']) {
      await db.prepare("UPDATE schema_meta SET value=? WHERE key='learning_paused_at'").bind(value).run();
      await expect(assertThinLearningDrained(db)).rejects.toThrow('thin_learning_pause_required');
      await expect(db.batch(V104_STATEMENTS.map(sql => db.prepare(sql)))).rejects.toThrow('thin_learning_pause_required');
    }
    await db.prepare("DELETE FROM schema_meta WHERE key='learning_paused_at'").run();
    await expect(assertThinLearningDrained(db)).rejects.toThrow('thin_learning_pause_required');
  }, 103);
}, 30_000);

it('rejects an entire additive artifact before any write and preserves terminal history and post-pause work', async () => {
  const source = sqliteEnv(), target = sqliteEnv();
  try {
    source.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('restore-agent','Agent','built-in',1,1)");
    source.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('proj_1','old','restore-agent','extract-curate','running',1)");
    const artifact = async () => {
      const saved = await createBackup(source.db, source.bucket, { producer: 'admission-test', now: Date.now() });
      return (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    };
    const text = await artifact();
    const writes: string[] = [];
    const guarded = { prepare(sql: string) {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i.test(sql)) writes.push(sql);
      return target.db.prepare(sql);
    }, batch: target.db.batch };
    await expect(restoreArtifact(guarded, { text, allowForeignLineage: true, authorization: { kind: 'recovery' } }))
      .rejects.toThrow('thin_learning_not_drained');
    expect(writes).toEqual([]);
    expect(target.sqlite.query("SELECT * FROM agents WHERE id='restore-agent'").get()).toBeNull();
    source.sqlite.run("UPDATE agent_runs SET status='completed' WHERE id='old'");
    await restoreArtifact(target.db, { text: await artifact(), allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(target.sqlite.query("SELECT status FROM agent_runs WHERE id='old'").get()).toEqual({ status: 'completed' });
    await assertThinLearningDrained(target.db, [{ task: 'extract-curate', status: 'running', queued_at: Number.MAX_SAFE_INTEGER }]);
    await expect(assertThinLearningDrained(target.db, [{ task: 'extract-curate', status: 'queued' }])).rejects.toThrow('thin_learning_not_drained');
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('propagates admission store errors and refuses missing or malformed results', async () => {
  const unavailable = new Error('admission store unavailable');
  await expect(assertThinLearningDrained({ prepare: () => { throw unavailable; }, batch: async () => [] })).rejects.toBe(unavailable);
  for (const rows of [[], [{}], [{ refusal: false }], [{ refusal: 'unknown' }]]) expect(() => admitThinLearningRemoval(rows)).toThrow();
  expect(THIN_LEARNING_ADMISSION_SQL).toContain("status IN ('pending', 'running', 'queued')");
});

it('aborts the native migration without stamping or changing held work and converges after drain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-admission-'));
  const file = path.join(root, 'server.sqlite');
  try {
    const db = new Database(file);
    try {
      for (const step of SCHEMA_STEPS.filter(step => step.version <= 103)) for (const sql of step.statements) db.exec(sql);
      db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('thin','Thin',1)");
      db.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('thin','Thin','built-in',1,1)");
      db.exec("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('thin','held','thin','extract-curate','pending',1)");
    } finally { db.close(); }
    expect(() => migrateOnly(file)).toThrow('thin_learning_not_drained');
    const held = new Database(file);
    try {
      expect(held.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({ value: '103' });
      expect(held.query("SELECT status FROM agent_runs WHERE id='held'").get()).toEqual({ status: 'pending' });
      expect(held.query("SELECT name FROM sqlite_master WHERE name='_v104_guard_thin_learning'").get()).toBeNull();
      held.exec("UPDATE agent_runs SET status='completed' WHERE id='held'");
    } finally { held.close(); }
    expect(migrateOnly(file)).toBe(1);
    expect(migrateOnly(file)).toBe(0);
  } finally { fs.rmSync(root, { recursive: true }); }
});

for (const from of [41,101]) for (const status of ['queued','pending','running']) it(`refuses staged schema${from} ${status} extraction before the pause migration`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'thin-private-'));
  const source = path.join(root,'source.sqlite');
  const report = spyOn(console,'warn').mockImplementation(()=>{});
  try {
    const db = new Database(source);
    try {
      for (const step of SCHEMA_STEPS.filter(step=>step.version<=from)) for (const sql of step.statements) db.exec(sql);
      db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('thin','Thin',1); INSERT INTO agents(id,name,source,enabled,created_at) VALUES('thin','Thin','built-in',1,1)");
      db.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at) VALUES('thin','held','thin','extract-curate',?,1,2)").run(status);
    } finally {db.close();}
    const fingerprint = await fingerprintFile(source);
    await withRecoveryDatabaseCopy(source,fingerprint,async copy=>{
      const original = new Database(copy.databasePath);
      const meta = original.query('SELECT * FROM schema_meta ORDER BY key').all();
      const run = original.query("SELECT * FROM agent_runs WHERE id='held'").get();
      original.close();
      expect(()=>migrateOnly(copy.databasePath,undefined,copy)).toThrow('thin_learning_not_drained');
      const held = new Database(copy.databasePath);
      try {
        expect(held.query('SELECT * FROM schema_meta ORDER BY key').all()).toEqual(meta);
        expect(held.query("SELECT * FROM agent_runs WHERE id='held'").get()).toEqual(run);
        expect(held.query("SELECT value FROM schema_meta WHERE key='learning_paused_at'").get()).toBeNull();
        held.exec("UPDATE agent_runs SET status='completed' WHERE id='held'");
      } finally {held.close();}
      expect(migrateOnly(copy.databasePath,undefined,copy)).toBe(104-from);
    });
    expect(report.mock.calls).toEqual([[THIN_LEARNING_UPGRADE_REMEDY]]);
    expect(await fingerprintFile(source)).toEqual(fingerprint);
  } finally {report.mockRestore();fs.rmSync(root,{recursive:true,force:true});}
});

it('refuses recovery authority forged for a live path, borrowed from a private copy, or used after its callback', async()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'thin-authority-'));
  const source = path.join(root,'live.sqlite');
  try {
    const db = new Database(source);
    for (const step of SCHEMA_STEPS.filter(step=>step.version<=101)) for (const sql of step.statements) db.exec(sql);
    db.close();
    const fingerprint = await fingerprintFile(source);
    expect(()=>migrateOnly(source,undefined,{databasePath:source})).toThrow(PRIVATE_RECOVERY_COPY_REQUIRED);
    let expired: PrivateRecoveryCopy | undefined;
    await withRecoveryDatabaseCopy(source,fingerprint,async copy=>{
      expired=copy;
      expect(()=>migrateOnly(source,undefined,copy)).toThrow(PRIVATE_RECOVERY_COPY_REQUIRED);
      fs.unlinkSync(copy.databasePath);
      fs.linkSync(source,copy.databasePath);
      expect(()=>migrateOnly(copy.databasePath,undefined,copy)).toThrow(PRIVATE_RECOVERY_COPY_REQUIRED);
    });
    const retained = path.join(root,'retained.sqlite');
    await withRecoveryDatabaseCopy(source,fingerprint,async copy=>{
      expired=copy;
      fs.renameSync(copy.databasePath,retained);
    });
    fs.mkdirSync(path.dirname(expired!.databasePath));
    fs.renameSync(retained,expired!.databasePath);
    expect(()=>migrateOnly(expired!.databasePath,undefined,expired!)).toThrow(PRIVATE_RECOVERY_COPY_REQUIRED);
    expect(await fingerprintFile(source)).toEqual(fingerprint);
    await expect(withPrivateRecoveryCopy(source,async file=>{
      fs.unlinkSync(file);fs.linkSync(source,file);
    },async()=>{throw new Error('a live alias received recovery authority');})).rejects.toThrow(PRIVATE_RECOVERY_COPY_REQUIRED);
    let used=false;
    await expect(withRecoveryDatabaseCopy(source,{...fingerprint,sha256:'0'.repeat(64)},async()=>{used=true;})).rejects.toThrow('source recovery database changed during copy');
    expect(used).toBe(false);
    expect(await fingerprintFile(source)).toEqual(fingerprint);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
