import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { createCloudflareDeployment, updateCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { applyCloudflareSchema } from '@myco/server/cloudflare-schema.js';
import { restoreCloudflareDatabase } from '@myco/server/cloudflare-recovery-database.js';
import { VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';

const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const ACCOUNT = 'a'.repeat(32);
const OLD_WORKER = '11111111-2222-4333-8444-555555555555';

/** Only these local subprocesses answer the operator's Wrangler calls. */
const FAKE_WRANGLER = `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, cwd:process.cwd(), account:process.env.CLOUDFLARE_ACCOUNT_ID})+'\\n');
const out = (value) => console.log(JSON.stringify(value));
const command = args.slice(0,3).join(' ');
if (args[0] === '--version') console.log('4.126.0');
else if (args[0] === 'whoami') console.log('fixture operator');
else if (command === 'd1 list --json') out(state.fresh ? [] : [{name:'myco-server',uuid:'${OLD_WORKER}'}]);
else if (command === 'd1 create myco-server') console.log('database_id = "${OLD_WORKER}"');
else if (command === 'd1 execute myco-server') {
  if (state.destination) {
    const {Database} = require('bun:sqlite');
    const db = new Database(state.destination);
    try {
      if (args.includes('--file')) {
        const sql = fs.readFileSync(args[args.indexOf('--file')+1],'utf8');
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS d1_migrations')) {
          const gate = JSON.parse(fs.readFileSync(process.env.FAKE_RECORD,'utf8')).schemaUpdates?.at(-1);
          if (Number(state.schema) < state.target && gate?.bookmark !== state.expectedBookmark) process.exit(9);
        }
        db.exec(sql);
        if (state.loseImportReply) {
          fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify({...state,loseImportReply:false}));
          process.exit(1);
        }
      }
      out([{success:true,results:args.includes('--command') ? db.query(args[args.indexOf('--command')+1]).all() : []}]);
    } finally {db.close();}
  } else out([{success:true,results:args[args.indexOf('--command')+1].includes('sqlite_master') ? ((state.fresh && !state.freshPopulated) || state.empty ? [] : [{name:'schema_meta'}]) : [{value:state.schema}]}]);
}
else if (command === 'd1 time-travel info') {
  if (state.bookmarkExit) process.exit(state.bookmarkExit);
  console.log(state.bookmarkOutput);
  if (state.persistFail) {
    fs.rmSync(process.env.FAKE_RECORD);
    fs.mkdirSync(process.env.FAKE_RECORD);
  }
} else if (command === 'd1 migrations apply') {
  const record = JSON.parse(fs.readFileSync(process.env.FAKE_RECORD,'utf8'));
  const gate = record.schemaUpdates?.at(-1);
  if (!state.fresh && (!gate || gate.bookmark !== state.expectedBookmark || gate.schemaBefore !== Number(state.schema) || gate.schemaAfter !== state.target || gate.workerVersionBefore !== state.workerBefore)) {
    console.error('migration ran before durable recovery point'); process.exit(9);
  }
  if (state.migrationExit) process.exit(state.migrationExit);
  if (state.destination) {
    const {Database} = require('bun:sqlite');
    const db = new Database(state.destination);
    db.query("UPDATE schema_meta SET value=? WHERE key='version'").run(String(state.target));
    db.close();
  }
} else if (command === 'vectorize list --json') out([{name:'myco-server-memory'}]);
else if (command === 'vectorize get myco-server-memory') out({config:{dimensions:1536,metric:'cosine'}});
else if (args[0] === 'vectorize' && args[1] === 'list-metadata-index') out(state.metadata);
else if (command === 'r2 bucket create') console.log('Created fixture bucket');
else if (args[0] === 'secrets-store' && args[1] === 'store' && args[2] === 'list') console.log('${'f'.repeat(32)}');
else if (args[0] === 'secrets-store' && args[1] === 'secret' && args[2] === 'list') console.log('│ Name │ ID │\\n│ myco-secret-wrap-key │ '+ 'e'.repeat(32) +' │');
else if (args[0] === 'secrets-store' && args[1] === 'secret' && args[2] === 'create') console.log('Created fixture secret');
else if (args[0] === 'secret' && args[1] === 'list') out([{name:'SESSION_SECRET',type:'secret_text'}]);
else if (args[0] === 'deploy') console.log('Current Version ID: 22222222-2222-4333-8444-555555555555');
else { console.error('unexpected fake command: '+args.join(' ')); process.exit(8); }
`;

type Call = { args: string[]; cwd: string; account?: string };

async function fixture(
  overrides: Record<string, unknown>,
  run: (f: { home: string; root: string; create: () => Promise<unknown>; state: string; update: () => Promise<unknown>; calls: () => Call[]; reports: string[] }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-update-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'wrangler'), FAKE_WRANGLER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\n[ "$1" = "--no-install" ] || exit 7\nshift\nexec "$@"\n', { mode: 0o755 });
  const state = path.join(root, 'state.json');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(state, JSON.stringify({ schema: String(SERVER_SCHEMA_VERSION - 1), target: SERVER_SCHEMA_VERSION,
    workerBefore: OLD_WORKER, expectedBookmark: BOOKMARK, bookmarkOutput: JSON.stringify({ bookmark: BOOKMARK }),
    metadata: VECTOR_METADATA_FIELDS.map((propertyName) => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' })), ...overrides }));
  writeDeploymentRecord({ accountId: ACCOUNT, databaseName: 'myco-server', databaseId: OLD_WORKER,
    workerName: 'myco-server', bucketName: 'myco-server-blobs', versionId: OLD_WORKER, deployedAt: 'fixture' }, home);
  const values = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_STATE: state, FAKE_LOG: log,
    FAKE_RECORD: deploymentRecordPath(home), CLOUDFLARE_API_TOKEN: undefined };
  const held = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const reports: string[] = [];
  try {
    await run({ home, root, state, reports,
      create: () => createCloudflareDeployment({ accountId: ACCOUNT, mycoHome: home, report: (line) => reports.push(line) }),
      update: () => updateCloudflareDeployment({ accountId: ACCOUNT, mycoHome: home, report: (line) => reports.push(line) }),
      calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call),
    });
  } finally {
    for (const [key, value] of Object.entries(held)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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
  });
});

it('GATE: failed, missing and invalid bookmarks leave deployment data and remote resources unchanged', async () => {
  for (const overrides of [
    { bookmarkExit: 1 }, { bookmarkOutput: '' }, { bookmarkOutput: '{}' },
    { bookmarkOutput: JSON.stringify({ bookmark: `${BOOKMARK}; echo invalid` }) },
    { bookmarkOutput: JSON.stringify({ bookmark: 'short' }) },
  ]) await fixture(overrides, async ({ home, update, calls }) => {
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
  await fixture({ migrationExit: 1 }, async ({ home, update, calls }) => {
    await expect(update()).rejects.toThrow();
    expect(readDeploymentRecord(home)!.versionId).toBe(OLD_WORKER);
    expect(readDeploymentRecord(home)!.schemaUpdates).toHaveLength(1);
    await expect(update()).rejects.toThrow();
    expect(readDeploymentRecord(home)!.schemaUpdates).toHaveLength(2);
    expect(calls().some(({ args }) => args[0] === 'deploy')).toBe(false);
  });
});

it('refuses unreadable or newer live schemas before requesting recovery or changing remote resources', async () => {
  for (const schema of ['', 'NaN', '1.5', String(SERVER_SCHEMA_VERSION + 1)]) {
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
});

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
    for (const step of SCHEMA_STEPS.filter((step) => step.version < SERVER_SCHEMA_VERSION)) source.exec(step.statements.join(';\n'));
    source.exec("INSERT INTO schema_meta VALUES('fixture_note','preserved')");
    source.close();
    const destination = path.join(root, 'replacement.sqlite');
    const journal = path.join(root, 'recovery.json');
    const record = readDeploymentRecord(home)!;
    const initial = JSON.parse(fs.readFileSync(state, 'utf8'));
    const saveState = (extra: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify({ ...initial, destination, ...extra }));
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


it('GATE: a failed durable deployment-record write refuses migrations after obtaining the bookmark', async () => {
  for (const verb of ['update', 'create'] as const) await fixture({ persistFail: true }, async (f) => {
    await expect(f[verb]()).rejects.toThrow('could not durably record');
    expect(f.calls().some(({ args }) => args.includes('time-travel'))).toBe(true);
    expect(f.calls().some(({ args }) => args.includes('migrations') || args[0] === 'deploy')).toBe(false);
  });
});

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
