/** The Windows installer's real classification and release selection, with fixture GitHub responses. */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-pwsh-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const SCRIPT = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'docs', 'install.ps1'), 'utf8');
const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' }).stdout.trim();
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const release = (version: string, extra = {}) => ({
  tag_name: `myco/v${version}`, prerelease: version.includes('-'), draft: false,
  assets: [{ name: 'myco-windows-x64.exe' }, { name: 'SHA256SUMS' }], ...extra,
});
const beforeGa = [release('1.4.9'), release('1.4.10-beta.1'), release('2.0.0-alpha.10'), release('2.0.0-beta.2')];

function select(releases: unknown[], opts: { channel?: string; current?: string; evidence?: 'marker' | 'slot' | 'unknown'; replace?: boolean; install?: string; joined?: boolean; stale?: boolean; staleVersion?: string; staleChannel?: string; refreshFailure?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const mycoHome = path.join(home, '.myco');
  const bin = path.join(home, 'bin');
  const executed = path.join(home, 'executed-existing');
  fs.mkdirSync(mycoHome);
  fs.mkdirSync(bin);
  if (opts.current) {
    const exe = path.join(bin, 'myco.exe');
    fs.writeFileSync(exe, `#!/bin/sh\necho executed > '${executed}'\necho ${opts.current}\n`, { mode: 0o755 });
    if ((opts.evidence ?? 'marker') === 'marker') fs.writeFileSync(path.join(mycoHome, 'install.json'), JSON.stringify({ channel: opts.channel ?? 'stable', version: opts.current, bin: exe, binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') }));
    if (opts.evidence === 'slot' || opts.stale) {
      const slot = path.join(bin, 'versions', opts.current, 'myco.exe');
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.copyFileSync(exe, slot);
    }
    if (opts.stale) fs.writeFileSync(path.join(mycoHome, 'install.json'), JSON.stringify({ channel: opts.staleChannel ?? 'stable', version: opts.staleVersion ?? '1.4.8', bin: exe, binary_sha256: '0'.repeat(64) }));
  }
  let download = '';
  if (opts.install) {
    const source = path.join(home, 'fixture.c');
    const artifact = path.join(home, 'fixture.exe');
    fs.writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("${opts.install}"); return 0; }
  char file[4096]; snprintf(file, sizeof file, "%s/commands.log", getenv("MYCO_HOME"));
  FILE *log = fopen(file, "a");
  if (log) { for (int i=1;i<argc;i++) fprintf(log, "%s%s", i>1 ? " " : "", argv[i]); fputc('\\n', log); fclose(log); }
  return ${opts.refreshFailure ? 3 : 0};
}
`);
    const compiled = spawnSync('cc', ['-o', artifact, source], { cwd: home, env: sandboxChildEnv(home), encoding: 'utf8' });
    expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
    const sums = path.join(home, 'SHA256SUMS');
    fs.writeFileSync(sums, `${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}  myco-windows-x64.exe\n`);
    download = `if ($OutFile) { Copy-Item $(if ($Uri.EndsWith('SHA256SUMS')) { ${quote(sums)} } else { ${quote(artifact)} }) $OutFile; return }`;
  }
  if (opts.joined) {
    const membership = path.join(mycoHome, 'member/deployments/dep.json');
    fs.mkdirSync(path.dirname(membership), { recursive: true });
    fs.writeFileSync(membership, '{}');
  }
  const file = path.join(home, 'install.ps1');
  fs.writeFileSync(file, SCRIPT);
  const program = `function Invoke-WebRequest { param($Uri, $Headers, $OutFile, [switch]$UseBasicParsing, $ErrorAction)
    ${download}
    [PSCustomObject]@{ Content = ${quote(JSON.stringify(releases))} }
  }
  & ${quote(file)} ${opts.install ? '' : '-DryRun'} ${opts.replace ? '-Replace14' : ''}
  `;
  const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', program], {
    cwd: home, env: sandboxChildEnv(home, { PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: '', LOCALAPPDATA: home,
      MYCO_BIN_DIR: bin, ...(opts.channel ? { MYCO_CHANNEL: opts.channel } : {}) }),
    encoding: 'utf8', timeout: 60_000,
  });
  if (run.error) throw run.error;
  expect(fs.existsSync(executed)).toBe(false);
  return { status: run.status, mycoHome, out: `${run.stdout}${run.stderr}`, home };
}

describe('the Windows installer', () => {
  it.skipIf(PWSH === '')('fresh default chooses beta before alpha, then stable after GA', () => {
    expect(select(beforeGa).out).toContain('Found: myco/v2.0.0-beta.2');
    expect(select([...beforeGa, release('2.1.0-alpha.99')]).out).toContain('Found: myco/v2.0.0-beta.2');
    expect(select([release('1.4.9'), release('2.0.0-alpha.2'), release('2.0.0-alpha.10')]).out).toContain('Found: myco/v2.0.0-alpha.10');
    expect(select([...beforeGa, release('2.0.0'), release('2.1.0-beta.1')]).out).toContain('Found: myco/v2.0.0');
  });

  it.skipIf(PWSH === '')('fresh machines never fall back to 1.x, including explicit stable and beta', () => {
    for (const channel of [undefined, 'stable', 'beta']) {
      const run = select([release('1.4.9')], { channel });
      expect(run.status).not.toBe(0);
      expect(run.out).not.toContain('Found: myco/v1.');
    }
    expect(select(beforeGa, { channel: 'stable' }).status).not.toBe(0);
    expect(select(beforeGa, { channel: 'alpha' }).out).toContain('Found: myco/v2.0.0-beta.2');
  });

  it.skipIf(PWSH === '')('existing 1.x stays on 1.x after GA; explicit replacement selects 2.x', () => {
    const releases = [...beforeGa, release('2.0.0')];
    expect(select(releases, { current: '1.4.8' }).out).toContain('Found: myco/v1.4.9');
    expect(select(releases, { current: '1.4.8', channel: 'beta' }).out).toContain('Found: myco/v1.4.10-beta.1');
    expect(select(beforeGa, { current: '1.4.8', replace: true }).out).toContain('Found: myco/v2.0.0-beta.2');
    for (const evidence of ['marker', 'slot', 'unknown'] as const) {
      expect(select(releases, { current: '1.4.8', evidence }).out).toContain('Found: myco/v1.4.9');
    }
  });

  it.skipIf(PWSH === '')('a stale 1.4 marker cannot downgrade the live 2.x binary', () => {
    const run = select([...beforeGa, release('2.0.0')], { current: '2.0.0-beta.2', stale: true });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Found: myco/v2.0.0');
    expect(run.out).not.toContain('Found: myco/v1.');
    const beforeStable = select(beforeGa, { current: '2.0.0-beta.2', stale: true, install: process.platform === 'win32' ? undefined : '2.0.0-beta.2' });
    expect(beforeStable.status).toBe(0);
    expect(beforeStable.out).toContain('Found: myco/v2.0.0-beta.2');
    if (process.platform !== 'win32') expect(JSON.parse(fs.readFileSync(path.join(beforeStable.mycoHome, 'install.json'), 'utf8')).channel).toBe('beta');
  });

  it.skipIf(PWSH === '')('keeps the recorded preview channel across an interrupted 2.x update', () => {
    const run = select([...beforeGa, release('2.1.0-alpha.99')], {
      current: '2.0.0-beta.2', stale: true, staleVersion: '2.0.0-alpha.1', staleChannel: 'alpha',
    });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Found: myco/v2.1.0-alpha.99');
  });

  it.skipIf(PWSH === '')('preserves recorded channels and refuses downgrades', () => {
    const run = select(beforeGa, { current: '2.0.0-beta.10', channel: 'beta' });
    expect(run.status).toBe(0);
    expect(run.out).toContain('staying put');
    expect(select(beforeGa, { current: '2.0.0-alpha.1', channel: 'alpha' }).out).toContain('Found: myco/v2.0.0-beta.2');
  });

  it.skipIf(PWSH === '')('uses shared numeric semver and rejects drafts, malformed tags, RCs and incomplete assets', () => {
    const bad = [release('9.0.0garbage'), release('9.0.0-rc.1'), release('9.0.0', { draft: true }),
      release('9.1.0', { prerelease: true }), release('9.2.0', { assets: [] }), release('09.0.0')];
    expect(select([...beforeGa, ...bad, release('2.0.0-beta.10')], { channel: 'beta' }).out).toContain('Found: myco/v2.0.0-beta.10');
  });
  it.skipIf(PWSH === '' || process.platform === 'win32')('installs fixture releases and only refreshes a joined 2.x member', () => {
    for (const scenario of [
      { install: '2.0.0-beta.2' },
      { install: '2.0.0-beta.2', current: '1.4.8', replace: true },
      { install: '2.0.0-beta.2', joined: true },
      { install: '1.4.9', current: '1.4.8' },
    ]) {
      const run = select(beforeGa, scenario);
      expect({ scenario, status: run.status, out: run.status ? run.out : '' }).toEqual({ scenario, status: 0, out: '' });
      const marker = JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8'));
      expect(marker).toMatchObject({ version: scenario.install, channel: scenario.install.startsWith('1.') ? 'stable' : 'beta' });
      const commands = path.join(run.mycoHome, 'commands.log');
      if (scenario.joined) expect(fs.readFileSync(commands, 'utf8')).toBe('member provision --refresh\n');
      else expect(fs.existsSync(commands)).toBe(false);
      if (!scenario.current && !scenario.joined) {
        expect(run.out).toContain('myco login <your-myco-address>');
        expect(run.out).toContain('docs/self-hosting.md');
        expect(run.out).not.toContain('myco setup');
      }
    }
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('keeps a completed install and gives a retry when joined-member refresh fails', () => {
    const run = select(beforeGa, { install: '2.0.0-beta.2', joined: true, refreshFailure: true });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Refresh failed');
    expect(run.out).toContain('Run: myco member provision --refresh');
    expect(JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8')).channel).toBe('beta');
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('refuses an exit-zero artifact that reports another version', () => {
    const run = select([release('2.0.0-beta.2')], { install: '2.0.0-beta.1' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('did not report the selected version');
    expect(fs.existsSync(path.join(run.mycoHome, 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(run.home, 'bin', 'myco.exe'))).toBe(false);
  });

});
