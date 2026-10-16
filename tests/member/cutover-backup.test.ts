import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CutoverBackup } from '@myco/member/cutover-backup.js';
import { identifyLegacyExecutable, LEGACY_EXECUTABLE_RECORD } from '@myco/cli/cutover-executable.js';
import type { MycoUnit } from '@myco/member/legacy-unit-files.js';
import { sandboxChildEnv, resolveTestTool } from '../../scripts/test-environment.mjs';

const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { env: process.env, encoding: 'utf8' }).stdout.trim();
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }); };
function fixture(platform: NodeJS.Platform = 'darwin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-backup-')); made.push(home);
  const executable = path.join(home, 'bin', platform === 'win32' ? 'myco.exe' : 'myco');
  write(executable, '2.0 executable');
  write(path.join(home, 'install.json'), JSON.stringify({ version: '2.0.0', bin: executable, binary_sha256: digest(executable) }));
  const unit: MycoUnit = { executable, home, file: path.join(home, 'co.goondocks.myco.service'), args: ['daemon'], label: 'co.goondocks.myco', scope: 'user' };
  write(unit.file, executable + ' daemon');
  const slot = (version: string, bytes = version) => { const file = path.join(home, 'bin', 'versions', version, path.basename(executable)); write(file, bytes); return file; };
  const backup = new CutoverBackup(path.join(home, 'backup'), 'cutover', platform);
  const recipe = () => { backup.takeLegacyUnit(unit, identifyLegacyExecutable(unit, platform)); backup.pruneUnchanged(); return fs.readFileSync(path.join(backup.dir, 'restore.md'), 'utf8'); };
  return { home, executable, unit, slot, backup, recipe };
}

function offlineLegacyDownload(home: string) {
  const tools = path.join(home, 'tools'); fs.mkdirSync(tools);
  const artifact = path.join(home, 'old'); write(artifact, '#!/bin/sh\necho 1.4.8\n');
  const asset = 'myco-darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
  const sums = path.join(home, 'sums'); write(sums, digest(artifact) + '  ' + asset + '\n');
  const requests = path.join(home, 'download-requests');
  write(path.join(tools, 'curl'), `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; --proto) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
printf '%s\n' "$url" >> '${requests}'
case "$url" in
  *matching-refs*) printf '%s' '[{"ref":"refs/tags/myco/v1.4.9"},{"ref":"refs/tags/myco/v1.4.8"}]' ;;
  *releases/tags/*1.4.9) printf '%s' '{"prerelease":false,"draft":true}' > "$out"; printf 200 ;;
  *releases/tags/*1.4.8) printf '%s' '{"prerelease":false,"draft":false}' > "$out"; printf 200 ;;
  *myco%2Fv1.4.8/SHA256SUMS) cp '${sums}' "$out" ;;
  *myco%2Fv1.4.8/myco-darwin-*) cp '${artifact}' "$out" ;;
  *) exit 97 ;;
esac
`);
  return { artifact, asset, requests, env: sandboxChildEnv(home, { PATH: tools + path.delimiter + process.env.PATH }) };
}

