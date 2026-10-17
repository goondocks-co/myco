import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { run } from '@myco/cli/server.js';
import { installBackupCredential, readBackupCredential } from '@myco/server/backup-credential.js';
import { ensureCommandDir, writeDeploymentRecord, type CloudflareFetch, type OperatorLogin } from '@myco/server/cloudflare.js';
import { D1_EXPORT_CANCEL_MARGIN_MS, exportD1, exportRecordPath, exportResultPath, probeD1Export, releaseD1Export, settleD1Export } from '@myco/server/cloudflare-d1-export.js';
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
let previousEnv: Record<string, string | undefined>;
let stored: boolean;
let confirm: boolean;
let reads: number;
let exitCode: number | undefined;

function record(databaseId: string | null = DATABASE) {
  writeDeploymentRecord({ accountId: ACCOUNT, databaseId: databaseId ?? undefined, workerName: 'fixture-worker', databaseName: 'fixture-db', bucketName: 'fixture-blobs', versionId: null, deployedAt: '2026-10-16T00:00:00Z' }, root);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cli-backup-credential-'));
  const env = { HOME: path.join(root, 'home'), MYCO_HOME: root, TMPDIR: path.join(root, 'tmp'),
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config') };
  previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    fs.mkdirSync(value, { recursive: true });
    process.env[key] = value;
  }
  logs.length = calls.length = events.length = 0;
  stored = false;
  confirm = true;
  reads = 0;
  exitCode = undefined;
  console.log = console.error = (...parts) => { logs.push(parts.map(String).join(' ')); };
  process.stdout.write = process.stderr.write = ((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.exit = ((code?: number) => { exitCode = code; throw new Error('fixture exit'); }) as typeof process.exit;
});
afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.exit = original.exit;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
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
  if (args.includes('whoami')) return { code: 0, stdout: 'OAuth fixture', stderr: '' };
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

it.each([401, 403])('retains the record and bookmark when a %s refuses a poll after the start', async (status) => {
  record();
  const running = Response.json({ success: true, result: { at_bookmark: BOOKMARK } });
  const denied = Response.json({ success: false, errors: [{ code: 10000, message: TOKEN }] }, { status });
  expect(await drive([], probe([running, denied]))).toContain('Account → D1 → Edit');
  expect(JSON.parse(fs.readFileSync(exportRecordPath(ensureCommandDir(root), DATABASE), 'utf8'))).toMatchObject({
    purpose: 'credential-probe', bookmark: BOOKMARK,
  });
  expect(events).toEqual(['start', 'poll']);
  assertPrivate();
});

it('withholds private diagnostics from validation, storage and confirmation failures', async () => {
  record();
  for (const step of ['put', 'list']) {
    events.length = 0;
    await drive([], probe(), { async run(command, args, options) {
      if (args.includes(step)) throw new Error(TOKEN);
      return runner.run(command, args, options);
    } });
  }
  events.length = 0;
  await drive([], probe([new Error(TOKEN)]));
  assertPrivate();
});

it('refuses signed-out Wrangler before reading the key or making an export request', async () => {
  record();
  const output = await drive([], probe(), { async run(command, args, options) {
    if (args.includes('whoami')) return { code: 1, stdout: TOKEN, stderr: TOKEN };
    return runner.run(command, args, options);
  } });
  expect(output).toContain('signed in to no Cloudflare account');
  expect(reads).toBe(0);
  expect(events).toHaveLength(0);
  expect(fs.existsSync(exportRecordPath(ensureCommandDir(root), DATABASE))).toBe(false);
  assertPrivate();
});

it.each(['put', 'list'])('preserves the safe Wrangler authentication refusal during secret %s', async (step) => {
  record();
  const output = await drive([], probe(), { async run(command, args, options) {
    if (args.includes(step)) return { code: 1, stdout: TOKEN, stderr: `Authentication error [code: 10000] ${TOKEN}` };
    return runner.run(command, args, options);
  } });
  expect(output).toContain('Authentication error [code: 10000]');
  expect(output).toContain('Workers Scripts Edit');
  expect(output).not.toContain('Run the command again');
  assertPrivate();
});

it('prints cancellation with a distinct exit before starting an export', async () => {
  record();
  const cancelled = new Error(TOKEN);
  cancelled.name = 'ExitPromptError';
  try {
    await run(['backup-credential', '--target', 'cloudflare'], { runner, fetchImpl: probe(), readSecret: async () => { throw cancelled; } });
  } catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
  expect(logs.join('\n')).toBe('Cancelled; nothing was stored.');
  expect(exitCode).toBe(130);
  expect(events).toHaveLength(0);
  assertPrivate();
});

it.each([401, 403, 429, 503])('words a %s validation refusal by its cause', async (status) => {
  record();
  const output = await drive([], probe([Response.json({ success: false, errors: [{ code: status === 401 ? 10000 : 7403, message: TOKEN }] }, { status })]));
  expect(output).toContain('No key was stored');
  if (status === 401 || status === 403) expect(output).toContain('Account → D1 → Edit');
  else {
    expect(output).toContain('Cloudflare didn’t answer');
    expect(output).toContain('Try later');
    expect(output).not.toContain('Account → D1 → Edit');
  }
  expect(events).not.toContain('store');
  assertPrivate();
});

const exportContext = (fetch: CloudflareFetch) => ({
  accountId: ACCOUNT, databaseId: DATABASE, recordDir: ensureCommandDir(root), output: exportResultPath(ensureCommandDir(root), DATABASE), fetch,
  login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} } satisfies OperatorLogin,
});

