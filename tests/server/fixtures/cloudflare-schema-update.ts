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

export const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
export const ACCOUNT = 'a'.repeat(32);
export const OLD_WORKER = '11111111-2222-4333-8444-555555555555';

/** Only these local subprocesses answer the operator's Wrangler calls. */
export const FAKE_WRANGLER = `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, cwd:process.cwd(), account:process.env.CLOUDFLARE_ACCOUNT_ID})+'\\n');
const out = (value) => console.log(JSON.stringify(value));
const command = args.slice(0,3).join(' ');
const save = (next) => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(next));
const OVERLOADED = 'D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]';
if (args[0] === '--version') console.log('4.126.0');
else if (args[0] === 'whoami') console.log('fixture operator');
else if (command === 'd1 list --json') out(state.fresh ? [] : [{name:'myco-server',uuid:'${OLD_WORKER}'}]);
else if (command === 'd1 create myco-server') console.log('database_id = "${OLD_WORKER}"');
else if (command === 'd1 execute myco-server') {
  const statement=args[args.indexOf('--command')+1] ?? '';
  if(state.readOverloads>0 && statement.includes('sqlite_master')) {save({...state,readOverloads:state.readOverloads-1});console.error(OVERLOADED);process.exit(1);}
  if((state.budgetReadFailure==='stamps'&&statement.startsWith('SELECT key,value'))||(state.budgetReadFailure==='catalogue'&&statement.startsWith('SELECT name,sql'))) {
    console.error('fixture transient completion read');process.exit(1);
  }
  if(state.budgetCountFailure && statement.startsWith('SELECT COUNT(*) AS n FROM agent_')) {
    if(state.budgetCountFailure==='error') {console.error('fixture count unavailable');process.exit(1);}
    out([{success:true,results:[]}]);process.exit(0);
  }
  if(!state.destination && !state.liveSchema && /SELECT value FROM schema_meta WHERE key ?= ?'version'/.test(statement)) {out([{success:true,results:[{value:state.schema}]}]);process.exit(0);}
  if (state.destination || state.schemaDatabase) {
    const {Database} = require('bun:sqlite');
    const db = new Database(state.destination || state.schemaDatabase);
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
  if (state.migrationExit) {console.error(state.migrationError ?? 'fixture migration failure');process.exit(state.migrationExit);}
  if (state.applyOverloads>0) {save({...state,applyOverloads:state.applyOverloads-1});console.error(OVERLOADED);process.exit(1);}
  if (state.destination || state.schemaDatabase) {
    const {Database} = require('bun:sqlite');
    const db = new Database(state.destination || state.schemaDatabase);
    const exists=db.query("SELECT 1 FROM sqlite_master WHERE name='schema_meta'").get();
    const current=exists?Number(db.query("SELECT value FROM schema_meta WHERE key='version'").get()?.value ?? 0):0;
    for(const file of fs.readdirSync(state.migrationsRoot).filter(name=>name.endsWith('.json')).sort()) {
      const version=Number(file.split('.')[0]);
      const overload=(state.overloadAt??[]).findIndex(entry=>entry.at===version);
      const applyFile=()=>db.transaction(()=>{for(const statement of JSON.parse(fs.readFileSync(state.migrationsRoot+'/'+file,'utf8')))db.exec(statement);})();
      if(version>current&&overload>=0) {
        if(state.overloadAt[overload].commit)applyFile();
        db.close();
        save({...state,overloadAt:state.overloadAt.filter((_,index)=>index!==overload),readOverloads:state.overloadAt[overload].reads??0});
        console.log('Migrations to be applied:');console.error(OVERLOADED);process.exit(1);
      }
      if(version>current)applyFile();
    }
    if(!state.destination)fs.writeFileSync(process.env.FAKE_STATE,JSON.stringify({...state,schema:String(state.target)}));
    db.close();
  }
} else if (command === 'vectorize list --json') out([{name:'myco-server-memory'}]);
else if (command === 'vectorize get myco-server-memory') out({config:{dimensions:1536,metric:'cosine'}});
else if (args[0] === 'vectorize' && args[1] === 'list-metadata-index') out(state.metadata);
else if (command === 'r2 bucket create') console.log('Created fixture bucket');
else if (command === 'r2 bucket list') console.log('');
else if (args[0] === 'secrets-store' && args[1] === 'store' && args[2] === 'list') console.log('${'f'.repeat(32)}');
else if (args[0] === 'secrets-store' && args[1] === 'secret' && args[2] === 'list') console.log('│ Name │ ID │\\n│ myco-secret-wrap-key │ '+ 'e'.repeat(32) +' │');
else if (args[0] === 'secrets-store' && args[1] === 'secret' && args[2] === 'create') console.log('Created fixture secret');
else if (args[0] === 'secret' && args[1] === 'list') out([{name:'SESSION_SECRET',type:'secret_text'}]);
else if (args[0] === 'deploy') console.log('Current Version ID: 22222222-2222-4333-8444-555555555555');
else if (args[0] === 'versions' && args[1] === 'upload') console.log('Worker Version ID: 22222222-2222-4333-8444-555555555555');
else if (args[0] === 'versions' && args[1] === 'deploy') console.log('Deployed fixture version');
else if (args[0] === 'triggers' && args[1] === 'deploy') console.log('Applied fixture triggers');
else { console.error('unexpected fake command: '+args.join(' ')); process.exit(8); }
`;

