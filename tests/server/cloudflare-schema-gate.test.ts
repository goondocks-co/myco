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
import { D1_OVERLOAD_RETRIES } from '@myco/server/cloudflare-migration-pacing.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';

it('reads the recorded Wrangler single-count JSON envelope',async()=>{
  const answer=[{results:[{n:0}],success:true,meta:{duration:0}}];
  const rows=await queryCloudflareDatabase({accountId:ACCOUNT,configDir:os.tmpdir(),databaseName:'fixture',
    sql:'SELECT COUNT(*) AS n FROM agent_runs',timeoutMs:1000,
    runner:{run:async()=>({code:0,stdout:JSON.stringify(answer),stderr:''})}});
  expect(rows).toEqual([{n:0}]);
});

for(const failure of ['empty','error'])it(`publishes the Worker with a visible inactive budget after an unreadable ${failure} preflight and activates on retry`,async()=>{
  await fixture({budgetCountFailure:failure},async({root,home,state,update,calls,reports})=>{
    const file=path.join(root,'schema.sqlite');
    const source=new Database(file);
    source.exec("INSERT INTO fixture_population VALUES(7); INSERT INTO projects(project_id,name,created_at) VALUES('kept','Kept',1); INSERT INTO agents(id,name,source,enabled,created_at) VALUES('fixture','Fixture','built-in',1,1); INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,dispatch_spec) VALUES('kept','waiting','fixture','title-summary','queued',1,'{\"actor\":\"clock\"}')");
    source.close();
    await update();
    expect(readDeploymentRecord(home)).toMatchObject({versionId:'22222222-2222-4333-8444-555555555555',schemaUpdates:[{schemaAfter:SERVER_SCHEMA_VERSION,appliedAt:expect.any(String)}]});
    const db=new Database(file);
    try {
      expect(db.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({value:String(SERVER_SCHEMA_VERSION)});
      expect(db.query('SELECT * FROM fixture_population').all()).toEqual([{id:7}]);
      expect(db.query("SELECT status,origin FROM agent_runs WHERE id='waiting'").get()).toEqual({status:'queued',origin:'automatic'});
      expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('idx_attempts_claimed','idx_agent_runs_queue_head')").all()).toEqual([]);
      expect(await readBudgetStatus(sqliteRelationalStore(db),Date.now())).toMatchObject({active:false,reason:expect.stringContaining('preflight')});
      expect(db.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toBeNull();
    }finally{db.close();}
    expect(reports.join('\n')).toContain('Budget governor inactive:');
    fs.writeFileSync(state,JSON.stringify({...JSON.parse(fs.readFileSync(state,'utf8')),budgetCountFailure:null}));
    await update();
    const restored=new Database(file);
    try {
      expect(await readBudgetStatus(sqliteRelationalStore(restored),Date.now())).toMatchObject({active:true,reason:null});
      expect(restored.query("SELECT value FROM schema_meta WHERE key='budget_activation_refusal'").get()).toBeNull();
    }finally{restored.close();}
    expect(calls().filter(({args})=>args[0]==='d1'&&args[1]==='migrations')).toHaveLength(1);
    expect(calls().filter(({args})=>args[0]==='deploy')).toHaveLength(2);
  });
});

it('refuses unreadable or newer live schemas before requesting recovery or changing remote resources', async () => {
  for (const schema of ['0', '', 'NaN', '1.5', String(SERVER_SCHEMA_VERSION + 1)]) {
    await fixture({ schema }, async ({ home, update, calls }) => {
      const before = readDeploymentRecord(home);
      await expect(update()).rejects.toThrow();
      expect(readDeploymentRecord(home)).toEqual(before);
      expect(calls().some(({ args }) => args.includes('time-travel') || args[0] === 'vectorize' || args[0] === 'deploy')).toBe(false);
    });
  }
});

it('GATE: recorded create, adopted create and interrupted-create retries admit migrations through the same durable gate', async () => {
  for (const mode of ['recorded', 'adopted', 'retry'] as const) {
    await fixture({ workerBefore: mode === 'adopted' ? null : OLD_WORKER, migrationExit: mode === 'retry' ? 1 : 0 }, async ({ home, create, calls }) => {
      if (mode === 'adopted') fs.rmSync(deploymentRecordPath(home));
      if (mode === 'retry') {
        await expect(create()).rejects.toThrow();
        await expect(create()).rejects.toThrow();
      } else await create();
      const gates = readDeploymentRecord(home)!.schemaUpdates!;
      expect(gates).toHaveLength(mode === 'retry' ? 2 : 1);
      expect(gates[0]).toMatchObject({ bookmark: BOOKMARK, schemaBefore: SERVER_SCHEMA_VERSION - 1, schemaAfter: SERVER_SCHEMA_VERSION });
      const commands = calls().map(({ args }) => args.slice(0, 3).join(' '));
      expect(commands.indexOf('d1 migrations apply')).toBeGreaterThan(commands.indexOf('d1 time-travel info'));
    });
  }
}, 60_000);

it('GATE: existing create refuses missing bookmarks, and fresh empty provisioning needs none', async () => {
  await fixture({ bookmarkExit: 1 }, async ({ home, create, calls }) => {
    const before = fs.readFileSync(deploymentRecordPath(home), 'utf8');
    await expect(create()).rejects.toThrow('a current D1 Time Travel bookmark is required');
    expect(fs.readFileSync(deploymentRecordPath(home), 'utf8')).toBe(before);
    expect(calls().some(({ args }) => args[0] === 'vectorize' || args[0] === 'r2' || args[0] === 'secrets-store')).toBe(false);
    expect(calls().some(({ args }) => args.includes('migrations') || args[0] === 'deploy')).toBe(false);
    expect(readDeploymentRecord(home)!.schemaUpdates).toBeUndefined();
  });
  await fixture({ fresh: true, schema: '0', bookmarkExit: 1 }, async ({ home, create, calls }) => {
    fs.rmSync(deploymentRecordPath(home));
    await create();
    expect(calls().some(({ args }) => args.includes('time-travel'))).toBe(false);
    expect(calls().some(({ args }) => args.includes('migrations') && args.includes('--remote'))).toBe(true);
    expect(readDeploymentRecord(home)!.schemaUpdates).toBeUndefined();
  });
});

it('GATE: interrupted recovery imports and migration resumes record a bookmark before ledger or migration work', async () => {
  await fixture({}, async ({ root, home, state, calls }) => {
    const databasePath = path.join(root, 'source.sqlite');
    const source = new Database(databasePath);
    // The source predates the session-view tables (step 105), so the resumed migration applies every later step.
    const sourceVersion = 104;
    for (const step of SCHEMA_STEPS.filter((step) => step.version <= sourceVersion)) source.exec(step.statements.join(';\n'));
    source.exec("INSERT INTO schema_meta VALUES('fixture_note','preserved')");
    source.close();
    const destination = path.join(root, 'replacement.sqlite');
    const journal = path.join(root, 'recovery.json');
    const record = readDeploymentRecord(home)!;
    const initial = JSON.parse(fs.readFileSync(state, 'utf8'));
    const saveState = (extra: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify({ ...initial, destination, schema: String(sourceVersion), ...extra }));
    const restore = (failPersistence = false) => restoreCloudflareDatabase({
      accountId: ACCOUNT, mycoHome: home, configDir: path.join(home, 'server/cloudflare/deploy'), configFile: 'wrangler.deploy.toml',
      databaseName: record.databaseName, databasePath, sourceFingerprint: 'a'.repeat(64),
      record: fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : record,
      persist: (next) => {
        if (failPersistence) throw new Error('fixture durable write refused');
        atomicWriteFileSync(journal, JSON.stringify(next), { durable: true });
      },
    });
    fs.mkdirSync(path.join(home, 'server/cloudflare/deploy'), { recursive: true });
    const previous = process.env.FAKE_RECORD;
    process.env.FAKE_RECORD = journal;
    try {
      saveState({ loseImportReply: true });
      await expect(restore()).rejects.toThrow('Cloudflare recovery import failed');
      expect(calls().some(({ args }) => args.includes('time-travel') || args.includes('migrations'))).toBe(false);
      saveState({ bookmarkExit: 1 });
      await expect(restore()).rejects.toThrow('a current D1 Time Travel bookmark is required');
      const imported = fs.readFileSync(destination);
      const atRefusal = calls().length;
      saveState({ bookmarkOutput: '{}' });
      await expect(restore()).rejects.toThrow('a current D1 Time Travel bookmark is required');
      saveState({});
      await expect(restore(true)).rejects.toThrow('could not durably record');
      expect(fs.readFileSync(destination)).toEqual(imported);
      expect(calls().slice(atRefusal).some(({ args }) => args.includes('--file') || args.includes('migrations'))).toBe(false);
      saveState({ migrationExit: 1 });
      await expect(restore()).rejects.toThrow();
      expect(JSON.parse(fs.readFileSync(journal, 'utf8')).schemaUpdates).toHaveLength(1);
      saveState({});
      await expect(restore()).resolves.toEqual({ schemaVersion: SERVER_SCHEMA_VERSION, imported: false });
      expect(JSON.parse(fs.readFileSync(journal, 'utf8')).schemaUpdates).toHaveLength(2);
      const data = new Database(destination, { readonly: true });
      try { expect(data.query("SELECT value FROM schema_meta WHERE key='fixture_note'").get()).toEqual({ value: 'preserved' }); }
      finally { data.close(); }
    } finally { process.env.FAKE_RECORD = previous; }
  });
});

for (const verb of ['update', 'create'] as const) {
  it(`GATE: a failed durable deployment-record write refuses migrations after obtaining the bookmark (${verb})`, async () => {
    await fixture({ persistFail: true }, async (f) => {
      await expect(f[verb]()).rejects.toThrow('could not durably record');
      expect(f.calls().some(({ args }) => args.includes('time-travel'))).toBe(true);
      expect(f.calls().some(({ args }) => args.includes('migrations') || args[0] === 'deploy')).toBe(false);
    });
  });
}

it('GATE: a first create interrupted before schema installation requires a bookmark on retry', async () => {
  await fixture({ fresh: true, schema: '0', workerBefore: null, migrationExit: 1 }, async ({ home, state, create, calls }) => {
    fs.rmSync(deploymentRecordPath(home));
    await expect(create()).rejects.toThrow();
    expect(readDeploymentRecord(home)!.schemaUpdates).toBeUndefined();
    expect(calls().some(({ args }) => args.includes('time-travel'))).toBe(false);
    const current = JSON.parse(fs.readFileSync(state, 'utf8'));
    fs.writeFileSync(state, JSON.stringify({ ...current, fresh: false, empty: true, migrationExit: 0 }));
    await create();
    expect(readDeploymentRecord(home)!.schemaUpdates!.at(-1)).toMatchObject({ bookmark: BOOKMARK, schemaBefore: 0, schemaAfter: SERVER_SCHEMA_VERSION });
  });
});

it('GATE: a fresh provisioning receipt cannot exempt a populated database', async () => {
  await fixture({ fresh: true, freshPopulated: true }, async ({ home, create, calls }) => {
    fs.rmSync(deploymentRecordPath(home));
    await expect(create()).rejects.toThrow('the destination is not empty');
    expect(calls().some(({ args }) => args.includes('migrations'))).toBe(false);
  });
});

it('GATE: asynchronous durable-write failures refuse migrations', async () => {
  await fixture({}, async ({ root, home, calls }) => {
    await expect(applyCloudflareSchema({ accountId: ACCOUNT, mycoHome: home, configDir: root,
      record: readDeploymentRecord(home)!, persist: async () => {
        await Promise.resolve();
        throw new Error('fixture asynchronous durable write failed');
      },
    })).rejects.toThrow('could not durably record');
    expect(calls().some(({ args }) => args.includes('migrations'))).toBe(false);
  });
});

it('GATE: a populated database stamped zero is refused rather than treated as empty provisioning', async () => {
  await fixture({ fresh: true, freshPopulated: true, schema: '0' }, async ({ home, create, calls }) => {
    fs.rmSync(deploymentRecordPath(home));
    await expect(create()).rejects.toThrow('no valid schema version');
    expect(readDeploymentRecord(home)?.databaseId).toBe(OLD_WORKER);
    expect(calls().some(({ args }) => args.includes('migrations') || ((args[0] === 'vectorize' || args[0] === 'r2') && !args.includes('list')))).toBe(false);
  });
});

for(const fault of ['stamps','catalogue'])it(`publishes the Worker without disabling an active governor after a ${fault} read failure`,async()=>{
  await fixture({schema:String(SERVER_SCHEMA_VERSION),budgetReadFailure:fault},async({root,update,calls,reports})=>{
    const file=path.join(root,'schema.sqlite');
    const source=new Database(file);
    let before:unknown[]=[];
    try {
      await completeBudgetMigration(sqliteRelationalStore(source),100);
      before=source.query('SELECT key,value FROM schema_meta ORDER BY key').all();
    }finally{source.close();}
    await update();
    const db=new Database(file);
    try {
      expect(db.query('SELECT key,value FROM schema_meta ORDER BY key').all()).toEqual(before);
      expect(await readBudgetStatus(sqliteRelationalStore(db),Date.now())).toMatchObject({active:true,reason:null});
    }finally{db.close();}
    expect(reports.join(' / ')).toContain('Budget governor state not verified:');
    expect(reports.join(' / ')).not.toContain('Budget governor inactive:');
    expect(calls().filter(({args})=>args[0]==='deploy')).toHaveLength(1);
  });
});

for (const from of [94,101]) it(`refuses hosted ${from} before a concurrent old-Worker dispatch can prepare`, async () => {
  await fixture({schema:String(from)}, async ({root,home,calls,reports}) => {
    const recordBefore = readDeploymentRecord(home)!;
    let prepared = false;
    const live = path.join(root,'schema.sqlite');
    await withRecoveryDatabaseCopy(live,await fingerprintFile(live),async copy=>{
      await expect(applyCloudflareSchema({...{recovery:copy},accountId:ACCOUNT,mycoHome:home,configDir:root,
      record:readDeploymentRecord(home)!,persist:record=>writeDeploymentRecord(record,home),
      report:line=>reports.push(line),prepare:async record=>{
        prepared = true;
        const db = new Database(path.join(root,'schema.sqlite'));
        try {
          db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('race','Race',1)");
          db.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('race','Race','built-in',1,1)");
          db.exec("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at) VALUES('race','late','race','extract-curate','running',1,2)");
        } finally {db.close();}
        return record;
      },
    })).rejects.toThrow(THIN_LEARNING_STEPPING_STONE_REQUIRED);
    });
    expect(prepared).toBe(false);
    expect(reports).toEqual([THIN_LEARNING_STEPPING_STONE_REMEDY]);
    expect(readDeploymentRecord(home)).toEqual(recordBefore);
    expect(readDeploymentRecord(home)!.schemaUpdates).toEqual(recordBefore.schemaUpdates);
    expect(calls().some(({args})=>args.includes('time-travel'))).toBe(false);
    expect(calls().some(({args})=>args.includes('migrations')||args[0]==='deploy')).toBe(false);
    const db = new Database(path.join(root,'schema.sqlite'));
    try {
      expect(db.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({value:String(from)});
      expect(db.query('SELECT * FROM agent_runs').all()).toEqual([]);
    } finally {db.close();}
  });
});

const T = SERVER_SCHEMA_VERSION;
const liveVersion = (root: string) => {
  const db = new Database(path.join(root, 'schema.sqlite'), { readonly: true });
  try { return Number((db.query("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value); }
  finally { db.close(); }
};
const appliesOf = (calls: { args: string[] }[]) => calls.filter(({ args }) => args[0] === 'd1' && args[1] === 'migrations').length;

it('waits out an overloaded D1 between migration applies and completes the update without a rerun', async () => {
  await fixture({ schema: String(T - 4), liveSchema: true, overloadAt: [{ at: T - 2, reads: 1 }, { at: T - 1 }] }, async ({ root, home, update, reports }) => {
    const { summary, versionId } = await update();
    expect(summary).toMatchObject({ schema: 'applied', worker: 'applied', record: 'updated', schemaBefore: T - 4 });
    expect(versionId).toBe('22222222-2222-4333-8444-555555555555');
    expect(liveVersion(root)).toBe(T);
    expect(readDeploymentRecord(home)!.versionId).toBe(versionId);
    expect(readDeploymentRecord(home)!.schemaUpdates!.at(-1)).toMatchObject({ schemaBefore: T - 4, schemaAfter: T, appliedAt: expect.any(String) });
    const text = reports.join('\n');
    expect(text).toContain(`schema ${T - 3} of ${T}`);
    expect(text).toContain(`schema ${T - 2} of ${T}`);
    expect(text).toContain('reading the live schema');
    expect(text).not.toContain('Schema update stopped');
  });
});

it('completes when a migration commits but answers 7429 and the next file is overloaded once', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, overloadAt: [{ at: T - 2, commit: true }, { at: T - 1 }] }, async ({ root, home, update, reports }) => {
    const { summary } = await update();
    expect(summary).toMatchObject({ schema: 'applied', worker: 'applied', record: 'updated' });
    expect(liveVersion(root)).toBe(T);
    expect(readDeploymentRecord(home)!.schemaUpdates!.at(-1)).toMatchObject({ schemaBefore: T - 3, appliedAt: expect.any(String) });
    const text = reports.join('\n');
    expect(text).toContain(`schema ${T - 2} of ${T}`);
    expect(text).not.toContain('Schema update stopped');
  });
});

it('stops a D1 that stays overloaded with the live schema, the Worker left serving and the next command', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, applyOverloads: D1_OVERLOAD_RETRIES + 1 }, async ({ root, home, update, calls, reports, waits }) => {
    await expect(update()).rejects.toThrow('stayed overloaded (code 7429)');
    expect(waits).toHaveLength(D1_OVERLOAD_RETRIES);
    expect(appliesOf(calls())).toBe(D1_OVERLOAD_RETRIES + 1);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(liveVersion(root)).toBe(T - 3);
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: stopped: D1 overloaded (target ${T}; live schema ${T - 3})`);
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain(`Live schema ${T - 3} of ${T}`);
    expect(text).toContain(`The Worker was left on its old release`);
    expect(text).toContain(`version ${OLD_WORKER}`);
    expect(text).toContain(`It serves schema ${T - 3}, which is the live schema, so it keeps serving.`);
    expect(text).toContain('Next: wait a few minutes for D1\'s load to settle, then run: myco server update --target cloudflare');
    expect(text).not.toContain('outcome unknown');
  });
});

it('names a migration that fails twice on an answering D1 and says the old Worker refuses the live schema', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, overloadAt: [{ at: T - 1 }, { at: T - 1 }, { at: T - 1 }] }, async ({ root, home, update, calls, reports, waits }) => {
    const file = migrationFileName(SCHEMA_STEPS.find((step) => step.version === T - 1)!);
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    expect(waits.length).toBeLessThan(D1_OVERLOAD_RETRIES);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(liveVersion(root)).toBe(T - 2);
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: stopped: a migration exceeds D1 limits (target ${T}; live schema ${T - 2})`);
    expect(text).toContain(`Schema update stopped: migration ${file} failed twice`);
    expect(text).toContain(`It serves schema ${T - 3} only, so it refuses requests while the live schema is ${T - 2}.`);
    expect(text).toContain(`Next: a rerun stops at ${file} again.`);
    expect(text).toContain(`To put the database back on schema ${T - 3}, which the old Worker serves, restore bookmark ${BOOKMARK}`);
    expect(text).toContain(`wrangler d1 time-travel restore 'myco-server' --bookmark=${BOOKMARK}`);
  });
});

