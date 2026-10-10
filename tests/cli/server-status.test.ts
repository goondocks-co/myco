import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { cloudflareCredentialSource, readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';
import type { CommandRunner, RunOptions } from '@myco/server/runner.js';

const ACCOUNT = 'a'.repeat(32);
const RECORDED = '11111111-2222-4333-8444-555555555555';
const LIVE = '22222222-2222-4333-8444-555555555555';
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const AUTH_ERROR = 'Authentication error [code: 10000]';
let root: string;
let previous: Record<string, string | undefined>;
let cwd: string;
let calls: Array<{ args: readonly string[]; options?: RunOptions }>;
let schema: number;
let worker: string;
let failure: string | undefined;
let createVector: boolean;
let printed: string[];
let errors: string[];
let exitCode: number | undefined;
const log = console.log;
const error = console.error;
const exit = process.exit;

const runner: CommandRunner = {
  async run(command, args, options) {
    expect(command).toBe('npx');
    expect(args.slice(0, 2)).toEqual(['--no-install', 'wrangler']);
    expect(options?.cwd?.startsWith(root)).toBe(true);
    calls.push({ args: [...args], options });
    const text = args.slice(2).join(' ');
    if (failure !== undefined && text.startsWith(failure)) return { code: 1, stdout: '', stderr: AUTH_ERROR };
    let stdout = '';
    if (text === '--version') stdout = '4.126.0';
    else if (text === 'whoami') stdout = 'OAuth fixture';
    else if (text.startsWith('deployments list')) stdout = `Version ID: ${worker}`;
    else if (text.startsWith('d1 execute')) {
      const sql = args[args.indexOf('--command') + 1] ?? '';
      const rows = sql.includes('sqlite_master') ? [{ name: 'schema_meta' }]
        : sql.includes("key = 'version'") ? [{ value: String(schema) }] : [];
      stdout = JSON.stringify([{ success: true, results: rows }]);
    } else if (text.startsWith('d1 time-travel info')) stdout = JSON.stringify({ bookmark: BOOKMARK });
    else if (text.startsWith('d1 migrations apply')) schema = SERVER_SCHEMA_VERSION;
    else if (text.startsWith('vectorize list --json')) stdout = JSON.stringify(createVector ? [] : [{ name: 'myco-server-memory' }]);
    else if (text.startsWith('vectorize get')) stdout = JSON.stringify({ config: { dimensions: 1536, metric: 'cosine' } });
    else if (text.startsWith('vectorize list-metadata-index')) stdout = JSON.stringify(VECTOR_METADATA_FIELDS.map((propertyName) => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' })));
    else if (text.startsWith('vectorize create')) stdout = 'Created index';
    else if (text.startsWith('r2 bucket create')) return { code: 1, stdout: '', stderr: 'bucket already exists' };
    else if (text.startsWith('deploy ')) { worker = LIVE; stdout = `Current Version ID: ${LIVE}`; }
    else throw new Error(`Unexpected fake command: ${text}`);
    return { code: 0, stdout, stderr: '' };
  },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-server-status-'));
  const env: Record<string, string | undefined> = {
    HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config'),
    MYCO_HOME: path.join(root, 'myco'), TMPDIR: path.join(root, 'tmp'),
    CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_API_KEY: undefined, CLOUDFLARE_EMAIL: undefined,
  };
  previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else { fs.mkdirSync(value, { recursive: true }); process.env[key] = value; }
  }
  cwd = process.cwd();
  process.chdir(root);
  schema = SERVER_SCHEMA_VERSION - 1;
  worker = RECORDED;
  failure = undefined;
  createVector = false;
  calls = [];
  printed = [];
  errors = [];
  exitCode = undefined;
  console.log = (...parts) => { printed.push(parts.map(String).join(' ')); };
  console.error = (...parts) => { errors.push(parts.map(String).join(' ')); };
  process.exit = ((code?: number) => { exitCode = code; throw new Error('fixture exit'); }) as typeof process.exit;
  writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server',
    bucketName: 'myco-server-blobs', databaseId: RECORDED, storeId: 'f'.repeat(32),
    versionId: RECORDED, release: '2.0.0-alpha.1', deployedAt: '2026-10-08T12:00:00.000Z',
    url: 'https://recorded.example.com' });
});

