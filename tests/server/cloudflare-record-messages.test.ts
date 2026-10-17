import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { backupCloudflareDeployment, cloudflareRecoveryHoldOf } from '@myco/server/cloudflare-backup.js';
import { destroyCloudflareDeployment, rollbackCloudflareDeployment, updateCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { setupCloudflareOwner } from '@myco/server/cloudflare-owner.js';
import { restoreCloudflareDeployment } from '@myco/server/cloudflare-recovery.js';
import { missingDeploymentRecordMessage, writeDeploymentRecord } from '@myco/server/cloudflare.js';
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
  await expect(updateCloudflareDeployment(options())).rejects.toThrow(recordFile());
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
it.each(['status', 'config'])('names the %s record file', async (command) => {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  console.log = console.error = (...parts) => { lines.push(parts.map(String).join(' ')); };
  process.exit = (() => { throw new Error('fixture exit'); }) as typeof process.exit;
  try {
    try { await run([command, '--target', 'cloudflare'], { runner }); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'fixture exit') throw error; }
    expect(lines.join('\n')).toContain(`No Cloudflare Deployment record in ${recordFile()}.`);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
it('names the occupied recovery home', async () => {
  writeDeploymentRecord(record, process.env.MYCO_HOME);
  await expect(restoreCloudflareDeployment({ ...options(), sourceRetired: true, source: path.join(root, 'source'), secretsFile: path.join(root, 'secrets') }))
    .rejects.toThrow(`Cloudflare Deployment record already exists in ${process.env.MYCO_HOME}.`);
});
it('does not attribute an explicit home to the environment', () => {
  const message = missingDeploymentRecordMessage(path.join(root, 'explicit'));
  expect(message).toContain(path.join(root, 'explicit', 'server', 'cloudflare', 'record.json'));
  expect(message).not.toContain('This home comes from');
  expect(message).not.toContain('This is the default home.');
  expect(message).toContain('MYCO_HOME set to that home');
});
