import { afterAll, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readInstallMarker } from '@myco/install/marker-reader.js';
import { readRunnerUpdateState } from '@myco/runner/update.js';
import { identifyLegacyExecutable } from '@myco/cli/cutover-executable.js';
import { run as remove } from '@myco/cli/remove.js';
import { validSourceInstallMarker } from '../../packages/myco/scripts/install-marker-schema.mjs';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { sandboxChildEnv, bindSandboxChildHome, resolveTestTool } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-source-marker-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const installSh = fs.readFileSync(path.join(import.meta.dir, '../../docs/install.sh'), 'utf8');
const installPs1 = fs.readFileSync(path.join(import.meta.dir, '../../docs/install.ps1'), 'utf8');
const sha = (bytes: string) => crypto.createHash('sha256').update(bytes).digest('hex');
const home = path.join(root, 'myco');
const binary = path.join(home, 'bin', 'myco');
const checkout = path.join(root, 'checkout');
const windowsCheckout = 'C:\\Users\\builder\\Repos\\myco';
const windowsUncCheckout = '\\\\builder\\source\\myco';
const jqTool = resolveTestTool('jq');
const pwshTool = resolveTestTool('pwsh');
if (process.env.CI !== undefined && (!jqTool || !pwshTool)) {
  throw new Error(`Source marker agreement requires jq and pwsh in CI (jq: ${Boolean(jqTool)}, pwsh: ${Boolean(pwshTool)})`);
}
const marker = () => ({ channel: 'stable', source: 'checkout', checkout, commit: 'a'.repeat(40),
  version: '0.0.0-dev+abcdef12.b1', binary_sha256: sha('source binary'), bin: binary, prerelease: true });
const sources = ['checkout', 'curl', 'npm'] as const;
const installedMarker = (source: typeof sources[number]) => source === 'checkout' ? marker() :
  { channel: 'stable', source, version: '2.0.0', binary_sha256: sha('source binary'), bin: binary, prerelease: false };
const writeMarker = (value: unknown) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify(value)); };

function shellRead(key: string, jq: boolean) {
  const start = installSh.indexOf('decode_json() {');
  const end = installSh.indexOf('\njson_string() {', start);
  const tools = path.join(root, jq ? 'jq-tools' : 'awk-tools');
  fs.mkdirSync(tools, { recursive: true });
  for (const tool of ['awk', ...(jq ? ['jq'] : [])]) {
    const executable = resolveTestTool(tool);
    if (executable && !fs.existsSync(path.join(tools, tool))) fs.symlinkSync(executable, path.join(tools, tool));
  }
  return spawnSync('/bin/sh', ['-c', `${installSh.slice(start, end)}\ndecode_json "$1" "$2"`, 'sh', path.join(home, 'install.json'), key],
    { cwd: root, env: sandboxChildEnv(root, { PATH: tools }), encoding: 'utf8' });
}

