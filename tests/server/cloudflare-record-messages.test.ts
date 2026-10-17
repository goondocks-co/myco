import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { backupCloudflareDeployment, cloudflareRecoveryHoldOf } from '@myco/server/cloudflare-backup.js';
import { destroyCloudflareDeployment, rollbackCloudflareDeployment, updateCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { setupCloudflareOwner } from '@myco/server/cloudflare-owner.js';
import { restoreCloudflareDeployment } from '@myco/server/cloudflare-recovery.js';
import { missingDeploymentRecordMessage, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { resolveSignInTarget } from '@myco/server/github-app.js';
import { observeSetup } from '@myco/setup/observe.js';
import { stageCloudflareDeploy } from '@myco/server/cloudflare-stage.js';
import { renderDeployConfig } from '@myco/server/deploy-config.js';
import type { CommandRunner } from '@myco/server/runner.js';

let root: string;
let previous: Record<string, string | undefined>;
const runner: CommandRunner = { async run() { return { code: 0, stdout: '4.126.0 OAuth fixture', stderr: '' }; } };
const accountId = 'a'.repeat(32);
const record = { accountId, workerName: 'fixture', databaseName: 'fixture', bucketName: 'fixture', versionId: null, deployedAt: '2026-10-17T00:00:00Z' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-record-messages-'));
  const env = { HOME: path.join(root, 'home'), MYCO_HOME: path.join(root, 'myco'), TMPDIR: path.join(root, 'tmp'),
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config') };
  previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    fs.mkdirSync(value, { recursive: true });
    process.env[key] = value;
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const options = () => ({ mycoHome: process.env.MYCO_HOME!, accountId, runner });
const recordFile = () => path.join(process.env.MYCO_HOME!, 'server', 'cloudflare', 'record.json');

it('names the backup record file', async () => {
  await expect(backupCloudflareDeployment({ ...options(), destination: path.join(root, 'backup') })).rejects.toThrow(recordFile());
});
it('names the recovery hold record file', () => {
  expect(() => cloudflareRecoveryHoldOf(options())).toThrow(recordFile());
});
it('names the update record file', async () => {
  const error = await updateCloudflareDeployment(options()).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('update must refuse the missing record');
  expect(error.message).toContain(recordFile());
  expect(error.message).toContain('--account-id <id>');
});
it('names the rollback record file', async () => {
  await expect(rollbackCloudflareDeployment(options())).rejects.toThrow(recordFile());
});
it('names the destroy record file', async () => {
  await expect(destroyCloudflareDeployment(options())).rejects.toThrow(recordFile());
});
it('names the owner setup record file', async () => {
  await expect(setupCloudflareOwner(options())).rejects.toThrow(recordFile());
});
it.each([['status', false], ['config', false], ['config', true]] as const)('names the %s record file (recorded: %s)', async (command, recorded) => {
  if (recorded) writeDeploymentRecord(record, process.env.MYCO_HOME);
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  console.log = console.error = (...parts) => { lines.push(parts.map(String).join(' ')); };
  process.exit = (() => { throw new Error('fixture exit'); }) as typeof process.exit;
  try {
    try { await run([command, '--target', 'cloudflare'], { runner }); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
    expect(lines.join('\n')).toContain(recorded ? recordFile() : `No Cloudflare Deployment record at ${recordFile()}.`);
    if (command === 'status') expect(lines.join('\n')).toContain('--account-id <id>');
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
it('names the occupied recovery home', async () => {
  writeDeploymentRecord(record, process.env.MYCO_HOME);
  await expect(restoreCloudflareDeployment({ ...options(), sourceRetired: true, source: path.join(root, 'source'), secretsFile: path.join(root, 'secrets') }))
    .rejects.toThrow(`Cloudflare Deployment record already exists at ${recordFile()}.`);
});
it('does not attribute an explicit home to the environment', () => {
  const message = missingDeploymentRecordMessage(path.join(root, 'explicit'));
  expect(message).toContain(path.join(root, 'explicit', 'server', 'cloudflare', 'record.json'));
  expect(message).not.toContain('This home comes from');
  expect(message).not.toContain('This is the default home.');
  expect(message).toContain('MYCO_HOME set to that home');
});

it('names the GitHub app record file', () => {
  expect(() => resolveSignInTarget('cloudflare', options().mycoHome)).toThrow(recordFile());
});

it.each([
  ['missing database id', {}],
  ['invalid URL', { databaseId: 'fixture-id', url: 'invalid-url' }],
  ['URL port', { databaseId: 'fixture-id', url: 'https://example.invalid:8443' }],
  ['invalid fleet', { databaseId: 'fixture-id', fleet: 0 }],
])('names the explicit record file for %s', (_name, fields) => {
  expect(() => renderDeployConfig({ ...record, ...fields }, recordFile())).toThrow(recordFile());
});

it('keeps the record path for a home with a trailing slash', () => {
  const home = path.join(process.env.HOME!, '.myco');
  const message = missingDeploymentRecordMessage(home + path.sep);
  expect(message).toContain(path.join(home, 'server', 'cloudflare', 'record.json'));
  expect(message).toContain('MYCO_HOME set to that home');
  expect(fs.existsSync(home)).toBe(false);
});

it('names the physical home through a symlink', () => {
  const home = path.join(root, 'physical');
  const link = path.join(root, 'alias');
  fs.mkdirSync(home);
  fs.symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(missingDeploymentRecordMessage(link)).toContain(path.join(home, 'server', 'cloudflare', 'record.json'));
});

it.skipIf(process.platform === 'win32').each(['project', 'machine'])('explains the home chosen by a %s runtime command pin through the CLI shim', (scope) => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const workingDirectory = path.join(root, 'work');
  fs.mkdirSync(workingDirectory);
  const pinDirectory = path.join(scope === 'project' ? workingDirectory : process.env.HOME!, '.myco');
  fs.mkdirSync(pinDirectory);
  const wrapper = path.join(root, 'pinned-myco');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(path.join(repository, 'packages/myco/src/cli.ts'))} "$@"\n`, { mode: 0o700 });
  const pinnedHome = path.join(root, 'pinned-home');
  fs.writeFileSync(path.join(pinDirectory, 'runtime.command'), wrapper, { mode: 0o600 });
  fs.writeFileSync(path.join(pinDirectory, 'runtime.home'), pinnedHome, { mode: 0o600 });
  const env = { ...process.env };
  delete env.MYCO_HOME;
  delete env.MYCO_REDIRECTED;
  const result = spawnSync('node', ['-e', 'delete process.env.MYCO_HOME; require(process.argv[1]);',
    path.join(repository, 'packages/myco/bin/myco.cjs'), 'server', 'status', '--target', 'cloudflare'],
    { cwd: workingDirectory, env, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(path.join(pinnedHome, 'server', 'cloudflare', 'record.json'));
  expect(result.stdout).toContain('This home comes from MYCO_HOME (set in your environment or by a runtime pin).');
});


it.each(['backup', 'hold', 'stage'] as const)('passes the explicit home record path to the %s renderer', async (surface) => {
  const explicitHome = path.join(root, 'explicit-home');
  const options = { accountId, runner, mycoHome: explicitHome };
  writeDeploymentRecord(record, explicitHome);
  const file = path.join(explicitHome, 'server', 'cloudflare', 'record.json');
  if (surface === 'backup') {
    await expect(backupCloudflareDeployment({ ...options, destination: path.join(root, 'backup') })).rejects.toThrow(file);
  } else if (surface === 'hold') {
    expect(() => cloudflareRecoveryHoldOf(options)).toThrow(file);
  } else {
    expect(() => stageCloudflareDeploy(record, explicitHome)).toThrow(file);
  }
});


it('names the missing record in a read-only setup observation', async () => {
  const home = path.join(root, 'uncreated-home');
  const facts = await observeSetup(home, { role: 'create', target: 'cloudflare' },
    { status: true, agents: () => [], legacyHomeDir: process.env.HOME, legacyHomes: [] });
  expect(facts.find(fact => fact.id === 'deployment.create')).toMatchObject({
    state: 'absent', detail: expect.stringContaining(path.join(home, 'server', 'cloudflare', 'record.json')),
  });
  expect(fs.existsSync(home)).toBe(false);
});