describe('cutover executable recovery', () => {
  it('uses the verified preservation record ahead of a daemon version and several slots', () => {
    const f = fixture(); const preserved = path.join(f.home, 'bin', 'legacy', 'old', 'myco');
    write(preserved, 'exact prior executable');
    const one = f.slot('1.4.8'); f.slot('1.4.9');
    write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version: '1.4.8' }));
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: preserved, sha256: digest(preserved), version: null, replaced_at: f.executable }));
    const result = identifyLegacyExecutable(f.unit);
    expect(result).toMatchObject({ kind: 'saved', source: preserved, version: null });
    expect(result).not.toMatchObject({ source: one });
  });

  it('searches other slots for the recorded digest instead of trusting a different daemon version', () => {
    const f = fixture(); const good = f.slot('1.4.8'); f.slot('1.4.9');
    const bad = path.join(f.home, 'bin', 'legacy', 'old', 'myco'); write(bad, 'changed');
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: bad, sha256: digest(good), version: '1.4.8', replaced_at: f.executable }));
    write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version: '1.4.9' }));
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'saved', source: good, version: '1.4.8' });
    expect(f.recipe()).toContain('does not match its recorded checksum');
  });

  it('lists ambiguous saved copies without choosing an executable', () => {
    const f = fixture(); const one = f.slot('1.4.8'); const two = f.slot('1.4.9');
    const recipe = f.recipe();
    expect(recipe).toContain('previous exact version was not recorded');
    expect(recipe).toContain('- ' + one); expect(recipe).toContain('- ' + two);
    expect(recipe).toContain('Choose the correct saved Myco 1.x executable');
    expect(recipe).not.toContain('cp -p');
    expect(recipe.indexOf('Choose the correct')).toBeLessThan(recipe.indexOf('Then start'));
  });

  it.each([undefined, '1.4.8'])('reinstalls a missing executable using recorded version %s or the latest 1.4 release', (version) => {
    const f = fixture();
    if (version) write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version }));
    const recipe = f.recipe();
    expect(recipe).toContain('No saved Myco 1.x executable could be identified.');
    expect(recipe).toContain('at ' + f.executable + ' before starting the service.');
    if (version) { expect(recipe).toContain("version='1.4.8'"); expect(recipe).not.toContain('matching-refs'); }
    else { expect(recipe).toContain('previous exact version was not recorded'); expect(recipe).toContain('latest Myco 1.4 release'); }
    const download = offlineLegacyDownload(f.home);
    const commands = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const undo = spawnSync('sh', ['-c', commands], { cwd: f.home, env: download.env, encoding: 'utf8' });
    expect({ status: undo.status, stderr: undo.stderr }).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(f.executable)).toEqual(fs.readFileSync(download.artifact));
  });

  for (const shell of ['sh', 'bash', 'zsh']) {
    const available = resolveTestTool(shell, [process.env.PATH, '/bin', '/usr/bin'].join(path.delimiter));
    it.skipIf(!available)(`runs every POSIX recovery fence in ${shell} (requires an installed ${shell})`, () => {
      for (const state of ['saved', 'missing-pinned', 'missing-latest', 'present']) {
        const f = fixture(); const download = offlineLegacyDownload(f.home);
        const settings = path.join(f.home, "agent's settings.json"); write(settings, 'original agent settings');
        f.backup.take(settings); write(settings, 'changed agent settings');
        if (state === 'saved') f.slot('1.4.8', fs.readFileSync(download.artifact, 'utf8'));
        if (state === 'missing-pinned') write(path.join(f.home, 'service/daemon.json'), JSON.stringify({ version: '1.4.8' }));
        if (state === 'present') { write(f.executable, fs.readFileSync(download.artifact, 'utf8')); f.slot('1.4.8', fs.readFileSync(download.artifact, 'utf8')); }
        const recipe = f.recipe();
        const fences = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
        expect(fences.length).toBeGreaterThan(0);
        for (const fence of fences) {
          const flags = shell === 'zsh' ? ['-f'] : shell === 'bash' ? ['--noprofile', '--norc'] : [];
          if (!available) throw new Error('The requested shell is unavailable.');
          const undo = spawnSync(available, [...flags, '-c', fence], { cwd: f.home, env: download.env, encoding: 'utf8' });
          expect({ state, code: undo.status, stderr: undo.stderr }).toEqual({ state, code: 0, stderr: '' });
        }
        expect(fs.readFileSync(f.executable)).toEqual(fs.readFileSync(download.artifact));
        expect(fs.readFileSync(settings, 'utf8')).toBe('original agent settings');
        if (state === 'missing-latest') {
          const requests = fs.readFileSync(download.requests, 'utf8').trim().split('\n');
          expect(requests.filter(url => url.includes('/releases/tags/')).map(url => url.split('myco%2Fv')[1])).toEqual(['1.4.9', '1.4.8']);
          expect(requests.filter(url => url.includes('/download/'))).toEqual([
            'https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.4.8/' + download.asset,
            'https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.4.8/SHA256SUMS',
          ]);
        }
      }
    });
  }

  it.each(['marker', 'slot'])('claims replacement of 2.x only after matching current bytes to its %s', (evidence) => {
    for (const saved of [false, true]) {
      const f = fixture(); if (saved) f.slot('1.4.8');
      if (evidence === 'slot') { fs.unlinkSync(path.join(f.home, 'install.json')); f.slot('2.0.0', fs.readFileSync(f.executable, 'utf8')); }
      expect(f.recipe()).toContain('replaces Myco 2.0 at ' + f.executable);
    }
  });

  it.each(['absent', 'wrong-digest', 'wrong-path', 'different-slot'])('describes an unidentified current executable with %s evidence', (evidence) => {
    const f = fixture(); f.slot('1.4.8'); fs.unlinkSync(path.join(f.home, 'install.json'));
    if (evidence === 'wrong-digest' || evidence === 'wrong-path') write(path.join(f.home, 'install.json'), JSON.stringify({ version: '2.0.0', bin: evidence === 'wrong-path' ? path.join(f.home, 'elsewhere') : f.executable, binary_sha256: evidence === 'wrong-digest' ? '0'.repeat(64) : digest(f.executable) }));
    if (evidence === 'different-slot') f.slot('2.0.0', 'different 2.x bytes');
    const recipe = f.recipe();
    expect(recipe).toContain('The executable at ' + f.executable + ' could not be identified and will be replaced.');
    expect(recipe).not.toContain('replaces Myco 2.0');
  });

  it('lists checksum-matching preserved copies when no version record identifies them', () => {
    const f = fixture(); const bytes = 'unclassified prior executable';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const copy = path.join(f.home, 'bin', 'legacy', hash, 'myco'); write(copy, bytes);
    const recipe = f.recipe();
    expect(recipe).toContain('- ' + copy);
    expect(recipe).toContain('previous exact version was not recorded');
    expect(recipe).toContain('Choose the correct saved Myco 1.x executable');
    expect(recipe).not.toContain('No saved Myco 1.x executable could be identified.');
  });

  it('lists a versioned slot beside an unclassified preserved copy without choosing', () => {
    const f = fixture(); const slot = f.slot('1.4.8', 'identified 1.x version');
    const bytes = 'unclassified saved bytes'; const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const preserved = path.join(f.home, 'bin', 'legacy', hash, 'myco'); write(preserved, bytes);
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'missing', candidates: [slot, preserved] });
  });

  it('uses the daemon-named slot ahead of an unclassified preserved copy', () => {
    const f = fixture(); const slot = f.slot('1.4.8', 'the recorded daemon version'); f.slot('1.4.9');
    const bytes = 'unclassified saved bytes'; const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    write(path.join(f.home, 'bin', 'legacy', hash, 'myco'), bytes);
    write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version: '1.4.8' }));
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'saved', source: slot, version: '1.4.8' });
  });

  it('retains recorded version metadata for reinstall when its executable no longer matches', () => {
    const f = fixture(); const copy = path.join(f.home, 'bin', 'legacy', 'old', 'myco'); write(copy, 'changed');
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: copy, sha256: '0'.repeat(64), version: '1.4.8', replaced_at: f.executable }));
    const recipe = f.recipe();
    expect(recipe).toContain('does not match its recorded checksum');
    expect(recipe).toContain("version='1.4.8'");
    expect(recipe).not.toContain('latest Myco 1.4 release');
  });

  it.each([false, true])('never restores a modified stable-only preserved slot (daemon state %s)', (daemon) => {
    const f = fixture(); const slot = f.slot('1.4.8', 'original 1.4 executable');
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: slot, sha256: digest(slot), version: '1.4.8', replaced_at: f.executable }));
    write(slot, 'MODIFIED after install');
    if (daemon) write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version: '1.4.8' }));
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'missing', candidates: [], version: '1.4.8' });
    const recipe = f.recipe();
    expect(recipe).toContain("version='1.4.8'"); expect(recipe).not.toContain('- ' + slot);
    expect(f.backup.all.some(entry => 'recovery' in entry && entry.recovery.kind === 'saved')).toBe(false);
    const artifact = path.join(f.home, 'pinned-original'); write(artifact, 'original 1.4 executable');
    const tools = path.join(f.home, 'tools');
    write(path.join(tools, 'curl'), `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  *myco%2Fv1.4.8/SHA256SUMS) printf '%s  myco-darwin-${process.arch}\n' '${digest(artifact)}' > "$out" ;;
  *myco%2Fv1.4.8/myco-darwin-*) cp '${artifact}' "$out" ;;
  *) exit 97 ;;
esac
`);
    const commands = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const undo = spawnSync('sh', ['-c', commands], { cwd: f.home, env: sandboxChildEnv(f.home, { PATH: tools + path.delimiter + process.env.PATH }), encoding: 'utf8' });
    expect({ status: undo.status, stderr: undo.stderr }).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(f.executable, 'utf8')).toBe('original 1.4 executable');
  });

  it.each(['daemon', 'record'])('reinstalls the %s version when only another version has a slot', (evidence) => {
    const f = fixture(); f.slot('1.4.7');
    write(path.join(f.home, evidence === 'daemon' ? 'service/daemon.json' : LEGACY_EXECUTABLE_RECORD), JSON.stringify({ version: '1.4.8', replaced_at: f.executable }));
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'missing', candidates: [], version: '1.4.8' });
    expect(f.recipe()).toContain("version='1.4.8'");
  });

  it('never lists bytes that change between identification and backup verification', () => {
    const f = fixture(); const slot = f.slot('1.4.8'); const recovery = identifyLegacyExecutable(f.unit);
    write(slot, 'changed before backup'); f.backup.takeLegacyUnit(f.unit, recovery); f.backup.pruneUnchanged();
    const recipe = fs.readFileSync(path.join(f.backup.dir, 'restore.md'), 'utf8');
    expect(recipe).toContain('changed while it was being saved'); expect(recipe).toContain("version='1.4.8'");
    expect(recipe).toContain('replaces Myco 2.0 at ' + f.executable);
    expect(recipe).not.toContain('- ' + slot); expect(recipe).not.toContain('Choose the correct');
  });

  it.each(['A', 'A2', 'A3'])('leaves an identified 1.x executable in place in probe %s', (probe) => {
    const f = fixture(); write(f.executable, 'intact 1.4.8');
    if (probe !== 'A3') f.slot('1.4.7');
    if (probe === 'A') f.slot('1.4.8', 'intact 1.4.8');
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ sha256: digest(f.executable), version: '1.4.8', replaced_at: f.executable }));
    const recipe = f.recipe(); expect(recipe).toContain('Myco 1.x executable is still in place at ' + f.executable);
    expect(recipe).not.toContain('replaces Myco 2.0'); expect(recipe).not.toContain('Reinstall'); expect(recipe).not.toContain('Choose the correct');
    expect(recipe).not.toContain('restore_binary'); expect(recipe).not.toContain('curl ');
    const commands = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    expect(spawnSync('sh', ['-c', commands], { cwd: f.home, env: sandboxChildEnv(f.home) }).status).toBe(0);
    expect(fs.readFileSync(f.executable, 'utf8')).toBe('intact 1.4.8');
  });

  it('recognizes the still-present executable from a slot or hash-bound install marker', () => {
    for (const evidence of ['slot', 'marker']) {
      const f = fixture(); write(f.executable, 'intact 1.4.8');
      if (evidence === 'slot') f.slot('1.4.8', 'intact 1.4.8');
      else write(path.join(f.home, 'install.json'), JSON.stringify({ version: '1.4.8', bin: f.executable, binary_sha256: digest(f.executable) }));
      expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'present', version: '1.4.8' });
    }
  });

  it('normalizes the replaced path and folds Windows casing and separators', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const f = fixture(platform); const copy = f.slot('1.4.8'); f.slot('1.4.9');
      const replaced = path.dirname(f.executable) + '/nested/../' + path.basename(f.executable);
      write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: copy, sha256: digest(copy), version: '1.4.8', replaced_at: platform === 'win32' ? replaced.toUpperCase().replaceAll('/', '\\') : replaced }));
      expect(identifyLegacyExecutable(f.unit, platform)).toMatchObject({ kind: 'saved', source: copy });
    }
  });

  it('contains shell failures and removes a failed restore copy temporary file', () => {
    const f = fixture(); f.slot('1.4.8'); const recipe = f.recipe();
    const fences = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
    for (const fence of fences) { expect(fence.trim().startsWith('(\nset -e\n')).toBe(true); expect(fence.trim().endsWith(')')).toBe(true); }
    const snippet = path.join(f.home, 'snippet.sh'); write(snippet, fences.join('\n'));
    const tools = path.join(f.home, 'tools'); write(path.join(tools, 'cp'), '#!/bin/sh\necho fixture-copy-failure >&2\nexit 73\n');
    const undo = spawnSync('sh', ['-c', '. "$1"; result=$?; case $- in *e*) exit 88 ;; esac; echo "parent-alive:$result"', 'sh', snippet], { cwd: f.home, env: sandboxChildEnv(f.home, { PATH: tools + path.delimiter + process.env.PATH }), encoding: 'utf8' });
    expect(undo.status).toBe(0); expect(undo.stdout).toContain('parent-alive:73'); expect(undo.stderr).toContain('fixture-copy-failure');
    expect(fs.readdirSync(path.dirname(f.executable)).filter(name => name.startsWith('.myco-restore-'))).toEqual([]);
    expect(fs.readFileSync(f.executable, 'utf8')).toBe('2.0 executable');
  });

  it.each(['release', 'malformed', 'mismatch'])('reports reinstall %s failure without changing the caller shell', (failure) => {
    const f = fixture();
    if (failure !== 'release') write(path.join(f.home, 'service/daemon.json'), JSON.stringify({ version: '1.4.8' }));
    const recipe = f.recipe(); const tools = path.join(f.home, 'tools');
    write(path.join(tools, 'curl'), `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  *matching-refs*) printf '[]' ;;
  */SHA256SUMS) printf '%s  myco-darwin-${process.arch}\n' '${failure === 'malformed' ? 'not-a-checksum' : '0'.repeat(64)}' > "$out" ;;
  */myco-darwin-*) printf 'offline original artifact' > "$out" ;;
  *) exit 97 ;;
esac
`);
    const snippet = path.join(f.home, 'reinstall.sh'); write(snippet, [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n'));
    const undo = spawnSync('sh', ['-c', '. "$1"; result=$?; case $- in *e*) exit 88 ;; esac; echo "parent-alive:$result"', 'sh', snippet], { cwd: f.home, env: sandboxChildEnv(f.home, { PATH: tools + path.delimiter + process.env.PATH }), encoding: 'utf8' });
    expect(undo.status).toBe(0); expect(undo.stdout).toContain('parent-alive:1');
    expect(undo.stderr).toContain(failure === 'release' ? 'No published Myco 1.4 release was found.' : failure === 'malformed' ? 'checksum is missing or malformed.' : 'checksum does not match.');
    expect(fs.readFileSync(f.executable, 'utf8')).toBe('2.0 executable');
  });

  it.skipIf(PWSH === '')('stops the Windows restore recipe on a failed executable copy', () => {
    const f = fixture('win32'); f.slot('1.4.8', 'saved 1.4 bytes');
    const recipe = f.recipe();
    const commands = [...recipe.matchAll(/```powershell\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const marker = path.join(f.home, 'start-step');
    const failing = `function Copy-Item {
      [CmdletBinding()] param($LiteralPath, $Destination, [switch]$Force)
      Write-Error 'fixture executable copy failure'
    }
`;
    const undo = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', failing + commands + `\nSet-Content -LiteralPath '${marker}' -Value started`], {
      cwd: f.home, env: sandboxChildEnv(f.home), encoding: 'utf8',
    });
    expect(undo.status).not.toBe(0); expect(undo.stderr).toContain('fixture executable copy failure');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(f.executable, 'utf8')).toBe('2.0 executable');
  });

  it.skipIf(PWSH === '').each([false, true])('applies the Windows recovery commands with offline downloads (saved copy %s)', (saved) => {
    const f = fixture('win32');
    const artifact = path.join(f.home, 'old.exe'); write(artifact, 'saved 1.4 executable');
    if (saved) f.slot('1.4.8', fs.readFileSync(artifact, 'utf8'));
    const recipe = f.recipe();
    const commands = [...recipe.matchAll(/```powershell\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const mock = `function Invoke-RestMethod {
      param($Uri)
      if ($Uri -like '*matching-refs*') { return @([PSCustomObject]@{ref='refs/tags/myco/v1.4.8'}) }
      return [PSCustomObject]@{draft=$false; prerelease=$false}
    }
    function Invoke-WebRequest {
      param($Uri, $OutFile)
      if ($Uri.EndsWith('SHA256SUMS')) { '${digest(artifact)}  myco-windows-x64.exe' | Set-Content -LiteralPath $OutFile }
      else { Copy-Item -LiteralPath '${artifact}' -Destination $OutFile }
    }
`;
    const undo = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', mock + commands], {
      cwd: f.home, env: sandboxChildEnv(f.home), encoding: 'utf8',
    });
    expect({ status: undo.status, stderr: undo.stderr }).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(f.executable)).toEqual(fs.readFileSync(artifact));
  });

  it.each(['darwin', 'linux', 'win32'] as const)('keeps a unique saved executable in the %s backup and places recovery before the start step', (platform) => {
    const f = fixture(platform); const slot = f.slot('1.4.8', 'exact saved bytes');
    const recipe = f.recipe();
    expect(recipe).toContain('replaces Myco 2.0 at ' + f.executable);
    const entry = f.backup.all.find(entry => 'recovery' in entry);
    expect(entry && 'recovery' in entry && entry.recovery.kind).toBe('saved');
    if (!entry || !('recovery' in entry) || entry.recovery.kind !== 'saved') throw new Error('Missing saved executable');
    expect(fs.readFileSync(entry.recovery.source, 'utf8')).toBe('exact saved bytes');
    fs.unlinkSync(slot);
    expect(recipe).toContain(entry.recovery.source);
    expect(recipe).toContain(platform === 'win32' ? 'Copy-Item -LiteralPath' : 'mv -f "$restore_binary"');
    expect(recipe).toContain(platform === 'linux' ? 'sha256sum' : platform === 'win32' ? 'Get-FileHash' : 'shasum -a 256');
  });
});