afterEach(() => {
  console.log = log;
  console.error = error;
  process.exit = exit;
  process.chdir(cwd);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function drive(verb: string): Promise<string> {
  try { await run([verb, '--target', 'cloudflare'], { runner }); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
  return [...printed, ...errors].join('\n');
}
const count = (command: string): number => calls.filter((call) => call.args.slice(2).join(' ').startsWith(command)).length;

describe('Cloudflare status records and live observations', () => {
  it('shows a live disagreement without attributing the recorded release or URL to the live Worker', async () => {
    worker = LIVE;
    const record = readDeploymentRecord()!;
    writeDeploymentRecord({ ...record, schemaUpdates: [{ bookmark: BOOKMARK, schemaBefore: schema - 1,
      schemaAfter: schema, recordedAt: record.deployedAt, workerVersionBefore: RECORDED }] });
    const text = await drive('status');
    expect(text).toContain(`Worker (live): ${LIVE}`);
    expect(text).toContain(`Worker (recorded): ${RECORDED}`);
    expect(text).toContain('Release (recorded at last deploy): 2.0.0-alpha.1');
    expect(text).toContain(`Schema (live): ${schema}`);
    expect(text).toContain('URL (recorded): https://recorded.example.com');
    expect(text).toContain('URL (live): routing not checked');
    expect(text).toContain('The recorded release does not identify the live Worker');
    expect(text).toContain('Last schema update (attempted; completion not recorded)');
    expect(text).toContain(BOOKMARK);
    expect(exitCode).toBeUndefined();
  });

  it('shows an old release as unknown and a failed live lookup as unavailable', async () => {
    writeDeploymentRecord({ ...readDeploymentRecord()!, release: undefined });
    failure = 'deployments list';
    const text = await drive('status');
    expect(text).toContain('Worker (live): unavailable');
    expect(text).toContain('Workers Scripts Read');
    expect(text).toContain('Release (recorded at last deploy): unknown (not recorded)');
    expect(text).toContain(`Schema (live): ${schema}`);
    expect(text).not.toContain('Worker (live): not deployed');
    expect(count('deployments list')).toBe(1);
  });
});

describe('Cloudflare update evidence and credentials', () => {
  it('matches Wrangler API-key precedence and reports an incomplete key', async () => {
    expect(cloudflareCredentialSource({ CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_API_KEY: 'key', CLOUDFLARE_EMAIL: 'fixture@example.com' }))
      .toBe('CLOUDFLARE_API_KEY in the environment');
    expect(cloudflareCredentialSource({ CLOUDFLARE_API_TOKEN: ' ' })).toBe('CLOUDFLARE_API_TOKEN in the environment');
    process.env.CLOUDFLARE_API_KEY = 'fixture-private-value';
    const text = await drive('update');
    expect(text).toContain('Wrangler credential: OAuth login');
    expect(text).toContain('CLOUDFLARE_API_KEY is set without CLOUDFLARE_EMAIL');
    expect(count('whoami')).toBe(1);
  });

  for (const variable of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']) {
    it(`names ${variable}, its override and the Vectorize permission before refusing an unauthorized update`, async () => {
      process.env[variable] = 'fixture-private-value';
      if (variable === 'CLOUDFLARE_API_KEY') process.env.CLOUDFLARE_EMAIL = 'fixture@example.com';
      failure = 'vectorize list';
      const text = await drive('update');
      expect(text).toContain(`Wrangler credential: ${variable} in the environment`);
      expect(text).toContain('overrides the OAuth login');
      expect(text).toContain('Authentication error [code: 10000] on vectorize');
      expect(text).toContain('Vectorize Read');
      expect(text).toContain(ACCOUNT);
      expect(text).toContain('unset CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_KEY');
      expect(text).not.toContain('fixture-private-value');
      expect(text).toContain('Schema: not attempted');
      expect(text).toContain('Worker: not attempted');
      expect(text).toContain('Nothing changed in Cloudflare; a rerun is safe');
      expect(text).toContain(`Bookmark ${BOOKMARK} recorded in`);
      expect(count('vectorize list')).toBe(1);
      expect(count('d1 migrations')).toBe(0);
      expect(count('deploy ')).toBe(0);
      expect(count('whoami')).toBe(0);
      expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
      expect(exitCode).toBe(1);
    });
  }

  it('allows a CI token with the required permissions and records applied schema and release', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'fixture-private-value';
    const text = await drive('update');
    expect(text).toContain(`from 2.0.0-alpha.1/${SERVER_SCHEMA_VERSION - 1} to ${getPluginVersion()}/${SERVER_SCHEMA_VERSION}`);
    expect(text).toContain('Schema: applied');
    expect(text).toContain('Worker: applied');
    expect(text).toContain('Resources: r2 bucket myco-server-recovery: already exists');
    expect(readDeploymentRecord()?.release).toBe(getPluginVersion());
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeDefined();
    expect(exitCode).toBeUndefined();
    printed = [];
    expect(await drive('status')).toContain('Last schema update (applied)');
  });

  it('reports OAuth and D1 permission on a 10000 before reading the schema without retrying', async () => {
    failure = 'd1 execute';
    const text = await drive('update');
    expect(text).toContain('Wrangler credential: OAuth login');
    expect(text).toContain('Authentication error [code: 10000] on d1');
    expect(text).toContain('D1 Read');
    expect(text).toContain('Schema: not attempted');
    expect(text).toContain('No new recovery bookmark recorded');
    expect(count('d1 execute')).toBe(1);
  });

  it('reports resource changes even when preparation stops before migrations', async () => {
    createVector = true;
    failure = 'vectorize get';
    const text = await drive('update');
    expect(text).toContain('vectorize index myco-server-memory: applied');
    expect(text).toContain('Schema: not attempted');
    expect(text).toContain('Worker: not attempted');
    expect(text).not.toContain('Nothing changed');
    expect(count('d1 migrations')).toBe(0);
  });

  it('labels a failed migration attempted with an unknown outcome and keeps the recorded release', async () => {
    failure = 'd1 migrations';
    const text = await drive('update');
    expect(text).toContain('Schema: attempted; outcome unknown');
    expect(text).not.toContain('Schema: applied');
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain('An attempted change has an unknown outcome');
    expect(text).not.toContain('Nothing changed');
    expect(count('d1 migrations')).toBe(1);
    expect(count('deploy ')).toBe(0);
    expect(readDeploymentRecord()?.release).toBe('2.0.0-alpha.1');
  });

  it('reports the applied schema separately from a failed Worker upload', async () => {
    failure = 'deploy ';
    const text = await drive('update');
    expect(text).toContain(`from 2.0.0-alpha.1/${SERVER_SCHEMA_VERSION - 1} to unknown/${SERVER_SCHEMA_VERSION}`);
    expect(text).toContain('Schema: applied');
    expect(text).toContain('Worker: attempted; outcome unknown');
    expect(text).not.toContain('Worker: applied');
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeDefined();
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
  });

  it('does not claim a schema update when the live schema already matches', async () => {
    schema = SERVER_SCHEMA_VERSION;
    const text = await drive('update');
    expect(text).toContain('Schema: unchanged');
    expect(text).toContain('Worker: applied');
    expect(text).toContain('No new recovery bookmark recorded');
    expect(count('d1 migrations')).toBe(0);
  });
});