it('after two stopped updates against one Worker, recommends the bookmark at the schema that Worker serves', async () => {
  const second = '00000086-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  const repeated = Array.from({ length: 5 }, () => ({ at: T - 1 }));
  await fixture({ schema: String(T - 3), liveSchema: true, overloadAt: repeated }, async ({ home, state, update, reports }) => {
    const file = migrationFileName(SCHEMA_STEPS.find((step) => step.version === T - 1)!);
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    fs.writeFileSync(state, JSON.stringify({ ...saved, schema: String(T - 2), expectedBookmark: second, bookmarkOutput: JSON.stringify({ bookmark: second }) }));
    const firstRun = reports.length;
    await expect(update()).rejects.toThrow(`migration ${file} failed twice`);
    expect(readDeploymentRecord(home)!.schemaUpdates).toMatchObject([
      { bookmark: BOOKMARK, schemaBefore: T - 3, workerVersionBefore: OLD_WORKER },
      { bookmark: second, schemaBefore: T - 2, workerVersionBefore: OLD_WORKER },
    ]);
    const text = reports.slice(firstRun).join('\n');
    expect(text).toContain(`It serves schema ${T - 3} only, so it refuses requests while the live schema is ${T - 2}.`);
    expect(text).toContain(`To put the database back on schema ${T - 3}, which the old Worker serves, restore bookmark ${BOOKMARK}`);
    expect(text).toContain(`This update's own recovery point, bookmark ${second}, returns the database to schema ${T - 2}, which the old Worker does not serve`);
    expect(text).not.toContain(`schema ${T - 3}, which the old Worker serves, restore bookmark ${second}`);
  });
});

