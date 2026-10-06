import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { updateCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';

const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const ACCOUNT = 'a'.repeat(32);
const OLD_WORKER = '11111111-2222-4333-8444-555555555555';

/** Only these local subprocesses answer the operator's Wrangler calls. */
const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, cwd:process.cwd(), account:process.env.CLOUDFLARE_ACCOUNT_ID})+'\\n');
const out = (value) => console.log(JSON.stringify(value));
const command = args.slice(0,3).join(' ');
if (args[0] === '--version') console.log('4.126.0');
else if (args[0] === 'whoami') console.log('fixture operator');
else if (command === 'd1 execute myco-server') out([{success:true,results:[{value:state.schema}]}]);
else if (command === 'd1 time-travel info') {
  if (state.bookmarkExit) process.exit(state.bookmarkExit);
  console.log(state.bookmarkOutput);
} else if (command === 'd1 migrations apply') {
  const record = JSON.parse(fs.readFileSync(process.env.FAKE_RECORD,'utf8'));
  const gate = record.schemaUpdates?.at(-1);
  if (!gate || gate.bookmark !== state.expectedBookmark || gate.schemaBefore !== Number(state.schema) || gate.schemaAfter !== state.target || gate.workerVersionBefore !== '${OLD_WORKER}') {
    console.error('migration ran before durable recovery point'); process.exit(9);
  }
  if (state.migrationExit) process.exit(state.migrationExit);
} else if (command === 'vectorize list --json') out([{name:'myco-server-memory'}]);
else if (command === 'vectorize get myco-server-memory') out({config:{dimensions:1536,metric:'cosine'}});
else if (args[0] === 'vectorize' && args[1] === 'list-metadata-index') out(state.metadata);
else if (command === 'r2 bucket create') console.log('Created fixture bucket');
else if (args[0] === 'deploy') console.log('Current Version ID: 22222222-2222-4333-8444-555555555555');
else { console.error('unexpected fake command: '+args.join(' ')); process.exit(8); }
`;

type Call = { args: string[]; cwd: string; account?: string };

async function fixture(
  overrides: Record<string, unknown>,
  run: (f: { home: string; update: () => Promise<unknown>; calls: () => Call[]; reports: string[] }) => Promise<void>,
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
    expectedBookmark: BOOKMARK, bookmarkOutput: JSON.stringify({ bookmark: BOOKMARK }),
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
    await run({ home, reports,
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
  await fixture({ schema: String(SERVER_SCHEMA_VERSION), bookmarkExit: 1 }, async ({ home, update, calls }) => {
    await update();
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
