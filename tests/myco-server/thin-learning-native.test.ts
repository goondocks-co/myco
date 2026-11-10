import { expect, it, spyOn } from 'bun:test';
import { withDocumentStores } from './helpers/document-stores.js';
import { V104_STATEMENTS } from '@myco-server-worker/db/schema-v104.js';
import { THIN_LEARNING_ADMISSION_SQL, admitThinLearningRemoval } from '@myco-server-worker/db/thin-learning-admission.js';
import { backupArtifact, createBackup } from '@myco-server-worker/core/backup.js';
import { restoreArtifact } from './helpers/restore-artifact.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintFile } from '@myco/server/recovery-bundle.js';
import { withRecoveryDatabaseCopy } from '@myco/server/recovery-copy.js';
import { PRIVATE_RECOVERY_COPY_REQUIRED, withPrivateRecoveryCopy, type PrivateRecoveryCopy } from '@myco-server-worker/platform/bun/private-recovery-copy.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import {SERVER_SCHEMA_VERSION} from '@myco-server-worker/constants.js';
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
        expect(migrateOnly(file)).toBe(SCHEMA_STEPS.filter(step => step.version > from).length);
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
      expect(migrateOnly(file)).toBe(SCHEMA_STEPS.filter(step => step.version > (from < 102 ? 103 : from)).length);
      expect(migrateOnly(file)).toBe(0);
    } finally { report.mockRestore(); fs.rmSync(root, {recursive:true,force:true}); }
  });
}
