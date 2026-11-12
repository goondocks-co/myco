import { expect } from 'bun:test'; import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path'; import os from 'node:os'; import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

let root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-pwsh-'));
const installRoot = () => (fs.existsSync(root) ? root : (root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-pwsh-'))));
export const removeInstallRoot = () => { fs.rmSync(root, { recursive: true, force: true }); };

export const SCRIPT = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'docs', 'install.ps1'), 'utf8');
export const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { cwd: installRoot(), env: sandboxChildEnv(installRoot()), encoding: 'utf8' }).stdout.trim();
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const release = (version: string, extra = {}) => ({
  tag_name: `myco/v${version}`, prerelease: version.includes('-'), draft: false,
  assets: [{ name: 'myco-windows-x64.exe' }, { name: 'myco-windows-arm64.exe' }, { name: 'SHA256SUMS' }], ...extra,
});
export const beforeGa = [release('1.4.9'), release('1.4.10-beta.1'), release('2.0.0-alpha.10'), release('2.0.0-beta.2')];

export function select(releases: unknown[], opts: { channel?: string; current?: string; sourceCheckout?: boolean; npmOrigin?: boolean; evidence?: 'marker' | 'slot' | 'unknown'; state?: 'member' | 'cutover' | 'symlink' | 'empty' | 'vault'; replace?: boolean; install?: string; joined?: boolean; probe?: boolean; stale?: boolean; staleVersion?: string; staleChannel?: string; refreshFailure?: boolean; failPreserve?: boolean; truncatePreserve?: boolean; failRecord?: boolean; arch?: 'AMD64' | 'ARM64' | 'x64-emulated-on-ARM64'; sumsName?: string } = {}) {
  const home = fs.mkdtempSync(path.join(installRoot(), 'home-'));
  const mycoHome = path.join(home, '.myco');
  const bin = path.join(home, 'bin');
  const executed = path.join(home, 'executed-existing');
  fs.mkdirSync(mycoHome);
  fs.mkdirSync(bin);
  const exe = path.join(bin, 'myco.exe');
  if (opts.current) {
    const target = opts.state === 'symlink' ? path.join(home, 'existing-2.x') : exe;
    fs.writeFileSync(target, opts.state === 'empty' ? '' : `#!/bin/sh\necho executed > '${executed}'\necho ${opts.current}\n`, { mode: 0o755 });
    if (opts.state === 'symlink') fs.symlinkSync(target, exe, 'file');
    if ((opts.evidence ?? 'marker') === 'marker') fs.writeFileSync(path.join(mycoHome, 'install.json'), JSON.stringify({ channel: opts.channel ?? 'stable', version: opts.current, bin: exe, binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),
      ...(opts.sourceCheckout ? { source: 'checkout', checkout: home, commit: 'a'.repeat(40) } : {}) }));
    if (opts.evidence === 'slot' || opts.stale) {
      const slot = path.join(bin, 'versions', opts.current, 'myco.exe');
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.copyFileSync(exe, slot);
    }
    if (opts.npmOrigin) fs.writeFileSync(path.join(mycoHome, 'install.json'), JSON.stringify({
      source: 'npm', channel: opts.channel ?? 'stable', bin: exe,
      ...(opts.current.startsWith('2.') ? { version: opts.current, binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') } : {}),
    }));
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
  if (argc > 1 && strcmp(argv[1], "--version") == 0) {
    const char *probe = getenv("MYCO_PROBE_LOG");
    if (probe) {
      FILE *log = fopen(probe, "w");
      const char *keys[] = {"HOME", "MYCO_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"};
      if (!log) return 1;
      for (int i=0;i<5;i++) fprintf(log, "%s=%s\\n", keys[i], getenv(keys[i]) ? getenv(keys[i]) : "");
      fclose(log);
    }
    puts("${opts.install}"); return 0;
  }
  char file[4096]; snprintf(file, sizeof file, "%s/commands.log", getenv("MYCO_HOME"));
  FILE *log = fopen(file, "a");
  if (log) { for (int i=1;i<argc;i++) fprintf(log, "%s%s", i>1 ? " " : "", argv[i]); fputc('\\n', log); fclose(log); }
  return ${opts.refreshFailure ? 3 : 0};
}
`);
    const compiled = spawnSync('cc', ['-o', artifact, source], { cwd: home, env: sandboxChildEnv(home), encoding: 'utf8' });
    expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
    const sums = path.join(home, 'SHA256SUMS');
    const asset = opts.sumsName ?? (opts.arch === undefined || opts.arch === 'AMD64' ? 'myco-windows-x64.exe' : 'myco-windows-arm64.exe');
    fs.writeFileSync(sums, `${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}  ${asset}\n`);
    download = `if ($OutFile) { Copy-Item $(if ($Uri.EndsWith('SHA256SUMS')) { ${quote(sums)} } else { ${quote(artifact)} }) $OutFile; return }`;
  }
  if (opts.joined || opts.state === 'member' || opts.state === 'cutover') {
    const membership = path.join(mycoHome, 'member', opts.state === 'cutover' ? 'cutover.json' : 'deployments/dep.json');
    fs.mkdirSync(path.dirname(membership), { recursive: true });
    fs.writeFileSync(membership, '{}');
  }
  if (opts.state === 'vault') {
    const vault = path.join(mycoHome, 'groves/g/myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true }); fs.writeFileSync(vault, 'legacy vault');
  }
  if (opts.failRecord) fs.mkdirSync(path.join(mycoHome, 'legacy-executable.json'));
  const before = opts.current ? fs.readFileSync(exe) : undefined;
  const linkBefore = opts.state === 'symlink' ? fs.readlinkSync(exe) : undefined;
  const file = path.join(home, 'install.ps1');
  fs.writeFileSync(file, SCRIPT);
  const copyFailure = opts.failPreserve || opts.truncatePreserve ? `function Copy-Item {
    param($Path, $Destination, [switch]$Force, $LiteralPath, $ErrorAction)
    if ($Destination -like '*myco.legacy') { ${opts.truncatePreserve ? "[System.IO.File]::WriteAllText($Destination, ''); return" : "throw 'fixture preservation copy failure'"} }
    if ($LiteralPath) { Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force }
    else { Microsoft.PowerShell.Management\\Copy-Item -Path $Path -Destination $Destination -Force }
  }` : '';
  const userAgents = path.join(home, 'user-agents.log');
  // x64 PowerShell under ARM64 emulation reports AMD64 in its own environment; only the machine's registry says ARM64.
  const machine = opts.arch === 'x64-emulated-on-ARM64' ? "function Get-ItemProperty { [PSCustomObject]@{ PROCESSOR_ARCHITECTURE = 'ARM64' } }" : '';
  const program = `${copyFailure}
  ${machine}
  function Invoke-WebRequest { param($Uri, $Headers, $OutFile, [switch]$UseBasicParsing, $ErrorAction)
    if ($Headers) { Add-Content -LiteralPath ${quote(userAgents)} -Value $Headers['User-Agent'] }
    ${download}
    [PSCustomObject]@{ Content = ${quote(JSON.stringify(releases))} }
  }
  & ${quote(file)} ${opts.install ? '' : '-DryRun'} ${opts.replace ? '-Replace14' : ''}
  `;
  const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', program], {
    cwd: home, env: sandboxChildEnv(home, { NO_COLOR: '1', PROCESSOR_ARCHITECTURE: opts.arch === 'ARM64' ? 'ARM64' : 'AMD64', PROCESSOR_ARCHITEW6432: '', LOCALAPPDATA: home,
      MYCO_BIN_DIR: bin, ...(opts.probe ? { MYCO_PROBE_LOG: path.join(home, 'probe-env.log') } : {}), ...(opts.channel ? { MYCO_CHANNEL: opts.channel } : {}) }),
    encoding: 'utf8', timeout: 60_000,
  });
  if (run.error) throw run.error;
  expect(fs.existsSync(executed)).toBe(false);
  const sentUserAgents = fs.existsSync(userAgents) ? fs.readFileSync(userAgents, 'utf8').trim().split(/\r?\n/) : [];
  return { status: run.status, mycoHome, out: `${run.stdout}${run.stderr}`, home, exe, before, linkBefore, sentUserAgents };
}