function powershellRead(explicitChannel = false) {
  const start = installPs1.indexOf('if (Test-Path $Marker)');
  const end = installPs1.indexOf('# Ensure TLS 1.2 is enabled', start);
  const probe = path.join(root, 'marker-read.ps1');
  fs.writeFileSync(probe, `$ErrorActionPreference = 'Stop'
$PSStyle.OutputRendering = 'PlainText'
$Marker = '${path.join(home, 'install.json').replaceAll("'", "''")}'
$InstallMarker = $null
$Channel = '${explicitChannel ? 'stable' : ''}'
$ChannelExplicit = ${explicitChannel ? '$true' : '$false'}
try {
${installPs1.slice(start, end)}
Write-Output $InstallMarker.version
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`);
  return spawnSync('pwsh', ['-NoProfile', '-File', probe], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' });
}

describe('install marker reader agreement', () => {
  it('admits a hash-bound source checkout across TypeScript, shell and PowerShell', () => {
    for (const sourceCheckout of [checkout, windowsCheckout, windowsUncCheckout]) {
      const sourceMarker = { ...marker(), checkout: sourceCheckout };
      writeMarker(sourceMarker);
      expect(readInstallMarker(home, true)).toMatchObject(sourceMarker);
      for (const jq of [false, true]) {
        if (jq && !jqTool) continue;
        expect(shellRead('marker', jq)).toMatchObject({ status: 0, stdout: 'stable\n' });
        expect(shellRead('version', jq)).toMatchObject({ status: 0, stdout: `${marker().version}\n` });
        expect(shellRead('binary_sha256', jq)).toMatchObject({ status: 0, stdout: `${marker().binary_sha256}\n` });
      }
      if (pwshTool) expect(powershellRead()).toMatchObject({ status: 0, stdout: `${marker().version}\n` });
    }
    expect(path.win32.normalize(checkout)).not.toBe(checkout);
    expect(validSourceInstallMarker(marker(), path.win32)).toBe(true);
    const { prerelease: _prerelease, ...withoutPrerelease } = marker();
    writeMarker(withoutPrerelease);
    expect(readInstallMarker(home, true)?.source).toBe('checkout');
    expect(shellRead('marker', false).status).toBe(0);
    if (jqTool) expect(shellRead('marker', true).status).toBe(0);
    if (pwshTool) expect(powershellRead().status).toBe(0);
  });

  for (const [name, change] of [
    ['noncanonical checkout', { checkout: `${checkout}/../other` }], ['invalid channel', { channel: 'nope' }],
    ['POSIX root', { checkout: '/' }], ['Windows root', { checkout: 'C:\\' }],
    ['Windows dot segment', { checkout: 'C:\\Users\\builder\\..\\myco' }],
    ['Windows current segment', { checkout: 'C:\\Users\\builder\\.\\myco' }],
    ['Windows repeated separator', { checkout: 'C:\\Users\\\\builder\\myco' }],
    ['Windows trailing separator', { checkout: `${windowsCheckout}\\` }],
    ['UNC share root', { checkout: '\\\\builder\\source\\' }],
    ['POSIX trailing separator', { checkout: `${checkout}/` }],
    ['POSIX current segment', { checkout: `${checkout}/./myco` }],
    ['POSIX repeated separator', { checkout: `${checkout}//myco` }],
    ['short commit', { commit: 'a'.repeat(39) }], ['release version', { version: '2.0.0+source' }],
    ['empty build id', { version: '0.0.0-dev+.b1' }], ['empty build segment', { version: '0.0.0-dev+abc..b1' }],
    ['version with newline', { version: `${marker().version}\n` }], ['short binary hash', { binary_sha256: 'b'.repeat(63) }],
    ['string prerelease', { prerelease: 'yes' }], ['null prerelease', { prerelease: null }],
    ['object prerelease', { prerelease: {} }], ['array prerelease', { prerelease: [] }],
  ] as const) it(`rejects source marker ${name}`, () => {
      writeMarker({ ...marker(), ...change });
      expect(() => readInstallMarker(home, true)).toThrow('Invalid install marker');
      for (const jq of [false, true]) {
        if (jq && !jqTool) continue;
        expect(shellRead('marker', jq).status).not.toBe(0);
      }
      if (pwshTool) expect(powershellRead().status).not.toBe(0);
  });

  it('lets an explicit PowerShell channel bypass an invalid checkout marker', () => {
    writeMarker({ ...marker(), channel: 'nope' });
    if (pwshTool) {
      expect(powershellRead()).toMatchObject({ status: 1, stderr: expect.stringContaining('Pass -Channel stable') });
      expect(powershellRead(true)).toMatchObject({ status: 0, stdout: `${marker().version}\n` });
    }
  });

  it('lets an explicit PowerShell channel recover from unreadable marker JSON', () => {
    fs.writeFileSync(path.join(home, 'install.json'), '{"source":"checkout"');
    if (pwshTool) {
      expect(powershellRead()).toMatchObject({ status: 1, stderr: expect.stringContaining('Pass -Channel stable') });
      expect(powershellRead(true)).toMatchObject({ status: 0, stdout: expect.stringContaining('using the explicit channel') });
    }
  });

  it('rejects a numeric commit even when its printed form has forty hex digits', () => {
    const digits = '1'.repeat(40);
    fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ ...marker(), commit: digits }).replace(`"commit":"${digits}"`, `"commit":${digits}`));
    expect(() => readInstallMarker(home, true)).toThrow('Invalid install marker');
    if (pwshTool) expect(powershellRead().status).not.toBe(0);
  });

  it('keeps curl/npm strict acceptance and foreign-marker refusal', () => {
    for (const source of ['curl', 'npm'] as const) {
      writeMarker({ source, channel: 'stable', bin: binary });
      expect(readInstallMarker(home, true)?.source).toBe(source);
      expect(shellRead('marker', false)).toMatchObject({ status: 0, stdout: 'stable\n' });
      if (jqTool) expect(shellRead('marker', true).status).toBe(0);
      if (pwshTool) expect(powershellRead().status).toBe(0);
    }
    writeMarker({ source: 'other', channel: 'stable', bin: binary });
    expect(() => readInstallMarker(home, true)).toThrow('Invalid install marker');
    expect(shellRead('marker', false).status).toBe(0);
    if (jqTool) expect(shellRead('marker', true).status).toBe(0);
    if (pwshTool) expect(powershellRead().status).toBe(0);
  });

  it('decodes a source checkout in the runner journal and quarantines malformed source identity', () => {
    const file = path.join(home, 'runner', 'update.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const transaction = { id: 'tx', serverUrl: 'https://example.invalid', fromVersion: '2.0.0', toVersion: '2.0.1',
      binaryPath: binary, home, phase: 'waiting', ownerPid: 1, startedAt: 1,
      serviceSpec: { binaryPath: binary }, installMarker: marker() };
    const state = { version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0, transaction };
    for (const source of sources) {
      const fromVersion = source === 'checkout' ? marker().version : '2.0.0';
      const toVersion = source === 'checkout' ? marker().version.replace('.b1', '.b2') : '2.0.1';
      fs.writeFileSync(file, JSON.stringify({ ...state, transaction: { ...transaction, fromVersion, toVersion, installMarker: installedMarker(source) } }));
      expect(readRunnerUpdateState(home).transaction).toMatchObject({ fromVersion, toVersion, installMarker: installedMarker(source) });
    }
    fs.writeFileSync(file, JSON.stringify({ ...state, transaction: { ...transaction, installMarker: { ...marker(), commit: 'short' } } }));
    expect(readRunnerUpdateState(home).transaction).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('update.json.quarantine-'))).toBe(true);
  });

  it('classifies only a hash-bound source binary as modern during cutover recovery', () => {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'source binary');
    const unit = { executable: binary, home };
    for (const source of sources) {
      writeMarker(installedMarker(source));
      expect(identifyLegacyExecutable(unit).currentIs2).toBe(true);
    }
    writeMarker({ ...marker(), commit: 'short' });
    expect(identifyLegacyExecutable(unit).currentIs2).toBe(false);
    writeMarker({ ...marker(), binary_sha256: '0'.repeat(64) });
    expect(identifyLegacyExecutable(unit).currentIs2).toBe(false);
  });

  it('recognizes a checkout marker as dedicated-home purge ownership', async () => {
    const restore = bindSandboxChildHome(root);
    const previousExitCode = process.exitCode;
    const platform = recordingPlatform();
    const deps = { mycoHome: home, worker: { home: root, platform: 'darwin' as const, runner: platform.runner, binaryPath: binary } };
    try {
      for (const source of sources) {
        writeMarker(installedMarker(source));
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, 'source binary');
        await remove(['--purge', '--yes'], deps);
        expect(process.exitCode).not.toBe(1);
        expect(fs.existsSync(home)).toBe(false);
      }
      writeMarker({ ...marker(), commit: 'short' });
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, 'source binary');
      await expect(remove(['--purge', '--yes'], deps)).rejects.toThrow('not a Myco install marker');
      expect(fs.existsSync(binary)).toBe(true);
    } finally {
      restore();
      process.exitCode = previousExitCode;
    }
  });

  it('keeps generated standalone marker readers current', () => {
    const generator = path.join(import.meta.dir, '../../packages/myco/scripts/gen-release-selector.mjs');
    expect(spawnSync(process.execPath, [generator, '--check'], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' }))
      .toMatchObject({ status: 0, stderr: '' });
  });
});