type Call = { args: string[]; cwd: string; account?: string };

// One schema image and one migration directory per process; each case copies the image.
const schemaImages = new Map<string, string>();
let migrationDir: string | undefined;
const sharedMigrations = (): string => migrationDir ??= SCHEMA_STEPS.reduce((dir, step) => (fs.writeFileSync(path.join(dir, `${String(step.version).padStart(4, '0')}.json`), JSON.stringify(step.statements)), dir), fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-migrations-')));

/** Copies this process's schema image at `version`. `population` keeps the fixture's extra table. */
export function copySchemaDatabase(version: number, destination: string, kind: 'bare' | 'population' = 'bare'): void {
  const key = `${kind}:${SCHEMA_STEPS.reduce((max, step) => step.version <= version && step.version > max ? step.version : max, -1)}`;
  let image = schemaImages.get(key);
  if (!image) {
    const database = new Database(image = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-image-')), 'schema.sqlite'));
    try {
      if (kind === 'population') database.exec('CREATE TABLE fixture_population(id INTEGER)');
      for (const step of SCHEMA_STEPS) if (step.version <= version) database.exec(step.statements.join(';\n'));
    } finally { database.close(); }
    schemaImages.set(key, image);
  }
  fs.copyFileSync(image, destination);
}

export async function fixture(
  overrides: Record<string, unknown>,
  run: (f: { home: string; root: string; create: () => Promise<unknown>; state: string; update: () => Promise<Awaited<ReturnType<typeof updateCloudflareDeployment>>>; calls: () => Call[]; reports: string[]; waits: number[] }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-update-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'wrangler'), FAKE_WRANGLER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\n[ "$1" = "--no-install" ] || exit 7\nshift\nexec "$@"\n', { mode: 0o755 });
  const version=Number(overrides.schema ?? SERVER_SCHEMA_VERSION-1);
  const empty=overrides.empty===true || (overrides.fresh===true && overrides.freshPopulated!==true);
  const schemaDatabase=path.join(root,'schema.sqlite');
  if(empty){const database=new Database(schemaDatabase);database.close();}else copySchemaDatabase(version,schemaDatabase,'population');
  const migrationsRoot=sharedMigrations();
  const state = path.join(root, 'state.json');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(state, JSON.stringify({ schema: String(SERVER_SCHEMA_VERSION - 1), target: SERVER_SCHEMA_VERSION,
    workerBefore: OLD_WORKER, expectedBookmark: BOOKMARK, bookmarkOutput: JSON.stringify({ bookmark: BOOKMARK }),
    schemaDatabase,migrationsRoot,metadata: VECTOR_METADATA_FIELDS.map((propertyName) => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' })), ...overrides }));
  writeDeploymentRecord({ accountId: ACCOUNT, databaseName: 'myco-server', databaseId: OLD_WORKER,
    workerName: 'myco-server', bucketName: 'myco-server-blobs', versionId: OLD_WORKER, deployedAt: 'fixture' }, home);
  const values = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_STATE: state, FAKE_LOG: log,
    FAKE_RECORD: deploymentRecordPath(home), CLOUDFLARE_API_TOKEN: undefined };
  const held = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const reports: string[] = [];
  const waits: number[] = [];
  const overloadRetry = { sleep: async (ms: number) => { waits.push(ms); } };
  try {
    await run({ home, root, state, reports, waits,
      create: () => createCloudflareDeployment({ accountId: ACCOUNT, mycoHome: home, report: (line) => reports.push(line), overloadRetry }),
      update: () => updateCloudflareDeployment({ readRetry: { sleep: async () => {} }, accountId: ACCOUNT, mycoHome: home, report: (line) => reports.push(line), overloadRetry }),
      calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call),
    });
  } finally {
    for (const [key, value] of Object.entries(held)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
