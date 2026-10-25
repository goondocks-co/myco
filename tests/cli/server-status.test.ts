import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { cloudflareCredentialSource, deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';
import type { CommandRunner, RunOptions } from '@myco/server/runner.js';
import { budgetD1Database,budgetD1Reply } from '../server/helpers/budget-d1.js';

const ACCOUNT = 'a'.repeat(32);
const RECORDED = '11111111-2222-4333-8444-555555555555';
const LIVE = '22222222-2222-4333-8444-555555555555';
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const PRIVATE_TOKEN = 'q7Zp9Kv2Mx8Rn5Wy3Hd6Ts4Ua1Bc0LfQ';
const AUTH_ERROR = 'Authentication error [code: 10000]';
let root: string;
let previous: Record<string, string | undefined>;
let cwd: string;
let calls: Array<{ args: readonly string[]; options?: RunOptions }>;
let schema: number;
let budgetDb:ReturnType<typeof budgetD1Database>;
let worker: string;
let failure: string | undefined;
let createVector: boolean;
let readOnlyRecord: boolean;
let failureMessage: string;
let schemaOnMigrationFailure: number | undefined;
let schemaProbeFails: boolean;
let budgetCountUnavailable:boolean;
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
    if (failure !== undefined && text.startsWith(failure)) {
      if (text.startsWith('d1 migrations') && schemaOnMigrationFailure !== undefined) schema = schemaOnMigrationFailure;
      return { code: 1, stdout: '', stderr: failureMessage };
    }
    let stdout = '';
    if (text === '--version') stdout = '4.126.0';
    else if (text === 'whoami') stdout = 'OAuth fixture';
    else if(text==='auth token --json')stdout=JSON.stringify({type:'api_token',token:PRIVATE_TOKEN});
    else if (text.startsWith('secret list')) stdout = '[]';
    else if (text.startsWith('deployments list')) stdout = `Version ID: ${worker}`;
    else if (text.startsWith('d1 execute')) {
      if (schemaProbeFails && calls.some((call) => call.args.includes('migrations'))) {
        return { code: 1, stdout: '', stderr: 'live schema probe unavailable' };
      }
      const sql = args[args.indexOf('--command') + 1] ?? '';
      if(budgetCountUnavailable&&sql.startsWith('SELECT COUNT(*) AS n FROM agent_'))return {code:0,stdout:JSON.stringify([{success:true,results:[]}]),stderr:''};
      const budget=budgetD1Reply(budgetDb,sql);
      if(budget!==undefined)return budget;
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
    else if (text.startsWith('deploy ')) {
      worker = LIVE; stdout = `Current Version ID: ${LIVE}`;
      if (readOnlyRecord) fs.chmodSync(path.dirname(deploymentRecordPath()), 0o500);
    }
    else throw new Error(`Unexpected fake command: ${text}`);
    return { code: 0, stdout, stderr: '' };
  },
};

const fetchD1:typeof fetch=async(_input,init)=>{
  const body=JSON.parse(String(init?.body)) as {sql:string;params?:unknown[]};
  const rows=budgetDb.query(body.sql).all(...(body.params??[]).map(value=>{
    if(value===null||typeof value==='string'||typeof value==='number')return value;
    throw new Error('Unexpected fake D1 binding');
  }));
  return Response.json({success:true,result:[{success:true,results:rows,meta:{changes:0}}]});
};

