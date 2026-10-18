import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { stampDevelopmentVersion } from '../../packages/myco/scripts/install-marker-schema.mjs';
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
  const value = { source, channel: 'alpha', bin: binary,
    ...(source === 'npm' ? {} : { prerelease: true, version: source === 'checkout' ? version : '2.0.0-alpha.1', binary_sha256: digest }),
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

it('keeps a long git description and unique suffix below the producer identity limit', () => {
  const stamp = stampDevelopmentVersion('myco/v2.0.0-alpha.10-123-g12345678');
  expect(stamp.length).toBeLessThan(64);
  expect(stamp).toStartWith('0.0.0-dev+2.0.0-alpha.10-123-g12345678.b');
  expect(isStampedSourceVersion(stamp)).toBe(true);
});

it('runs the build script through absolute and symlinked paths', () => {
  const script = path.resolve(import.meta.dir, '../../packages/myco/scripts/build-single-target.mjs');
  const linked = path.join(root, 'build-single-target.mjs');
  fs.symlinkSync(script, linked);
  for (const entry of [script, linked]) {
    const result = spawnSync('node', [entry], { cwd: root, env: { ...process.env, TARGET: 'bogus' }, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown TARGET="bogus"');
  }
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
  const remedy = `This binary does not match the installed source build. Run \`make source-install\` in ${value.checkout}. Running \`myco update\` instead installs the selected channel release.`;
  fs.writeFileSync(binary, 'different bytes');
  expect(readInstallation(home, version, binary)).toMatchObject({ record: 'mismatch', checkout: null, commit: null,
    detail: remedy });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ ...value, bin: path.join(root, 'different-binary') }));
  expect(readInstallation(home, version, binary).detail).toBe(remedy);
  expect(checkInstallation(home)).toMatchObject({ status: 'warn',
    detail: remedy });
});

it('offers rebuilding the recorded checkout after an interrupted adoption', () => {
  const previous = marker('checkout');
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${next}'\n`, { mode: 0o755 });
  const installation = readInstallation(home, next, binary);
  expect(installation).toMatchObject({ record: 'mismatch', checkout: null, commit: null });
  expect(installation.detail).toContain('Run `make source-install` in ' + previous.checkout);
  expect(installation.detail).toContain('`myco update` instead installs the selected channel release');
});

for (const source of ['curl', 'npm'] as const) it(`projects expected ${source} markers without a warning or refusing release updates`, async () => {
  marker(source);
  setPluginVersion('2.0.0-alpha.1');
  expect(readInstallation(home, '2.0.0-alpha.1', binary)).toMatchObject({ source, status: 'ok', detail: '2.0.0-alpha.1' });
  expect(checkInstallation(home)).toMatchObject({ status: 'ok', detail: '2.0.0-alpha.1' });
  const rows = await homeReport(home, { cwd: root, env: process.env, now: () => 1 });
  expect(rows.find(row => row.name === 'Installation')).toMatchObject({ status: 'ok', detail: '2.0.0-alpha.1' });
  const output: string[] = [];
  runStatus([], { mycoHome: home, cwd: root, stdout: line => output.push(line) });
  expect(output.join('\n')).not.toMatch(/installation record|hash/i);
  let resolved = false;
  expect(await updateBinary('manual', {}, { home, cwd: root, mycoBinary: binary, currentVersion: '2.0.0-alpha.1', probeVersion: () => '2.0.0-alpha.1',
    resolveRefs: async () => { resolved = true; return null; } })).toMatchObject({ kind: 'already-current' });
  expect(resolved).toBe(true);
});

it('keeps stale curl provenance available for export without warning or refusing a release update', async () => {
  marker('curl', 'f'.repeat(64));
  setPluginVersion('2.0.0-alpha.2');
  expect(readInstallation(home, '2.0.0-alpha.2', binary)).toMatchObject({ source: 'curl', record: 'mismatch', status: 'ok', detail: '2.0.0-alpha.2' });
  expect(checkInstallation(home)).toMatchObject({ status: 'ok', detail: '2.0.0-alpha.2' });
  const output: string[] = [];
  runStatus([], { mycoHome: home, cwd: root, stdout: line => output.push(line) });
  expect(output.join('\n')).not.toMatch(/installation record|hash/i);
  let resolved = false;
  expect(await updateBinary('manual', {}, { home, cwd: root, mycoBinary: binary, currentVersion: '2.0.0-alpha.2', probeVersion: () => '2.0.0-alpha.2',
    resolveRefs: async () => { resolved = true; return null; } })).toMatchObject({ kind: 'already-current' });
  expect(resolved).toBe(true);
});

it('reports an executable read failure while inspecting a release installation', () => {
  marker('curl');
  const read = fs.readFileSync;
  const probe = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === binary) throw new Error('fixture executable read failed');
    return read(...args);
  }) as typeof fs.readFileSync);
  try {
    expect(readInstallation(home, '2.0.0-alpha.2', binary)).toMatchObject({ record: 'unreadable', status: 'warn',
      detail: '2.0.0-alpha.2; could not inspect this installation' });
  } finally { probe.mockRestore(); }
});

it('checks the executable destination before reading its bytes', () => {
  marker('checkout');
  const otherBinary = path.join(root, 'missing-binary');
  expect(readInstallation(home, version, otherBinary)).toMatchObject({ record: 'mismatch', status: 'warn' });
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