it('refuses a recorded operator export without changing its bytes or starting a probe', async () => {
  record();
  const file = exportRecordPath(ensureCommandDir(root), DATABASE);
  const held = JSON.stringify({ databaseId: DATABASE, tables: ['sessions'], bookmark: 'operator-bookmark', startedAt: Date.now(), lastPolledAt: Date.now(), schema: 'fixture-schema' });
  fs.writeFileSync(file, held);
  const output = await drive();
  expect(output).toContain('An earlier database export is still recorded');
  expect(output).toContain('myco server backup --target cloudflare --to <dir>');
  expect(events).toHaveLength(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(held);
  assertPrivate();
});

it('persists intent before an unanswered start and blocks another probe or full export', async () => {
  record();
  const file = exportRecordPath(ensureCommandDir(root), DATABASE);
  const fetchImpl: typeof fetch = Object.assign(async () => {
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ purpose: 'credential-probe', bookmark: null });
    throw new Error(TOKEN);
  }, { preconnect: () => {} });
  expect(await drive([], fetchImpl)).toContain('Cloudflare didn’t answer');
  expect(await drive()).toContain('An earlier backup access check is still recorded');
  const context = exportContext(async () => { throw new Error('must not start another export'); });
  await expect(exportD1({ ...context, tables: ['sessions'], schema: 'fixture' })).rejects.toThrow('had no answer');
  expect(stored).toBe(false);
  assertPrivate();
});

function savedProbe(bookmark: string | null, lastPolledAt: number) {
  const file = exportRecordPath(ensureCommandDir(root), DATABASE);
  fs.writeFileSync(file, JSON.stringify({ databaseId: DATABASE, purpose: 'credential-probe', tables: ['schema_meta'],
    bookmark, startedAt: lastPolledAt, lastPolledAt, schema: '' }));
  return file;
}

it('clears a bookmark-less probe past the cancellation margin and validates with a new probe', async () => {
  record();
  const now = Date.now();
  const file = savedProbe(null, now - D1_EXPORT_CANCEL_MARGIN_MS - 1);
  const complete = Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://not-downloaded.invalid' } } });
  await installBackupCredential({ mycoHome: root, runner, fetchImpl: probe([complete]), readSecret: secret,
    probeClock: { now: () => now, sleep: async () => {} } });
  expect(events).toEqual(['start', 'store', 'confirm']);
  expect(fs.existsSync(file)).toBe(false);
  assertPrivate();
});

