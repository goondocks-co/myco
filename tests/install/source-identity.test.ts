import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampDevelopmentVersion } from '../../packages/myco/scripts/build-single-target.mjs';
import { isDevelopmentVersion, isStampedSourceVersion } from '../../packages/myco/scripts/release-policy.mjs';
import { readInstallation } from '@myco/install/installation.js';
import { readBinaryVersion, installedVersionSupersedes } from '@myco/runtime/binary-version.js';
import { updateBinary } from '@myco/upgrade/guarded-binary.js';
import { runnerCurrentReleaseProbe } from '@myco/runner/update.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { checkAutomaticUpdate, checkInstallation } from '@myco/cli/doctor-member.js';
import { runStatus, runExport } from '@myco/cli/member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { getPluginVersion, setPluginVersion } from '@myco/version.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

const version = '0.0.0-dev+2.0.0-alpha.1-4-g12345678.bfixture1';
const next = version.replace('bfixture1', 'bfixture2');
const commit = '12345678'.repeat(5);
const original = getPluginVersion();
let root: string;
let home: string;
let binary: string;
let restore: () => void;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-source-identity-'));
  restore = bindSandboxChildHome(root);
  home = path.join(root, '.myco');
  fs.mkdirSync(home, { recursive: true });
  binary = path.join(root, 'myco');
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  setPluginVersion(version);
});
afterEach(() => { setPluginVersion(original); restore(); fs.rmSync(root, { recursive: true, force: true }); });

function marker(source: 'checkout' | 'curl' | 'npm', digest: string | undefined = Bun.CryptoHasher.hash('sha256', fs.readFileSync(binary), 'hex')) {
  const value = { source, prerelease: true, channel: 'alpha', bin: binary, version: source === 'checkout' ? version : '2.0.0-alpha.1', binary_sha256: digest,
    ...(source === 'checkout' ? { checkout: path.join(root, 'deleted-checkout'), commit } : {}) };
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify(value));
  return value;
}

it('two stamps of the same commit produce distinct full source versions, including in one clock tick', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1234);
  try {
    const versions = Array.from({ length: 2 }, () => stampDevelopmentVersion('myco/v2.0.0-alpha.1-4-g12345678'));
    expect(new Set(versions).size).toBe(2);
    for (const built of versions) {
      expect(built).toMatch(/^0\.0\.0-dev\+2\.0\.0-alpha\.1-4-g12345678\.b[0-9a-z]+$/);
      expect(isDevelopmentVersion(built)).toBe(true);
      expect(isStampedSourceVersion(built)).toBe(true);
    }
    expect(isStampedSourceVersion('0.0.0-dev+fixture')).toBe(false);
    expect(isStampedSourceVersion('0.0.0-dev+foo..b1')).toBe(false);
    expect(isStampedSourceVersion(stampDevelopmentVersion(''))).toBe(true);
  } finally { clock.mockRestore(); }
});

it('preserves the full executable version through probes and source comparisons', () => {
  if (process.platform !== 'win32') {
    expect(readBinaryVersion(binary, 2_000)).toBe(version);
    expect(runnerCurrentReleaseProbe(binary, version, process.platform).runs).toBe(true);
    expect(runnerCurrentReleaseProbe(binary, next, process.platform).runs).toBe(false);
  }
  expect(installedVersionSupersedes(next, version)).toBe(true);
  expect(installedVersionSupersedes(version, next)).toBe(true);
  expect(installedVersionSupersedes(version, version)).toBe(false);
  expect(installedVersionSupersedes('2.0.0-alpha.2', '2.0.0-alpha.1')).toBe(true);
  expect(installedVersionSupersedes('2.0.0-alpha.1', '2.0.0-alpha.2')).toBe(false);
});

