/**
 * The windows-arm64 binary's entry, run as the binary runs it: it carries no native SQLite artifacts, so member verbs
 * and Cloudflare verbs run as on every target, and every verb that would host a Deployment on this machine refuses
 * before it writes anything, naming what to do instead.
 */
import { afterAll, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { cloudflareResources, recoveryConfigurationOf } from '@myco/server/cloudflare-resources.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

const SOURCE = path.resolve(import.meta.dir, '../../packages/myco/src');
const ENTRY = path.join(SOURCE, 'entries/cli.windows-arm64.ts');
const REFUSAL = /Myco for Windows ARM64 does not carry the SQLite libraries.*Nothing was changed\..*myco setup --create cloudflare.*`myco setup --join <address>`/s;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-windows-arm64-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Runs `bun <args>` in a fresh home; returns what it printed, the home and every file it left under it. */
function run(args: string[], env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  // Bun's transpiler cache would otherwise write under the home.
  const result = spawnSync(process.execPath, args, { cwd: home, encoding: 'utf8', timeout: 60_000, input: '',
    env: sandboxChildEnv(root, { HOME: home, MYCO_HOME: path.join(home, '.myco'), NO_COLOR: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', ...env }) });
  const written = fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  return { status: result.status, out: `${result.stdout}${result.stderr}`, home, written };
}

it('reports its version and runs a member verb', () => {
  expect(run([ENTRY, '--version'])).toMatchObject({ status: 0, out: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  expect(run([ENTRY, 'doctor'])).toMatchObject({ status: 0, out: expect.stringContaining('myco doctor (member)') });
});

// The interactive route answers its prompts in-process (they need a terminal): start a new Myco, then on this machine.
const interactive = `await (await import(${JSON.stringify(path.join(SOURCE, 'runtime/native-deps.ts'))})).registerNoNativeDeps({ target: 'windows-arm64' }); const answers = ['1', '2'];
  process.exitCode = await (await import(${JSON.stringify(path.join(SOURCE, 'cli/setup.ts'))})).run([], { ask: async () => answers.shift() ?? null });`;
for (const args of [['server', 'create', '--target', 'local'], ['server', 'install', '--target', 'local'], ['server', 'status'], ['server', 'setup-owner', '--target', 'local'],
  ['server', 'backup', '--target', 'local', '--to', 'backup'], ['setup', '--create', 'local', '--yes', '--serve', 'service'], ['interactive setup']]) {
  it(`refuses \`myco ${args.join(' ')}\` with what to use instead, and writes nothing`, () => {
    const refused = run(args[0] === 'interactive setup' ? ['-e', interactive] : [ENTRY, ...args]);
    expect([refused.status === 0, refused.written]).toEqual([false, []]);
    expect(refused.out).toMatch(REFUSAL);
  });
}

it('prepares a hosted restore with the runtime SQLite, stopping at the first Cloudflare call', async () => {
  const [artifact, secrets, log] = ['artifact', 'recovery.env', 'wrangler.log'].map((name) => path.join(root, name));
  const data = seededSqlite();
  await createRecoveryBundle(artifact, { source: { target: 'cloudflare', locator: 'original' }, blob: async () => { throw new Error('no blobs'); }, snapshot: async (file) => {
    data.query('VACUUM INTO ?').run(file);
    return { configuration: recoveryConfigurationOf({ ...cloudflareResources(), accountId: 'a', databaseId: 'source', storeId: 'f'.repeat(32) }), credentialsRequired: [] };
  } });
  fs.writeFileSync(secrets, `SECRET_WRAP_KEY=${Buffer.alloc(32, 7).toString('base64')}\nSESSION_SECRET=s\nGITHUB_CLIENT_ID=c\nGITHUB_CLIENT_SECRET=c\n`, { mode: 0o600 });
  // The operator package answers version and signed-out identity without contacting a provider.
  const prefix = path.join(root, 'operator');
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'wrangler');
  fs.mkdirSync(path.join(installed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'wrangler', bin: { wrangler: 'bin/wrangler.js' } }));
  fs.writeFileSync(path.join(installed, 'bin', 'wrangler.js'), `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},process.argv.slice(2).join(' ')+'\\n');if(process.argv.includes('--version'))console.log('4.126.0');else console.log('{"loggedIn":false}');`);
  const restore = run([ENTRY, 'server', 'restore', '--target', 'cloudflare', '--from', artifact, '--secrets-from', secrets, '--fork', '--yes', '--account-id', 'a'.repeat(32)],
    { npm_config_prefix: prefix, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '', CF_API_TOKEN: '', CF_API_KEY: '' });
  expect([restore.out.includes('signed in to no Cloudflare account'), fs.readFileSync(log, 'utf8')]).toEqual([true, '--version\nwhoami --json\n']);
  const prepared = new Database(path.join(restore.home, '.myco', 'server', 'cloudflare', 'recovery.sqlite'), { readonly: true });
  expect(prepared.query("SELECT value FROM schema_meta WHERE key = 'version'").get()).toEqual({ value: String(SERVER_SCHEMA_VERSION) });
}, 120_000);
