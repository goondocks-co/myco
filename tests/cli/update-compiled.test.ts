import { afterAll, beforeAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-compiled-'));
const from = '2.0.0-alpha.2';
const to = '2.0.0-alpha.3';
const old = path.join(root, 'old-myco');
const release = path.join(root, 'release-myco');
const releases = path.join(root, 'releases.json');
const hash = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
beforeAll(() => {
  for (const [version, binary] of [[from, old], [to, release]]) {
    const built = spawnSync(process.execPath, ['build', '--compile', 'tests/fixtures/update/cli.ts', '--define', `FIXTURE_VERSION=${JSON.stringify(version)}`, '--outfile', binary], {
      cwd: process.cwd(), env: sandboxChildEnv(root), encoding: 'utf8', timeout: 120_000,
    });
    expect({ status: built.status, stderr: built.stderr }).toMatchObject({ status: 0 });
    if (process.platform === 'darwin') expect(spawnSync('codesign', ['--force', '--sign', '-', binary], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' }).status).toBe(0);
  }
  const asset = `myco-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
  const sums = path.join(root, 'SHA256SUMS');
  fs.writeFileSync(sums, `${hash(release)}  ${asset}\n`);
  fs.writeFileSync(releases, JSON.stringify([{ tag_name: `myco/v${to}`, prerelease: true, assets: [
    { name: asset, browser_download_url: pathToFileURL(release).href },
    { name: 'SHA256SUMS', browser_download_url: pathToFileURL(sums).href },
  ] }]));
}, 180_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
for (const mode of ['member', 'runner', 'both']) it(`compiled myco update --check then update from a local fixture release in a ${mode} home`, () => {
  const cwd = path.join(root, mode); fs.mkdirSync(cwd);
  const env = sandboxChildEnv(cwd, { MYCO_FIXTURE_RELEASES: releases, MYCO_FIXTURE_PACKAGE_ROOT: path.resolve('packages/myco') });
  const invoke = (program: string, ...args: string[]) => {
    const ran = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    expect({ args, status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0, stderr: '' });
    return ran.stdout;
  };
  invoke(old, 'prepare', mode);
  const installed = path.join(env.MYCO_HOME!, 'bin', 'myco');
  const before = hash(installed);
  const checked = invoke(installed, 'update', '--check');
  expect(checked).toContain(`from ${from} to ${to} on channel alpha`);
  expect(checked).toContain('Agents refreshed: no (check only)');
  expect(hash(installed)).toBe(before);
  const updated = invoke(installed, 'update');
  expect(updated).toContain(`from ${from} to ${to} on channel alpha`);
  expect(updated.match(/Myco: from/g)).toHaveLength(1);
  if (mode !== 'member') {
    expect(updated).toContain('awaiting idle service handoff');
    expect(hash(installed)).toBe(before);
    invoke(installed, 'finish-handoff');
  } else expect(updated).toContain('Agents refreshed: yes');
  expect(invoke(installed, '--version').trim()).toBe(to);
  expect(hash(installed)).toBe(hash(release));
  if (mode !== 'runner') expect(JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'member', 'provisioned.json'), 'utf8')).version).toBe(to);
  expect(JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'install.json'), 'utf8')).channel).toBe('alpha');
}, 60_000);
it('a busy compiled runner queues the update without staging, restarting or replacing its program', () => {
  const cwd = path.join(root, 'busy'); fs.mkdirSync(cwd);
  const env = sandboxChildEnv(cwd, { MYCO_FIXTURE_RELEASES: releases, MYCO_FIXTURE_PACKAGE_ROOT: path.resolve('packages/myco') });
  const invoke = (...args: string[]) => spawnSync(old, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  expect(invoke('prepare', 'runner').status).toBe(0);
  const installed = path.join(env.MYCO_HOME!, 'bin', 'myco');
  const before = hash(installed);
  const ran = spawnSync(installed, ['update'], { cwd, env: { ...env, MYCO_FIXTURE_BUSY: '1' }, encoding: 'utf8', timeout: 30_000 });
  expect({ status: ran.status, stderr: ran.stderr }).toEqual({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Runner is busy; the update is queued for between runs. Next: myco runner status');
  expect(hash(installed)).toBe(before);
  const state = JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'fixture-service-state.json'), 'utf8'));
  expect(state.commands).toEqual([]);
  const journal = JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'runner', 'update.json'), 'utf8'));
  expect(journal.transaction).toBeUndefined();
  expect(Object.values(journal.requests)).toHaveLength(1);
});