it.each([0, D1_EXPORT_CANCEL_MARGIN_MS + 1])('follows a recorded probe aged %s ms to its end before validating with a new probe', async (age) => {
  record();
  const now = Date.now();
  const file = savedProbe('held-bookmark', now - age);
  const bookmarks: Array<string | null> = [];
  const fetchImpl: typeof fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init?.body));
    expect(body.dump_options).toEqual({ no_data: true, tables: ['schema_meta'] });
    const bookmark: string | null = body.current_bookmark ?? null;
    bookmarks.push(bookmark);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).bookmark).toBe(bookmark);
    if (bookmarks.length === 1) return Response.json({ success: true, result: { at_bookmark: 'continued-bookmark' } });
    if (bookmarks.length === 3) return Response.json({ success: true, result: { at_bookmark: BOOKMARK } });
    return Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://never-download.invalid' } } });
  }, { preconnect: () => {} });
  await installBackupCredential({ mycoHome: root, runner, fetchImpl, readSecret: secret,
    probeClock: { now: () => now, sleep: async () => {} } });
  expect(bookmarks).toEqual(['held-bookmark', 'continued-bookmark', null, BOOKMARK]);
  expect(events).toEqual(['store', 'confirm']);
  expect(fs.existsSync(file)).toBe(false);
  assertPrivate();
});

it.each([401, 403])('keeps a recorded probe when its resumed poll is refused with %s', async (status) => {
  record();
  const now = Date.now();
  const file = savedProbe(BOOKMARK, now - D1_EXPORT_CANCEL_MARGIN_MS - 1);
  const before = fs.readFileSync(file, 'utf8');
  const bookmarks: unknown[] = [];
  const fetchImpl: typeof fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bookmarks.push(body.current_bookmark);
    expect(body.dump_options).toEqual({ no_data: true, tables: ['schema_meta'] });
    return Response.json({ success: false, errors: [{ code: 10000, message: TOKEN }] }, { status });
  }, { preconnect: () => {} });
  await expect(installBackupCredential({ mycoHome: root, runner, fetchImpl, readSecret: secret,
    probeClock: { now: () => now, sleep: async () => {} } })).rejects.toThrow('Account → D1 → Edit');
  expect(bookmarks).toEqual([BOOKMARK]);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(events).toHaveLength(0);
  assertPrivate();
});

it('retains the probe bookmark on a poll failure and settles it before a full export, without downloading its result', async () => {
  record();
  const running = Response.json({ success: true, result: { at_bookmark: BOOKMARK } });
  const output = await drive([], probe([running, new Error(TOKEN)]));
  expect(output).toContain('Wait for Cloudflare’s small schema export to end');
  const file = exportRecordPath(ensureCommandDir(root), DATABASE);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ purpose: 'credential-probe', bookmark: BOOKMARK });
  const requests: string[] = [];
  const context = exportContext(async (url, init) => {
    if (url === 'https://full.invalid/sql') { requests.push('full-download'); return new Response('-- full snapshot\n', { headers: { 'content-length': '17' } }); }
    const body = JSON.parse(String(init.body));
    if (body.current_bookmark === BOOKMARK) {
      requests.push('probe-poll');
      expect(body.dump_options).toEqual({ tables: ['schema_meta'], no_data: true });
      return Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://never-download.invalid/probe' } } });
    }
    requests.push('full-start');
    expect(body.current_bookmark).toBeUndefined();
    expect(body.dump_options).toEqual({ tables: ['sessions'] });
    return Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://full.invalid/sql' } } });
  });
  await exportD1({ ...context, tables: ['sessions'], schema: 'fixture' });
  expect(requests).toEqual(['probe-poll', 'full-start', 'full-download']);
  expect(fs.readFileSync(context.output, 'utf8')).toBe('-- full snapshot\n');
  assertPrivate();
});

