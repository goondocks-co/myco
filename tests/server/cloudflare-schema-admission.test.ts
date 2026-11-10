import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { createCloudflareDeployment, updateCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord, queryCloudflareDatabase } from '@myco/server/cloudflare.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { readBudgetStatus } from '@myco-server-worker/db/runs/budget.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { applyCloudflareSchema } from '@myco/server/cloudflare-schema.js';
import { restoreCloudflareDatabase } from '@myco/server/cloudflare-recovery-database.js';
import { VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';

import { fingerprintFile } from '@myco/server/recovery-bundle.js';
import { withRecoveryDatabaseCopy } from '@myco/server/recovery-copy.js';
import { THIN_LEARNING_STEPPING_STONE_REQUIRED, THIN_LEARNING_STEPPING_STONE_REMEDY, THIN_LEARNING_UPGRADE_REMEDY } from '@myco-server-worker/db/thin-learning-admission.js';
import { ACCOUNT, BOOKMARK, OLD_WORKER, fixture } from './fixtures/cloudflare-schema-update.js';

it('GATE: persists the bookmark and schema transition before the first migration subprocess', async () => {
  await fixture({}, async ({ home, update, calls, reports }) => {
    await update();
    const commands = calls();
    const at = (command: string) => commands.findIndex((call) => call.args.slice(0, 3).join(' ').includes(command));
    expect(at('time-travel info')).toBeGreaterThan(at('d1 execute'));
    expect(at('migrations apply')).toBeGreaterThan(at('time-travel info'));
    expect(at('deploy')).toBeGreaterThan(at('migrations apply'));
    for (const call of commands.filter((call) => call.args[0] === 'd1')) {
      expect(call.cwd).toBe(path.join(home, 'server/cloudflare/deploy'));
      expect(call.account).toBe(ACCOUNT);
      expect(call.args).toContain('wrangler.deploy.toml');
    }
    const saved = readDeploymentRecord(home)!.schemaUpdates!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ bookmark: BOOKMARK, schemaBefore: SERVER_SCHEMA_VERSION - 1,
      schemaAfter: SERVER_SCHEMA_VERSION, workerVersionBefore: OLD_WORKER });
    expect(Number.isFinite(Date.parse(saved[0]!.recordedAt))).toBe(true);
    expect(reports.join('\n')).toContain(`--bookmark=${BOOKMARK}`);
    expect(reports.join('\n')).toContain(`CLOUDFLARE_ACCOUNT_ID='${ACCOUNT}' npx --no-install wrangler d1 time-travel restore 'myco-server'`);
    expect(reports.join('\n')).toContain(`--version='${OLD_WORKER}'`);
    expect(reports.join('\n')).toContain('code depends on the new schema');
    expect(reports.join('\n')).toContain('an alpha.4 Worker on schema 83 commits prompt marks but reports marked:false');
  });
});

for (const [failure, overrides] of [
  ['failed', { bookmarkExit: 1 }],
  ['empty', { bookmarkOutput: '' }],
  ['missing', { bookmarkOutput: '{}' }],
  ['invalid characters', { bookmarkOutput: JSON.stringify({ bookmark: `${BOOKMARK}; echo invalid` }) }],
  ['too short', { bookmarkOutput: JSON.stringify({ bookmark: 'short' }) }],
] as const) it(`GATE: ${failure} bookmarks leave deployment data and remote resources unchanged`, async () => {
  await fixture(overrides, async ({ home, update, calls }) => {
    const before = fs.readFileSync(deploymentRecordPath(home), 'utf8');
    await expect(update()).rejects.toThrow('a current D1 Time Travel bookmark is required');
    expect(fs.readFileSync(deploymentRecordPath(home), 'utf8')).toBe(before);
    expect(calls().every(({ args }) => args[0] === '--version' || args[0] === 'whoami'
      || (args[0] === 'd1' && ['execute', 'time-travel'].includes(args[1]!)))).toBe(true);
  });
});

it('GATE: no-schema updates deploy without requesting a bookmark or applying migrations', async () => {
  await fixture({ schema: String(SERVER_SCHEMA_VERSION), bookmarkExit: 1 }, async ({ home, update, create, calls }) => {
    await update();
    await create();
    expect(calls().some(({ args }) => args.includes('time-travel') || args.includes('migrations'))).toBe(false);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(true);
    expect(readDeploymentRecord(home)!.schemaUpdates).toBeUndefined();
  });
});

it('retains recovery history when migrations fail and when an update is retried', async () => {
  await fixture({ migrationExit: 1 }, async ({ home, state, update, calls }) => {
    const db = new Database(JSON.parse(fs.readFileSync(state, 'utf8')).schemaDatabase);
    try { db.exec("DELETE FROM schema_meta WHERE key IN ('learning_paused_at','learning_resumed_at')"); }
    finally { db.close(); }
    await expect(update()).rejects.toThrow('exited 1');
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    expect(readDeploymentRecord(home)!.schemaUpdates).toHaveLength(1);
    await expect(update()).rejects.toThrow();
    expect(readDeploymentRecord(home)!.schemaUpdates).toHaveLength(2);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
  });
});

/** One case per outcome: before the stepping stone, each undrained status after it, and a drained catalogue. */
const ADMISSION_CASES = [[101, 'running'], [102, 'running'], [102, 'pending'], [103, 'queued'], [103, 'completed']] as const;

for (const [from, status] of ADMISSION_CASES) it(`admits or refuses hosted ${from} activation before any schema step with ${status} extraction`, async () => {
  await fixture({schema:String(from)}, async ({ root, home, update, calls, reports }) => {
    if (status === 'pending') writeDeploymentRecord({...readDeploymentRecord(home)!,schemaUpdates:[{
      bookmark:BOOKMARK,schemaBefore:from-1,schemaAfter:from,recordedAt:new Date(0).toISOString(),workerVersionBefore:OLD_WORKER,
    }]},home);
    const recordBefore = readDeploymentRecord(home)!;
    const db = new Database(path.join(root, 'schema.sqlite'));
    try {
      db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('thin','Thin',1); INSERT INTO agents(id,name,source,enabled,created_at) VALUES('thin','Thin','built-in',1,1)");
      db.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at) VALUES('thin','held','thin','extract-curate',?,1,2)").run(status);
    } finally { db.close(); }
    if (from >= 102 && status === 'completed') {
      await update();
      expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(true);
      return;
    }
    await expect(update()).rejects.toThrow(from < 102 ? THIN_LEARNING_STEPPING_STONE_REQUIRED : 'thin_learning_not_drained');
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    expect(readDeploymentRecord(home)).toEqual(recordBefore);
    expect(readDeploymentRecord(home)!.schemaUpdates).toEqual(recordBefore.schemaUpdates);
    expect(calls().some(({ args }) => args.includes('time-travel'))).toBe(false);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(calls().some(({ args }) => args.includes('migrations'))).toBe(false);
    expect(reports.filter(line => line === (from < 102 ? THIN_LEARNING_STEPPING_STONE_REMEDY : THIN_LEARNING_UPGRADE_REMEDY))).toHaveLength(1);
    expect(reports.join('\n')).not.toMatch(/D1 Time Travel bookmark recorded|Database rollback:|Roll back the Worker|Schema 83 rollback|Confirm the restore prompt/);
    const held = new Database(path.join(root, 'schema.sqlite'));
    try {
      expect(held.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({ value: String(from) });
      expect(held.query("SELECT status FROM agent_runs WHERE id='held'").get()).toEqual({ status });
    } finally { held.close(); }
  });
});
