import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWranglerReady, installWrangler, listAccounts, putWorkerSecrets, resolveWrangler } from '@myco/server/cloudflare.js';
import { BUNDLED_WORKER_NODE, BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';
import type { CommandResult, CommandRunner, RunOptions } from '@myco/server/runner.js';
import { run } from '@myco/cli/setup.js';
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
  const state = { node: 'v26.0.0', external: answer('', 1, 'npm error npx canceled due to missing packages'), loggedIn: false, installFails: false };
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
      return answer();
    }
    if (command.startsWith('npx') && args.includes('--version')) return state.external;
    if (args.includes('--version')) return answer(BUNDLED_WORKER_WRANGLER);
    if (args.includes('login')) state.loggedIn = true;
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
  await assertWranglerReady(h.readiness);
  expect(await listAccounts(h.runner, h.home)).toEqual([{ name: 'Fixture', id: 'a'.repeat(32) }]);
  await putWorkerSecrets({ runner: h.runner, mycoHome: h.home, accountId: 'a'.repeat(32), workerName: 'fixture' }, { GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'private-fixture' });
  const bulk = h.calls.find(call => call.args.includes('bulk'))!;
  expect(bulk.command).toBe('node');
  expect(bulk.args).not.toContain('private-fixture');
  expect(JSON.parse(bulk.options!.input!)).toEqual({ GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'private-fixture' });
  expect(bulk.options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('a'.repeat(32));
  h.state.external = answer('3.0.0');
  expect((await resolveWrangler(h.readiness)).source).toBe(tool.source);
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  expect((await resolveWrangler(h.readiness)).source).toContain('operator installation');
});

it('keeps failed installs unpublished and reports other version failures in Wrangler’s words', async () => {
  const h = host();
  h.state.installFails = true;
  await expect(installWrangler(h.readiness)).rejects.toThrow('fixture install failed');
  expect(fs.readdirSync(path.join(h.home, 'server', 'tools'))).toEqual([]);
  h.state.external = answer('', 1, 'startup failed\nfixture permission denied');
  await expect(resolveWrangler(h.readiness)).rejects.toThrow('fixture permission denied');
});

it('reports the selected tool and version through read-only doctor and setup status', async () => {
  const h = host();
  h.state.external = answer(BUNDLED_WORKER_WRANGLER);
  saveSetupFile(h.home, { version: 1, answers: { role: 'create', target: 'cloudflare' }, consented: {} });
  const doctor = await homeReport(h.home, { cloudflareRunner: h.runner });
  expect(doctor.find(check => check.name === 'Wrangler')?.detail).toContain(BUNDLED_WORKER_WRANGLER);
  const status = await observeSetupStatus(h.home, { role: 'create', target: 'cloudflare' }, { agents: () => [], cloudflare: { runner: h.runner } }, true);
  expect(status.find(fact => fact.id === 'cloudflare.tools')?.detail).toContain('operator installation');
  expect(h.calls.every(call => call.command === 'node' || call.command.startsWith('npx'))).toBe(true);
});