it('source reason wins over off and acquires no lease or release connection', async () => {
  fs.writeFileSync(path.join(home, 'install-update.json'), JSON.stringify({ automaticUpdates: false }));
  const acquire = spyOn(LifecycleLock, 'acquire');
  const network = () => { throw new Error('source update reached the network'); };
  try {
    expect(await updateBinary('automatic', {}, { home, cwd: root, currentVersion: version, resolveRefs: network, fetchReleases: network })).toEqual({ kind: 'skipped', reason: 'this is a source build' });
    expect(acquire).not.toHaveBeenCalled();
    expect(checkAutomaticUpdate(home).detail).toBe('Skipped: this is a source build');
  } finally { acquire.mockRestore(); }
});

it('projects checkout origin from a hash-bound marker after the checkout is gone', () => {
  const value = marker('checkout');
  expect(readInstallation(home, version, binary)).toMatchObject({ source: 'checkout', record: 'matching', checkout: value.checkout, commit,
    detail: `Source build from ${value.checkout}, commit 12345678` });
  expect(readInstallation(home, '2.0.0', binary)).toMatchObject({ source: 'unknown', record: 'mismatch', checkout: null, commit: null });
  fs.writeFileSync(binary, 'different bytes');
  expect(readInstallation(home, version, binary)).toMatchObject({ record: 'mismatch', checkout: null, commit: null,
    detail: 'Installation record does not match this binary' });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ ...value, bin: path.join(root, 'different-binary') }));
  expect(readInstallation(home, version, binary).detail).toBe('Installation record does not match this binary');
});

for (const source of ['curl', 'npm'] as const) it(`projects ${source} and reports stale or missing hashes without refusing release updates`, async () => {
  marker(source);
  expect(readInstallation(home, '2.0.0-alpha.1', binary)).toMatchObject({ source, record: 'matching', detail: '2.0.0-alpha.1' });
  marker(source, 'f'.repeat(64));
  expect(readInstallation(home, '2.0.0-alpha.1', binary)).toMatchObject({ source, record: 'mismatch', detail: expect.stringContaining('installation record version or hash is stale') });
  let resolved = false;
  expect(await updateBinary('manual', {}, { home, cwd: root, mycoBinary: binary, currentVersion: '2.0.0-alpha.1', probeVersion: () => '2.0.0-alpha.1',
    resolveRefs: async () => { resolved = true; return null; } })).toMatchObject({ kind: 'already-current' });
  expect(resolved).toBe(true);
  const value = marker(source);
  delete (value as { binary_sha256?: string }).binary_sha256;
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify(value));
  expect(readInstallation(home, '2.0.0-alpha.1', binary)).toMatchObject({ record: 'unverified', detail: expect.stringContaining('hash is missing') });
  value.version = '2.0.0-alpha.0';
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify(value));
  const stale = readInstallation(home, '2.0.0-alpha.1', binary);
  expect(stale.record).toBe('mismatch');
  expect(stale.detail).toContain('version or hash is stale');
  expect(stale.detail).toContain('hash is missing');
});

it('projects source and unknown origins from the running version when provenance is absent', () => {
  expect(readInstallation(home, version, binary).detail).toBe(`Source build ${version} (origin unknown)`);
  expect(readInstallation(home, '2.0.0', binary).detail).toBe('2.0.0 (origin unknown)');
});

it('doctor, member status and export use the same fresh installation projection', async () => {
  marker('checkout', Bun.CryptoHasher.hash('sha256', fs.readFileSync(process.execPath), 'hex'));
  const installed = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ ...installed, bin: process.execPath }));
  const installation = readInstallation(home);
  expect(installation.record).toBe('matching');
  expect(checkInstallation(home).detail).toBe(installation.detail);
  const rows = await homeReport(home, { cwd: root, env: process.env, now: () => 1 });
  expect(rows.find(row => row.name === 'Installation')?.detail).toBe(installation.detail);
  const output: string[] = [];
  runStatus([], { mycoHome: home, cwd: root, stdout: line => output.push(line) });
  expect(output.join('\n')).toContain(installation.detail);
  output.length = 0;
  await runExport([], { mycoHome: home, cwd: root, stdout: line => output.push(line) });
  expect(JSON.parse(output[0]!).installation).toEqual(installation);
});
