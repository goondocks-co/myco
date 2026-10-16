import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CutoverBackup } from '@myco/member/cutover-backup.js';
import { identifyLegacyExecutable, LEGACY_EXECUTABLE_RECORD } from '@myco/cli/cutover-executable.js';
import type { MycoUnit } from '@myco/member/legacy-unit-files.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { env: process.env, encoding: 'utf8' }).stdout.trim();
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }); };
function fixture(platform: NodeJS.Platform = 'darwin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-backup-')); made.push(home);
  const executable = path.join(home, 'bin', platform === 'win32' ? 'myco.exe' : 'myco');
  write(executable, '2.0 executable');
  const unit: MycoUnit = { executable, home, file: path.join(home, 'co.goondocks.myco.service'), args: ['daemon'], label: 'co.goondocks.myco', scope: 'user' };
  write(unit.file, executable + ' daemon');
  const slot = (version: string, bytes = version) => { const file = path.join(home, 'bin', 'versions', version, path.basename(executable)); write(file, bytes); return file; };
  const backup = new CutoverBackup(path.join(home, 'backup'), 'cutover', platform);
  const recipe = () => { backup.takeLegacyUnit(unit, identifyLegacyExecutable(unit)); backup.pruneUnchanged(); return fs.readFileSync(path.join(backup.dir, 'restore.md'), 'utf8'); };
  return { home, executable, unit, slot, backup, recipe };
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

  it('rejects a changed preserved copy and uses the daemon-version slot ahead of ambiguous slots', () => {
    const f = fixture(); const good = f.slot('1.4.8'); f.slot('1.4.9');
    const bad = path.join(f.home, 'bin', 'legacy', 'old', 'myco'); write(bad, 'changed');
    write(path.join(f.home, LEGACY_EXECUTABLE_RECORD), JSON.stringify({ path: bad, sha256: '0'.repeat(64), version: '1.4.9', replaced_at: f.executable }));
    write(path.join(f.home, 'service', 'daemon.json'), JSON.stringify({ version: '1.4.8' }));
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
    const tools = path.join(f.home, 'tools'); fs.mkdirSync(tools);
    const artifact = path.join(f.home, 'old'); write(artifact, '#!/bin/sh\necho 1.4.8\n');
    const asset = 'myco-darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
    const sums = path.join(f.home, 'sums'); write(sums, digest(artifact) + '  ' + asset + '\n');
    const curl = `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; --proto) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  *matching-refs*) printf '%s' '[{"ref":"refs/tags/myco/v1.4.9"},{"ref":"refs/tags/myco/v1.4.8"}]' ;;
  *releases/tags/*1.4.9) printf '%s' '{"prerelease":false,"draft":true}' > "$out"; printf 200 ;;
  *releases/tags/*1.4.8) printf '%s' '{"prerelease":false,"draft":false}' > "$out"; printf 200 ;;
  *myco%2Fv1.4.8/SHA256SUMS) cp '${sums}' "$out" ;;
  *myco%2Fv1.4.8/myco-darwin-*) cp '${artifact}' "$out" ;;
  *) exit 97 ;;
esac
`;
    write(path.join(tools, 'curl'), curl);
    const commands = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const undo = spawnSync('sh', ['-c', commands], { cwd: f.home, env: sandboxChildEnv(f.home, { PATH: tools + path.delimiter + process.env.PATH }), encoding: 'utf8' });
    expect({ status: undo.status, stderr: undo.stderr }).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(f.executable)).toEqual(fs.readFileSync(artifact));
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

  it('uses exactly one 1.x versioned slot ahead of an unclassified preserved copy', () => {
    const f = fixture(); const slot = f.slot('1.4.8', 'identified 1.x version');
    const bytes = 'unclassified saved bytes'; const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    write(path.join(f.home, 'bin', 'legacy', hash, 'myco'), bytes);
    expect(identifyLegacyExecutable(f.unit)).toMatchObject({ kind: 'saved', source: slot, version: '1.4.8' });
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
