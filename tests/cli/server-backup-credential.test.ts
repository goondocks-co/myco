import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { run } from '@myco/cli/server.js';
import { installBackupCredential, readBackupCredential } from '@myco/server/backup-credential.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import type { CommandRunner, RunOptions } from '@myco/server/runner.js';

const TOKEN = 'synthetic-backup-access-key';
const ACCOUNT = 'a'.repeat(32);
const DATABASE = '11111111-2222-4333-8444-555555555555';
const BOOKMARK = 'fixture-bookmark';
const logs: string[] = [];
const calls: { command: string; args: readonly string[]; options?: RunOptions }[] = [];
const events: string[] = [];
const original = { log: console.log, error: console.error, exit: process.exit };
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
let root: string;
let previousHome: string | undefined;
let stored: boolean;
let confirm: boolean;
let reads: number;

function record(databaseId: string | null = DATABASE) {
  writeDeploymentRecord({ accountId: ACCOUNT, databaseId: databaseId ?? undefined, workerName: 'fixture-worker', databaseName: 'fixture-db', bucketName: 'fixture-blobs', versionId: null, deployedAt: '2026-10-16T00:00:00Z' }, root);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cli-backup-credential-'));
  previousHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = root;
  logs.length = calls.length = events.length = 0;
  stored = false;
  confirm = true;
  reads = 0;
  console.log = console.error = (...parts) => { logs.push(parts.map(String).join(' ')); };
  process.stdout.write = process.stderr.write = ((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.exit = (() => { throw new Error('fixture exit'); }) as typeof process.exit;
});
afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.exit = original.exit;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  if (previousHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const runner: CommandRunner = { async run(command, args, options) {
  calls.push({ command, args: [...args], options });
  if (args.includes('put')) {
    events.push('store');
    expect(options?.input).toBe(TOKEN);
    expect(options?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' });
    stored = true;
    return { code: 0, stdout: TOKEN, stderr: TOKEN };
  }
  if (args.includes('list')) {
    events.push('confirm');
    return { code: 0, stdout: JSON.stringify(stored && confirm ? [{ name: 'RECOVERY_EXPORT_TOKEN' }] : []), stderr: '' };
  }
  expect(args).toEqual(['--no-install', 'wrangler', '--version']);
  return { code: 0, stdout: '4.149.0', stderr: '' };
} };

function probe(answers: Array<Response | Error> = []) : typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ output_format: 'polling', dump_options: { no_data: true, tables: ['schema_meta'] },
      ...(events.includes('start') ? { current_bookmark: BOOKMARK } : {}) });
    events.push(events.includes('start') ? 'poll' : 'start');
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer ?? Response.json({ success: true, result: events.at(-1) === 'start' ? { success: true, at_bookmark: BOOKMARK }
      : { success: true, status: 'complete', at_bookmark: BOOKMARK, result: { signed_url: 'https://download.invalid/private' } } });
  }, { preconnect: () => {} });
}
const secret = async () => { reads += 1; return readBackupCredential(Readable.from([TOKEN, '\n'])); };
async function drive(args: string[] = [], fetchImpl = probe(), commandRunner = runner) {
  try { await run(['backup-credential', '--target', 'cloudflare', ...args], { runner: commandRunner, fetchImpl, readSecret: secret }); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
  return logs.join('\n');
}
function assertPrivate() {
  expect(logs.join('\n')).not.toContain(TOKEN);
  expect(JSON.stringify(calls.map(({ command, args }) => ({ command, args })))).not.toContain(TOKEN);
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
    }
  };
  visit(root);
}

it('reads hidden terminal input or piped stdin and never echoes the key', async () => {
  const input = Object.assign(Readable.from(['must-not-read']), { isTTY: true });
  let hidden = 0;
  expect(await readBackupCredential(input, async (options) => {
    expect(options).toMatchObject({ toggleMask: false });
    hidden += 1;
    return TOKEN;
  })).toBe(TOKEN);
  expect(hidden).toBe(1);
  expect(await secret()).toBe(TOKEN);
  assertPrivate();
});

it('validates the recorded account and database, stores through stdin, then confirms the secret name', async () => {
  record();
  const output = await drive();
  expect(reads).toBe(1);
  expect(events).toEqual(['start', 'poll', 'store', 'confirm']);
  expect(calls.find((call) => call.args.includes('put'))?.args).toEqual(['--no-install', 'wrangler', 'secret', 'put', 'RECOVERY_EXPORT_TOKEN', '--name', 'fixture-worker']);
  expect(calls.find((call) => call.args.includes('list'))?.args).toEqual(['--no-install', 'wrangler', 'secret', 'list', '--name', 'fixture-worker']);
  expect(output).toContain('Automatic backups can run now');
  assertPrivate();
});

it('stores nothing when either export admission or its bookmark poll refuses validation', async () => {
  record();
  for (const poll of [false, true]) {
    events.length = 0;
    const success = Response.json({ success: true, result: { success: true, at_bookmark: BOOKMARK } });
    const denied = Response.json({ success: false, errors: [{ code: 10000, message: TOKEN }] }, { status: 403 });
    const output = await drive([], probe(poll ? [success, denied] : [denied]));
    expect(output).toContain('No key was stored');
    expect(events).not.toContain('store');
  }
  assertPrivate();
});

it('withholds private diagnostics from validation, storage and confirmation failures', async () => {
  record();
  await drive([], probe([new Error(TOKEN)]));
  for (const step of ['put', 'list']) {
    events.length = 0;
    await drive([], probe(), { async run(command, args, options) {
      if (args.includes(step)) throw new Error(TOKEN);
      return runner.run(command, args, options);
    } });
  }
  assertPrivate();
});

it('requires confirmation by name before announcing that backups can run', async () => {
  record();
  confirm = false;
  const output = await drive();
  expect(events).toEqual(['start', 'poll', 'store', 'confirm']);
  expect(output).toContain('did not list the saved backup access key');
  expect(output).not.toContain('Automatic backups can run now');
  assertPrivate();
});

it('accepts an immediate complete export without requiring or polling a bookmark', async () => {
  record();
  const complete = Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://download.invalid' } } });
  expect(await drive([], probe([complete]))).toContain('Automatic backups can run now');
  expect(events).toEqual(['start', 'store', 'confirm']);
  assertPrivate();
});

it('refuses missing or incomplete records before reading a key or contacting Cloudflare', async () => {
  expect(await drive()).toContain('No Cloudflare deployment record on this machine');
  record(null);
  expect(await drive()).toContain('missing its account or database id');
  expect(reads).toBe(0);
  expect(calls).toHaveLength(0);
  expect(events).toHaveLength(0);
});

it('refuses argv credentials and destination overrides without repeating their values', async () => {
  record();
  for (const args of [['--token', TOKEN], [TOKEN], ['--account-id', TOKEN], ['--database-id', TOKEN]]) await drive(args);
  expect(reads).toBe(0);
  expect(calls).toHaveLength(0);
  assertPrivate();
});

it('refuses an empty or multiline key before sending any export request', async () => {
  record();
  for (const value of ['', `${TOKEN}\nother`]) {
    await expect(installBackupCredential({ mycoHome: root, runner, fetchImpl: probe(), readSecret: async () => value })).rejects.toThrow('one token on a single line');
  }
  expect(events).toHaveLength(0);
  assertPrivate();
});