it('settles a failure other than overload once, as before, without waiting', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, migrationExit: 1, migrationError: 'internal error [code: 7500]' }, async ({ update, calls, reports, waits }) => {
    await expect(update()).rejects.toThrow('internal error [code: 7500]');
    expect(waits).toEqual([]);
    expect(appliesOf(calls())).toBe(1);
    const text = reports.join('\n');
    expect(text).toContain(`Schema: failed: not applied (target ${T}; live schema ${T - 3})`);
    expect(text).not.toContain('Schema update stopped');
    expect(text).not.toContain('overloaded');
  });
});

it('refuses to start on a D1 already overloaded, changing nothing', async () => {
  await fixture({ schema: String(T - 3), liveSchema: true, readOverloads: 1 }, async ({ home, update, calls, reports, waits }) => {
    const before = fs.readFileSync(deploymentRecordPath(home), 'utf8');
    await expect(update()).rejects.toThrow('overloaded (code 7429) before the update started; nothing was changed');
    expect(waits).toEqual([]);
    expect(fs.readFileSync(deploymentRecordPath(home), 'utf8')).toBe(before);
    expect(calls().some(({ args }) => args.includes('time-travel') || args.includes('migrations') || args[0] === 'deploy')).toBe(false);
    expect(reports.join('\n')).toContain('Nothing changed in Cloudflare; a rerun is safe');
  });
});
