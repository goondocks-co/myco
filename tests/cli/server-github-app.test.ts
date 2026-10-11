import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';

const URL_ = 'https://signin.invalid';
const SECRET = 'regenerated-fixture-secret';
const logs: string[] = [];
const installs: unknown[] = [];
const log = console.log;
const error = console.error;
const exit = process.exit;
let root: string;
let cwd: string;
let previousHome: string | undefined;
let installed: boolean;
let reads: number;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cli-github-'));
  previousHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = root;
  cwd = process.cwd();
  process.chdir(root);
  logs.length = 0;
  installs.length = 0;
  installed = false;
  reads = 0;
  console.log = console.error = (...parts) => { logs.push(parts.map(String).join(' ')); };
  process.exit = (() => { throw new Error('fixture exit'); }) as typeof process.exit;
  writeDeploymentRecord({ accountId: 'a'.repeat(32), workerName: 'myco-server', databaseName: 'db', bucketName: 'blobs', versionId: null, deployedAt: '2026-10-10T00:00:00Z', url: URL_ });
});
afterEach(() => {
  console.log = log;
  console.error = error;
  process.exit = exit;
  process.chdir(cwd);
  if (previousHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
const runner: CommandRunner = { async run(_command, args, options) {
  if (args.includes('bulk')) {
    installs.push(JSON.parse(options!.input!));
    installed = true;
  } else expect(args).toEqual(['--no-install', 'wrangler', '--version']);
  return { code: 0, stdout: '', stderr: '' };
} };
async function drive(args: string[]) {
  const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`${URL_}/auth/login`);
    return installed ? new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=existing-client&redirect_uri=${encodeURIComponent(`${URL_}/auth/callback`)}` } })
      : Response.json({ error: 'sign_in_unconfigured' }, { status: 401 });
  }, { preconnect: () => {} });
  try {
    await run(['github-app', '--url', URL_, '--target', 'cloudflare', ...args], { runner, fetchImpl,
      openUrl: async () => { throw new Error('must not register a new app'); },
      readSecret: async () => { reads += 1; return SECRET; } });
  } catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
  return logs.join('\n');
}

it('dispatches --existing to the sign-in operation and never prints its secret', async () => {
  const output = await drive(['--existing', '--client-id', 'existing-client', '--client-secret-stdin']);
  expect(reads).toBe(1);
  expect(installs).toEqual([{ GITHUB_CLIENT_ID: 'existing-client', GITHUB_CLIENT_SECRET: SECRET }]);
  expect(output).toContain('Verified:');
  expect(output).not.toContain(SECRET);
});

it('refuses incomplete or conflicting existing-app flags before reading a secret or installing', async () => {
  for (const flags of [
    ['--existing'], ['--existing', '--client-id', 'existing-client'],
    ['--client-id', 'existing-client', '--client-secret-stdin'],
    ['--existing', '--client-id', 'existing-client', '--client-secret-stdin', '--org', 'org'],
    ['--existing', '--client-id', 'existing-client', '--client-secret-stdin', '--client-secret', 'bad'],
  ]) await drive(flags);
  expect(reads).toBe(0);
  expect(installs).toHaveLength(0);
  expect(logs.join('\n')).not.toContain(SECRET);
});
