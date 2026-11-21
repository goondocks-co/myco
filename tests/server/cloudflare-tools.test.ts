import { cloudflareRunner } from '@myco/server/cloudflare-runner.js';
import { afterEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWranglerReady, operationWranglerRunner, installWrangler, listAccounts, putWorkerSecrets, resolveWrangler, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { BUNDLED_WORKER_NODE, BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';
import type { CommandResult, CommandRunner, RunOptions } from '@myco/server/runner.js';
import { run } from '@myco/cli/setup.js';
import { installBackupCredential } from '@myco/server/backup-credential.js';
import { saveSetupFile } from '@myco/setup/answers.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { observeSetupStatus } from '@myco/setup/observe.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const answer = (stdout = '', code = 0, stderr = ''): CommandResult => ({ stdout, code, stderr });
function host() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tools-'));
  roots.push(home);
  const calls: { command: string; args: readonly string[]; options?: RunOptions }[] = [];
  const state: { node: string; external: CommandResult; loggedIn: boolean; installFails: boolean; ownedResult?: CommandResult; legacy?: boolean } = { node: 'v26.0.0', external: answer('', 1, 'npm error npx canceled due to missing packages'), loggedIn: false, installFails: false };
  const runner: CommandRunner = { async run(command, args, options) {
    calls.push({ command, args, options });
    if (command === 'node' && args[0] === '--version') {
      if (!state.node) throw Object.assign(new Error('absent node'), { code: 'ENOENT' });
      return answer(state.node);
    }
    if (command.startsWith('npm')) {
      if (state.installFails) return answer('', 1, 'fixture install failed');
      const entry = path.join(args[args.indexOf('--prefix') + 1]!, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'fixture executable');
      state.ownedResult = undefined;
      return answer();
    }
    if (command.startsWith('npx') && args.includes('--version')) {
      const env = options?.env;
      if (env?.npm_config_offline !== 'true' || env.npm_config_update_notifier !== 'false' || env.npm_config_logs_max !== '0' || env.WRANGLER_WRITE_LOGS !== 'false' || env.WRANGLER_SEND_METRICS !== 'false' || !env.npm_config_cache?.startsWith(path.join(home, 'server', 'tools'))) {
        fs.mkdirSync(path.join(home, 'unexpected-probe-write'), { recursive: true });
        return answer('', 1, 'probe attempted network or state writes');
      }
      return state.external;
    }
    if (args.includes('--version')) return args[0]?.includes(`wrangler-${BUNDLED_WORKER_WRANGLER}`) ? state.ownedResult ?? answer(BUNDLED_WORKER_WRANGLER) : answer(BUNDLED_WORKER_WRANGLER);
    if (args.includes('login')) state.loggedIn = true;
    if (args.includes('whoami') && state.legacy) return args.includes('--json') ? answer('Unknown argument: json', 1) : answer(`│ Fixture │ ${'a'.repeat(32)} │`);
    if (args.includes('secret') && args.includes('list')) return answer('[{"name":"RECOVERY_EXPORT_TOKEN"}]');
    if (args.includes('whoami')) return answer(JSON.stringify({ loggedIn: state.loggedIn, accounts: [{ name: 'Fixture', id: 'a'.repeat(32) }] }));
    return answer();
  } };
  return { home, calls, state, runner, readiness: { runner, mycoHome: home, cwd: home, env: {} } };
}

it('names missing and unsupported Node before attempting Wrangler, retaining its declared requirement', async () => {
  const h = host();
  h.state.node = '';
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('Node.js is not installed');
  h.state.node = 'v18.19.1';
  await expect(resolveWrangler(h.readiness)).rejects.toThrow(`Node.js 18.19.1 does not meet Wrangler ${BUNDLED_WORKER_WRANGLER}'s requirement ${BUNDLED_WORKER_NODE}`);
  expect(h.calls.every(call => call.command === 'node')).toBe(true);
  h.state.node = 'v24.0.0-rc.1';
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  expect((await resolveWrangler(h.readiness)).version).toBe(BUNDLED_WORKER_WRANGLER);
});

it('installs only with setup consent and uses the pinned private tool for account reads and secret stdin', async () => {
  const h = host();
  const errors: string[] = [];
  const deps = { mycoHome: h.home, cwd: h.home, agents: () => [], cloudflare: { runner: h.runner }, stdout: () => {}, stderr: (line: string) => errors.push(line) };
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('myco setup --create cloudflare');
  expect(await run(['--create', 'cloudflare'], { ...deps, ask: async () => 'no' })).not.toBe(0);
  expect(h.calls.some(call => call.command.startsWith('npm'))).toBe(false);
  expect(await run(['--create', 'cloudflare'], { ...deps, ask: async question => question.includes('Install Myco') ? 'yes' : 'no' })).not.toBe(0);
  const install = h.calls.find(call => call.command.startsWith('npm'))!;
  expect(install.args).toContain(`wrangler@${BUNDLED_WORKER_WRANGLER}`);
  expect(install.options?.input).toBeUndefined();
  expect(install.options?.stdio).toBeUndefined();
  expect(install.options?.cwd?.startsWith(path.join(h.home, 'server', 'tools'))).toBe(true);
  const tool = await resolveWrangler(h.readiness);
  expect(tool.source.startsWith(path.join(h.home, 'server', 'tools'))).toBe(true);
  await expect(assertWranglerReady(h.readiness)).rejects.toThrow('myco setup --create cloudflare');
  h.state.loggedIn = true;
  const readiness = { ...h.readiness, runner: operationWranglerRunner(h.runner) };
  await Promise.all([assertWranglerReady(readiness), assertWranglerReady(readiness)]);
  const admittedCalls = h.calls.length;
  await assertWranglerReady(readiness);
  expect(h.calls.length).toBe(admittedCalls);
  expect(await listAccounts(h.runner, h.home)).toEqual([{ name: 'Fixture', id: 'a'.repeat(32) }]);
  await putWorkerSecrets({ runner: h.runner, mycoHome: h.home, accountId: 'a'.repeat(32), workerName: 'fixture' }, { GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'private-fixture' });
  const bulk = h.calls.find(call => call.args.includes('bulk'))!;
  expect(bulk.command).toBe('node');
  expect(bulk.args).not.toContain('private-fixture');
  expect(JSON.parse(bulk.options!.input!)).toEqual({ GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'private-fixture' });
  expect(bulk.options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('a'.repeat(32));
  writeDeploymentRecord({ accountId: 'a'.repeat(32), databaseId: '11111111-2222-4333-8444-555555555555', workerName: 'fixture', databaseName: 'fixture', bucketName: 'fixture', versionId: null, deployedAt: 'fixture' }, h.home);
  await installBackupCredential({ mycoHome: h.home, runner: h.runner, readSecret: async () => 'private-backup', fetchImpl: Object.assign(async () => Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://download.invalid' } } }), { preconnect: () => {} }) });
  const put = h.calls.find(call => call.args.includes('put'))!;
  expect(put.command).toBe('node');
  expect(put.options?.input).toBe('private-backup');
  expect(put.args).not.toContain('private-backup');
  h.state.external = answer('', 1, 'Wrangler requires at least Node.js v22.12.0. You are using v22.5.0.\nConsider using a Node.js version manager');
  const fallback = await resolveWrangler(h.readiness);
  expect(fallback.source).toBe(tool.source);
  expect(fallback.note).toContain('requires at least Node.js v22.12.0');
  h.state.external = answer('3.0.0');
  expect((await resolveWrangler(h.readiness)).source).toBe(tool.source);
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  expect((await resolveWrangler(h.readiness)).source).toContain('operator installation');
});

it('keeps failed installs unpublished and reports other version failures in Wrangler’s words', async () => {
  const h = host();
  h.state.installFails = true;
  await expect(installWrangler({ ...h.readiness, env: { CLOUDFLARE_API_TOKEN: 'private-fixture', CF_API_KEY: 'private-key', NPM_CONFIG_LOCATION: 'global' } })).rejects.toThrow('fixture install failed');
  const installation = h.calls.find(call => call.command.startsWith('npm'))!;
  expect(installation.args).toContain('--global=false');
  expect(installation.args).toContain('--location=project');
  expect(Object.keys(installation.options!.env!).some(name => /^(CLOUDFLARE_|CF_)/i.test(name))).toBe(false);
  expect(fs.readdirSync(path.join(h.home, 'server', 'tools'))).toEqual([]);
  h.state.external = answer('', 1, 'npm error code ECONNREFUSED\nnpm error registry unavailable\nnpm error A complete log can be found elsewhere');
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('npm error code ECONNREFUSED');
});

it('reports the selected tool and version through read-only doctor and setup status', async () => {
  const h = host();
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  saveSetupFile(h.home, { version: 1, answers: { role: 'create', target: 'cloudflare' }, consented: {} });
  const before = fs.readdirSync(h.home, { recursive: true }).sort();
  const doctor = await homeReport(h.home, { cloudflareRunner: h.runner });
  expect(doctor.find(check => check.name === 'Wrangler')?.status).toBe('ok');
  expect(doctor.find(check => check.name === 'Wrangler')?.detail).toContain(BUNDLED_WORKER_WRANGLER);
  const status = await observeSetupStatus(h.home, { role: 'create', target: 'cloudflare' }, { agents: () => [], cloudflare: { runner: h.runner } }, true);
  expect(status.find(fact => fact.id === 'cloudflare.tools')?.detail).toContain('operator installation');
  expect(h.calls.every(call => call.command === 'node' || call.command.startsWith('npx'))).toBe(true);
  expect(fs.readdirSync(h.home, { recursive: true }).sort()).toEqual(before);
  fs.writeFileSync(path.join(h.home, 'setup.json'), 'malformed');
  const broken = await homeReport(h.home, { cloudflareRunner: h.runner });
  expect(broken.find(check => check.detail.includes('setup.json'))?.name).toBe('Setup');
  expect(broken.some(check => check.name === 'Wrangler')).toBe(false);
});


it('resolves Windows npm shims through the Node installation and preserves literal arguments', async () => {
  const h = host();
  const shim = path.join(h.home, 'shims');
  const node = path.join(h.home, 'node');
  const bin = path.join(node, 'node_modules', 'npm', 'bin');
  fs.mkdirSync(shim); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(shim, 'npm.cmd'), 'fixture shim');
  fs.writeFileSync(path.join(node, 'node.exe'), 'fixture node');
  const entry = path.join(bin, 'npm-cli.js');
  fs.writeFileSync(entry, 'fixture npm');
  const runner = cloudflareRunner({ platform: 'win32', runner: h.runner });
  const args = ['--prefix', path.join(h.home, 'folder with spaces & punctuation')];
  await runner.run('npm.cmd', args, { env: { PATH: `${shim};${node}` } });
  const call = h.calls.at(-1)!;
  expect(call.command).toBe(path.join(node, 'node.exe'));
  expect(call.args).toEqual([entry, ...args]);
});

it('repairs older and damaged private installations through one rollback-safe setup writer', async () => {
  const h = host();
  const tools = path.join(h.home, 'server', 'tools');
  const old = path.join(tools, 'wrangler-4.0.0');
  const pinned = path.join(tools, `wrangler-${BUNDLED_WORKER_WRANGLER}`);
  fs.mkdirSync(old, { recursive: true });
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('wrangler-4.0.0');
  fs.mkdirSync(path.join(pinned, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(tools, '.wrangler-unused'));
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('has no executable');
  h.state.installFails = true;
  await expect(installWrangler(h.readiness)).rejects.toThrow('fixture install failed');
  expect(fs.existsSync(old)).toBe(true);
  expect(fs.existsSync(pinned)).toBe(true);
  h.state.installFails = false;
  const rename = fs.renameSync;
  let denied = false;
  const filesystem = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!denied && String(from) === pinned) { denied = true; throw Object.assign(new Error('transient filesystem lock'), { code: 'EPERM' }); }
    return rename(from, to);
  });
  try { await installWrangler(h.readiness); } finally { filesystem.mockRestore(); }
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.readdirSync(tools).some(name => name.startsWith('.wrangler-'))).toBe(false);
  h.state.ownedResult = answer('4.0.0');
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('reports 4.0.0');
  await installWrangler(h.readiness);
  expect((await resolveWrangler(h.readiness)).version).toBe(BUNDLED_WORKER_WRANGLER);
});

it('uses the plain identity command when an older operator tool rejects JSON', async () => {
  const h = host();
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  h.state.loggedIn = true; h.state.legacy = true;
  await assertWranglerReady(h.readiness);
  expect(await listAccounts(h.runner, h.home)).toEqual([{ name: 'Fixture', id: 'a'.repeat(32) }]);
});