beforeEach(() => {
  budgetDb=budgetD1Database();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-server-status-'));
  const env: Record<string, string | undefined> = {
    HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config'),
    MYCO_HOME: path.join(root, 'myco'), TMPDIR: path.join(root, 'tmp'),
    CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_API_KEY: undefined, CLOUDFLARE_EMAIL: undefined,
    CF_API_TOKEN: undefined, CF_API_KEY: undefined, CF_EMAIL: undefined,
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
  readOnlyRecord = false;
  failureMessage = AUTH_ERROR;
  schemaOnMigrationFailure = undefined;
  schemaProbeFails = false;
  budgetCountUnavailable=false;
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
  budgetDb.close();
  console.log = log;
  console.error = error;
  process.exit = exit;
  if (readOnlyRecord) fs.chmodSync(path.dirname(deploymentRecordPath()), 0o700);
  process.chdir(cwd);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function drive(verb: string): Promise<string> {
  try { await run([verb, '--target', 'cloudflare'], { runner,fetchImpl:fetchD1 }); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
  return [...printed, ...errors].join('\n');
}
function expectNoTokenFragments(text: string): void {
  for (let index = 0; index <= PRIVATE_TOKEN.length - 4; index++) {
    expect(text).not.toContain(PRIVATE_TOKEN.slice(index, index + 4));
  }
}
const count = (command: string): number => calls.filter((call) => call.args.slice(2).join(' ').startsWith(command)).length;

describe('Cloudflare status records and live observations', () => {
  it('prints the recorded budget refusal after an update publishes its Worker',async()=>{
    budgetCountUnavailable=true;
    expect(await drive('update')).toContain('Budget governor inactive:');
    expect(worker).toBe(LIVE);
    process.env.CLOUDFLARE_API_TOKEN=PRIVATE_TOKEN;
    printed.length=0;errors.length=0;
    await drive('status');
    expect(printed.join('\n')).toContain('budget preflight returned no valid count');
    expect(printed.join('\n')).toContain('inactive');
    expect(printed.join('\n')).not.toContain('Daily work budget unavailable:');
  });
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
    expect(text).not.toContain('URL (live)');
    expect(text).toContain('The recorded release does not identify the live Worker');
    expect(text).toContain('Last schema update (completed; confirmed by live schema)');
    expect(text).toContain(BOOKMARK);
    expect(exitCode).toBeUndefined();
  });

  it('keeps an unconfirmed label when the live schema differs or cannot be read', async () => {
    const record = readDeploymentRecord()!;
    writeDeploymentRecord({ ...record, schemaUpdates: [{ bookmark: BOOKMARK, schemaBefore: schema,
      schemaAfter: schema + 1, recordedAt: record.deployedAt, workerVersionBefore: RECORDED }] });
    expect(await drive('status')).toContain('recovery point recorded; migration not confirmed');
    failure = 'd1 execute';
    expect(await drive('status')).toContain('recovery point recorded; migration not confirmed');
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
    process.env.CLOUDFLARE_API_KEY = PRIVATE_TOKEN;
    const text = await drive('update');
    expect(text).toContain('Wrangler credential: OAuth login');
    expect(text).toContain('CLOUDFLARE_API_KEY is set without CLOUDFLARE_EMAIL');
    expect(count('whoami')).toBe(1);
  });

  for (const variable of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY']) {
    it(`names ${variable}, its override and the Vectorize permission before refusing an unauthorized update`, async () => {
      process.env[variable] = PRIVATE_TOKEN;
      if (variable.endsWith('API_KEY')) process.env[variable === 'CF_API_KEY' ? 'CF_EMAIL' : 'CLOUDFLARE_EMAIL'] = 'fixture@example.com';
      failure = 'vectorize list';
      failureMessage = `A request to the Cloudflare API (/accounts/${ACCOUNT}/vectorize/indexes?token=${PRIVATE_TOKEN}) failed.
${AUTH_ERROR}
Are you missing the \`User->Memberships->Read\` permission?
Private debug: ${PRIVATE_TOKEN}`;
      const text = await drive('update');
      expect(text).toContain(`Wrangler credential: ${variable} in the environment`);
      expect(text).toContain('overrides the OAuth login');
      expect(text).toContain('Authentication error [code: 10000] on vectorize');
      expect(text).toContain('Vectorize Read');
      expect(text).toContain(`Endpoint: /accounts/${ACCOUNT}/vectorize/indexes.`);
      expect(text).toContain('User->Memberships->Read');
      expect(text).toContain(ACCOUNT);
      expect(text).toContain('unset CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_KEY');
      expectNoTokenFragments(text);
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

  it('uses canonical names when present, including empty values, before deprecated aliases', () => {
    expect(cloudflareCredentialSource({ CF_API_TOKEN: PRIVATE_TOKEN })).toBe('CF_API_TOKEN in the environment');
    expect(cloudflareCredentialSource({ CF_API_TOKEN: PRIVATE_TOKEN, CLOUDFLARE_API_TOKEN: '' })).toBe('OAuth login');
    expect(cloudflareCredentialSource({ CF_API_TOKEN: PRIVATE_TOKEN, CLOUDFLARE_API_TOKEN: 'canonical' })).toBe('CLOUDFLARE_API_TOKEN in the environment');
    expect(cloudflareCredentialSource({ CF_API_KEY: PRIVATE_TOKEN, CF_EMAIL: 'fixture@example.com', CLOUDFLARE_API_TOKEN: 'token' })).toBe('CF_API_KEY in the environment');
    expect(cloudflareCredentialSource({ CF_API_KEY: PRIVATE_TOKEN, CF_EMAIL: 'fixture@example.com', CLOUDFLARE_API_KEY: '' })).toBe('OAuth login');
    expect(cloudflareCredentialSource({ CF_API_KEY: PRIVATE_TOKEN, CF_EMAIL: 'fixture@example.com', CLOUDFLARE_EMAIL: '' })).toBe('OAuth login');
    expect(cloudflareCredentialSource({ CLOUDFLARE_API_KEY: PRIVATE_TOKEN, CF_EMAIL: 'fixture@example.com' })).toBe('CLOUDFLARE_API_KEY in the environment');
    expect(cloudflareCredentialSource({ CLOUDFLARE_API_KEY: PRIVATE_TOKEN, CF_API_KEY: 'alias', CLOUDFLARE_EMAIL: 'canonical@example.com', CF_EMAIL: 'alias@example.com' })).toBe('CLOUDFLARE_API_KEY in the environment');
  });

  it('warns about an incomplete deprecated API key using its actual variable names', async () => {
    process.env.CF_API_KEY = PRIVATE_TOKEN;
    process.env.CF_EMAIL = '';
    const text = await drive('update');
    expect(text).toContain('CF_API_KEY is set without CF_EMAIL');
    expect(text).toContain('Wrangler credential: OAuth login');
    expect(count('whoami')).toBe(1);
    expectNoTokenFragments(text);
  });

  it('reports that the Worker is live when publishing the local record fails', async () => {
    readOnlyRecord = true;
    const text = await drive('update');
    expect(worker).toBe(LIVE);
    expect(text).toContain('Schema: applied');
    expect(text).toContain('Worker: applied');
    expect(text).toContain('Local deployment record: not updated');
    expect(text).toContain('The Worker is live; the local record was not updated; rerun myco server update');
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
    expect(readDeploymentRecord()?.release).toBe('2.0.0-alpha.1');
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeDefined();
    expect(exitCode).toBe(1);
  });

  for (const command of ['vectorize create', 'd1 migrations']) {
    it(`labels a 10000 refusal on ${command} as not applied and safe to rerun`, async () => {
      createVector = command === 'vectorize create';
      failure = command;
      const text = await drive('update');
      expect(text).toContain(command === 'vectorize create' ? 'vectorize index myco-server-memory: refused: not applied' : 'Schema: failed: not applied');
      expect(text).not.toContain('outcome unknown');
      expect(text).toContain('Nothing changed in Cloudflare; a rerun is safe');
      expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
      expect(count(command)).toBe(1);
      expect(count('deploy ')).toBe(0);
    });
  }

  it('allows a CI token with the required permissions and records applied schema and release', async () => {
    process.env.CLOUDFLARE_API_TOKEN = PRIVATE_TOKEN;
    const text = await drive('update');
    expect(text).toContain(`from 2.0.0-alpha.1/${SERVER_SCHEMA_VERSION - 1} to ${getPluginVersion()}/${SERVER_SCHEMA_VERSION}`);
    expect(text).toContain('Schema: applied');
    expect(text).toContain('Worker: applied');
    expect(text).toContain('Local deployment record: updated');
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
    failureMessage = 'connection closed before acknowledgement';
    schemaProbeFails = true;
    const text = await drive('update');
    expect(text).toContain('Schema: attempted; outcome unknown');
    expect(text).not.toContain('Schema: applied');
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain('An attempted change has an unknown outcome');
    expect(text).not.toContain('Nothing changed');
    expect(count('d1 migrations')).toBe(1);
    expect(count('deploy ')).toBe(0);
    expect(readDeploymentRecord()?.release).toBe('2.0.0-alpha.1');
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
    expect(text).toContain('Live schema confirmation failed:');
    expect(text).toContain('live schema probe unavailable');
    expect(text).toContain(failureMessage);
    expect(exitCode).toBe(1);
  });

  for (const steps of [1, 2]) {
    it(`continues after a failed ${steps}-step migration apply when live schema confirms the target`, async () => {
      schema = SERVER_SCHEMA_VERSION - steps;
      const before = schema;
      failure = 'd1 migrations';
      failureMessage = 'D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]';
      schemaOnMigrationFailure = SERVER_SCHEMA_VERSION;
      const text = await drive('update');
      expect(text).toContain(`from 2.0.0-alpha.1/${before} to ${getPluginVersion()}/${SERVER_SCHEMA_VERSION}`);
      expect(text).toContain('Schema: applied');
      expect(text).toContain('Worker: applied');
      expect(text).toContain('Local deployment record: updated');
      expect(printed.filter((line) => line.includes('live schema confirmed'))).toHaveLength(1);
      expect(text).toContain(`${failureMessage}; live schema confirmed ${SERVER_SCHEMA_VERSION}`);
      expect(text).not.toContain('outcome unknown');
      expect(calls.filter(({args})=>args.includes('execute')&&/^SELECT (name FROM sqlite_master|value FROM schema_meta WHERE key)/.test(args[args.indexOf('--command')+1]??'')).length).toBe(4);
      expect(count('d1 migrations')).toBe(1);
      expect(count('deploy ')).toBe(1);
      expect(readDeploymentRecord()).toMatchObject({ release: getPluginVersion(), versionId: LIVE,
        schemaUpdates: [{ bookmark: BOOKMARK, schemaBefore: before, schemaAfter: SERVER_SCHEMA_VERSION, workerVersionBefore: RECORDED }] });
      expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeDefined();
      expect(exitCode).toBeUndefined();
    });

    it(`reports a failed ${steps}-step apply with nothing applied when live schema is unchanged`, async () => {
      schema = SERVER_SCHEMA_VERSION - steps;
      const before = schema;
      failure = 'd1 migrations';
      failureMessage = 'D1 storage timeout [code: 7429]';
      const text = await drive('update');
      expect(text).toContain(`from 2.0.0-alpha.1/${before} to 2.0.0-alpha.1/${before}`);
      expect(text).toContain(`Schema: failed: not applied (target ${SERVER_SCHEMA_VERSION}; live schema ${before})`);
      expect(text).toContain('Worker: not attempted');
      expect(text).toContain('Local deployment record: not updated');
      expect(text).toContain('Nothing changed in Cloudflare; a rerun is safe');
      expect(text).toContain(failureMessage);
      expect(text).not.toContain('outcome unknown');
      expect(count('d1 execute')).toBe(4);
      expect(count('d1 migrations')).toBe(1);
      expect(count('deploy ')).toBe(0);
      expect(readDeploymentRecord()).toMatchObject({ release: '2.0.0-alpha.1', versionId: RECORDED,
        schemaUpdates: [{ bookmark: BOOKMARK, schemaBefore: before, schemaAfter: SERVER_SCHEMA_VERSION, workerVersionBefore: RECORDED }] });
      expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
      expect(exitCode).toBe(1);
    });
  }

  for (const reached of [SERVER_SCHEMA_VERSION - 1, SERVER_SCHEMA_VERSION + 1]) {
    it(`keeps a two-step apply outcome unknown when live schema reaches ${reached}`, async () => {
      schema = SERVER_SCHEMA_VERSION - 2;
      const before = schema;
      failure = 'd1 migrations';
      failureMessage = 'D1 storage timeout [code: 7429]';
      schemaOnMigrationFailure = reached;
      const text = await drive('update');
      expect(text).toContain(`from 2.0.0-alpha.1/${before} to 2.0.0-alpha.1/${reached}`);
      expect(text).toContain(`Schema: attempted; outcome unknown (target ${SERVER_SCHEMA_VERSION}; live schema ${reached})`);
      expect(text).toContain('Worker: not attempted');
      expect(text).toContain('Local deployment record: not updated');
      expect(text).toContain('An attempted change has an unknown outcome');
      expect(text).toContain(failureMessage);
      expect(text).not.toContain('Nothing changed');
      expect(count('d1 execute')).toBe(4);
      expect(count('deploy ')).toBe(0);
      expect(readDeploymentRecord()).toMatchObject({ release: '2.0.0-alpha.1', versionId: RECORDED,
        schemaUpdates: [{ bookmark: BOOKMARK, schemaBefore: before, schemaAfter: SERVER_SCHEMA_VERSION }] });
      expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
      expect(exitCode).toBe(1);
    });
  }

  it('keeps an observed intermediate schema unknown even when the migration reports an authentication refusal', async () => {
    schema = SERVER_SCHEMA_VERSION - 2;
    failure = 'd1 migrations';
    schemaOnMigrationFailure = SERVER_SCHEMA_VERSION - 1;
    const text = await drive('update');
    expect(text).toContain(`Schema: attempted; outcome unknown (target ${SERVER_SCHEMA_VERSION}; live schema ${SERVER_SCHEMA_VERSION - 1})`);
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain('Authentication error [code: 10000] on d1');
    expect(count('deploy ')).toBe(0);
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
    expect(exitCode).toBe(1);
  });

  it('keeps a failed live schema probe unknown even when the migration reports an authentication refusal', async () => {
    failure = 'd1 migrations';
    schemaProbeFails = true;
    const text = await drive('update');
    expect(text).toContain('Schema: attempted; outcome unknown');
    expect(text).toContain('Worker: not attempted');
    expect(text).toContain('live schema probe unavailable');
    expect(text).toContain('Authentication error [code: 10000] on d1');
    expect(count('deploy ')).toBe(0);
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeUndefined();
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
    expect(exitCode).toBe(1);
  });

  it('reports the applied schema separately from a failed Worker upload', async () => {
    failure = 'deploy ';
    const text = await drive('update');
    expect(text).toContain(`from 2.0.0-alpha.1/${SERVER_SCHEMA_VERSION - 1} to 2.0.0-alpha.1/${SERVER_SCHEMA_VERSION}`);
    expect(text).toContain('Schema: applied');
    expect(text).toContain('Worker: refused: not applied');
    expect(text).toContain('Zone / Workers Routes Edit');
    expect(text).not.toContain('Worker: applied');
    expect(readDeploymentRecord()?.schemaUpdates?.at(-1)?.appliedAt).toBeDefined();
    expect(readDeploymentRecord()?.versionId).toBe(RECORDED);
  });

  it('does not suggest route permissions for a workers.dev deployment', async () => {
    writeDeploymentRecord({ ...readDeploymentRecord()!, url: 'https://myco-server.fixture.workers.dev' });
    failure = 'deploy ';
    const text = await drive('update');
    expect(text).toContain('Workers Scripts Edit');
    expect(text).not.toContain('Zone / Workers Routes');
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