it('keeps an over-budget probe recorded and words the wait without blaming permissions', async () => {
  record();
  let requests = 0;
  const waits: number[] = [];
  const fetchImpl: typeof fetch = Object.assign(async () => {
    requests += 1;
    return Response.json({ success: true, result: { at_bookmark: BOOKMARK } });
  }, { preconnect: () => {} });
  await expect(installBackupCredential({ mycoHome: root, runner, fetchImpl, readSecret: secret, probeClock: { sleep: async (ms) => { waits.push(ms); } } })).rejects.toThrow('still running past its budget');
  expect(requests).toBe(31);
  expect(waits).toEqual(Array(30).fill(2000));
  expect(JSON.parse(fs.readFileSync(exportRecordPath(ensureCommandDir(root), DATABASE), 'utf8')).bookmark).toBe(BOOKMARK);
  let polls = 0;
  const context = exportContext(async (_url, init) => {
    expect(JSON.parse(String(init.body)).current_bookmark).toBe(BOOKMARK);
    polls += 1;
    return Response.json({ success: true, result: { at_bookmark: BOOKMARK } });
  });
  await expect(settleD1Export({ ...context, boundMs: 0 })).rejects.toThrow('no second export was started');
  expect(polls).toBe(1);
  expect(stored).toBe(false);
  assertPrivate();
});

it('serializes a pending probe with every operator export mutation', async () => {
  record();
  let begin!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const recordDir = ensureCommandDir(root);
  const checking = probeD1Export({ recordDir, databaseId: DATABASE, request: async () => {
    begin();
    await pending;
    return { kind: 'complete', bookmark: null, signedUrl: 'https://not-downloaded.invalid' };
  } });
  await started;
  const context = exportContext(async () => { throw new Error('no competing request'); });
  try {
    await expect(probeD1Export({ recordDir, databaseId: DATABASE, request: async () => { throw new Error('no second probe'); } })).rejects.toThrow('Another database export operation');
    await expect(exportD1({ ...context, tables: ['sessions'], schema: 'fixture' })).rejects.toThrow('Another database export operation');
    await expect(settleD1Export(context)).rejects.toThrow('Another database export operation');
    expect(() => releaseD1Export(context)).toThrow('Another database export operation');
  } finally { finish(); await checking; }
  expect(fs.existsSync(exportRecordPath(recordDir, DATABASE))).toBe(false);
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
  const output = await drive();
  expect(output).toContain(`No Cloudflare Deployment record at ${path.join(root, 'server', 'cloudflare', 'record.json')}.`);
  expect(output).toContain('This home comes from MYCO_HOME (set in your environment or by a runtime pin).');
  expect(output).toContain('No backup access key was read or stored.');
  expect(output).not.toContain('machine that manages the server');
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

it('names the machine pin and alternate home when the backup record is missing', async () => {
  delete process.env.MYCO_HOME;
  const defaultHome = path.join(process.env.HOME!, '.myco');
  fs.mkdirSync(defaultHome, { recursive: true });
  const pin = path.join(defaultHome, 'runtime.home');
  const pinnedHome = path.join(root, 'pinned');
  fs.writeFileSync(pin, pinnedHome, { mode: 0o600 });
  const output = await drive();
  expect(output).toContain(path.join(pinnedHome, 'server', 'cloudflare', 'record.json'));
  expect(output).toContain(`This home comes from the pin ${pin}.`);
  expect(output).toContain('MYCO_HOME set to that home');
  expect(reads).toBe(0);
});

it('names the default home and suggests an explicit home override', async () => {
  delete process.env.MYCO_HOME;
  const output = await drive();
  expect(output).toContain(path.join(process.env.HOME!, '.myco', 'server', 'cloudflare', 'record.json'));
  expect(output).toContain('This is the default home.');
  expect(output).toContain('MYCO_HOME set to that home');
  expect(reads).toBe(0);
});
